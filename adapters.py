"""
Courier tracking adapters for the parcel tracker.

Each adapter talks to one courier or aggregator API and returns a normalised
``TrackingResult`` so the rest of the tool does not care which provider
answered.

Credentials are NEVER hardcoded here. They arrive through the config dict
built by ``track_parcels.py`` from a config file and/or environment variables
(see README.md).

Adapters included
-----------------
delhivery     Direct Delhivery API      -> needs a merchant API token
shiprocket    Shiprocket API (covers   -> needs email + password
              DTDC, Blue Dart, Delhivery,
              Ekart, XpressBees, ...)
ship24        Ship24 aggregator        -> needs an API key
trackingmore  TrackingMore aggregator  -> needs an API key
manual        No API. Returns the      -> needs nothing
              official tracking URL.

Delhivery and Shiprocket endpoints follow their published docs. The two
aggregator adapters parse defensively and should be checked against the
provider's current docs before heavy use.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

import requests

REQUEST_TIMEOUT = 25  # seconds


# --------------------------------------------------------------------------- #
# Normalised result
# --------------------------------------------------------------------------- #
@dataclass
class TrackingResult:
    tracking_number: str
    courier: str = ""
    status: str = ""
    status_detail: str = ""
    last_location: str = ""
    last_update: str = ""
    delivered: bool = False
    track_url: str = ""
    provider: str = ""
    error: str = ""
    events: list = field(default_factory=list)

    def to_row(self) -> dict:
        return {
            "tracking_number": self.tracking_number,
            "courier": self.courier,
            "status": self.status,
            "delivered": "YES" if self.delivered else "",
            "last_location": self.last_location,
            "last_update": self.last_update,
            "status_detail": self.status_detail,
            "track_url": self.track_url,
            "provider": self.provider,
            "error": self.error,
        }


_DELIVERED_HINTS = ("delivered", "delivery confirmed", "proof of delivery")
_NOT_DELIVERED = ("out for delivery", "undelivered", "not delivered",
                  "attempted", "rto", "return to")


def looks_delivered(status: str) -> bool:
    """Best-effort delivered flag from a free-text status string."""
    s = (status or "").lower()
    if not s:
        return False
    if any(neg in s for neg in _NOT_DELIVERED):
        return False
    return any(h in s for h in _DELIVERED_HINTS)


# --------------------------------------------------------------------------- #
# Base adapter
# --------------------------------------------------------------------------- #
class CourierAdapter:
    name = "base"
    requires: tuple[str, ...] = ()

    def __init__(self, config: dict, session: requests.Session | None = None):
        self.config = config or {}
        self.session = session or requests.Session()
        missing = [k for k in self.requires if not self.config.get(k)]
        if missing:
            raise ValueError(
                f"{self.name} adapter is missing credential(s): "
                f"{', '.join(missing)}. Set them in config.json or as env vars."
            )

    def track(self, tracking_number: str) -> TrackingResult:
        raise NotImplementedError

    def track_many(self, tracking_numbers: Iterable[str]) -> dict[str, TrackingResult]:
        out: dict[str, TrackingResult] = {}
        for tn in tracking_numbers:
            try:
                out[tn] = self.track(tn)
            except Exception as exc:  # one bad parcel must not kill the run
                out[tn] = TrackingResult(tracking_number=tn, provider=self.name, error=str(exc))
        return out


# --------------------------------------------------------------------------- #
# Delhivery  (direct)
# --------------------------------------------------------------------------- #
class DelhiveryAdapter(CourierAdapter):
    name = "delhivery"
    requires = ("token",)
    BASE = {
        "production": "https://track.delhivery.com",
        "staging": "https://staging-express.delhivery.com",
    }

    def track(self, tracking_number: str) -> TrackingResult:
        env = self.config.get("env", "production")
        base = self.BASE.get(env, self.BASE["production"])
        url = f"{base}/api/v1/packages/json/"
        headers = {
            "Authorization": f"Token {self.config['token']}",
            "Accept": "application/json",
        }
        params = {"waybill": tracking_number}
        if self.config.get("client_name"):
            params["cl"] = self.config["client_name"]
        r = self.session.get(url, headers=headers, params=params, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return self._parse(tracking_number, r.json())

    def _parse(self, tn: str, data: dict) -> TrackingResult:
        res = TrackingResult(tracking_number=tn, provider=self.name, courier="Delhivery")
        shipments = (data or {}).get("ShipmentData") or []
        if not shipments:
            res.error = (data or {}).get("Error") or "No shipment data returned"
            return res
        ship = shipments[0].get("Shipment", {}) or {}
        status = ship.get("Status", {}) or {}
        res.status = status.get("Status", "")
        res.status_detail = status.get("Instructions", "")
        res.last_location = status.get("StatusLocation", "")
        res.last_update = status.get("StatusDateTime", "")
        res.delivered = looks_delivered(res.status)
        for sc in ship.get("Scans") or []:
            d = sc.get("ScanDetail", {}) or {}
            res.events.append({
                "date": d.get("ScanDateTime", ""),
                "activity": d.get("Scan", ""),
                "location": d.get("ScannedLocation", ""),
            })
        res.track_url = f"https://www.delhivery.com/track/package/{tn}"
        return res


# --------------------------------------------------------------------------- #
# Shiprocket  (aggregator: one API for many couriers)
# --------------------------------------------------------------------------- #
class ShiprocketAdapter(CourierAdapter):
    name = "shiprocket"
    requires = ("email", "password")
    BASE = "https://apiv2.shiprocket.in/v1/external"

    def __init__(self, config: dict, session: requests.Session | None = None):
        super().__init__(config, session)
        self._token: str | None = None

    def _auth(self) -> str:
        if self._token:
            return self._token
        r = self.session.post(
            f"{self.BASE}/auth/login",
            json={"email": self.config["email"], "password": self.config["password"]},
            timeout=REQUEST_TIMEOUT,
        )
        r.raise_for_status()
        self._token = (r.json() or {}).get("token")
        if not self._token:
            raise RuntimeError("Shiprocket auth failed: no token in response")
        return self._token

    def track(self, tracking_number: str) -> TrackingResult:
        token = self._auth()
        r = self.session.get(
            f"{self.BASE}/courier/track/awb/{tracking_number}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=REQUEST_TIMEOUT,
        )
        r.raise_for_status()
        return self._parse(tracking_number, r.json())

    def track_many(self, tracking_numbers: Iterable[str]) -> dict[str, TrackingResult]:
        tns = list(tracking_numbers)
        out: dict[str, TrackingResult] = {}
        token = self._auth()
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        for i in range(0, len(tns), 50):  # Shiprocket batch cap: 50 AWBs
            chunk = tns[i:i + 50]
            try:
                r = self.session.post(
                    f"{self.BASE}/courier/track/awbs",
                    headers=headers, json={"awbs": chunk}, timeout=REQUEST_TIMEOUT,
                )
                r.raise_for_status()
                data = r.json() or {}
                for tn in chunk:
                    entry = data.get(tn)
                    out[tn] = (self._parse(tn, entry) if entry
                               else TrackingResult(tracking_number=tn, provider=self.name,
                                                   error="No data returned for this AWB"))
            except Exception as exc:
                for tn in chunk:
                    out.setdefault(tn, TrackingResult(tracking_number=tn,
                                                      provider=self.name, error=str(exc)))
        return out

    def _parse(self, tn: str, payload: dict) -> TrackingResult:
        res = TrackingResult(tracking_number=tn, provider=self.name)
        td = (payload or {}).get("tracking_data") or {}
        if td.get("error"):
            res.error = td["error"]
        track = (td.get("shipment_track") or [{}])[0] or {}
        res.courier = track.get("courier_name") or "Shiprocket"
        res.status = track.get("current_status", "")
        res.last_location = track.get("destination", "")
        res.delivered = looks_delivered(res.status) or str(td.get("shipment_status")) == "7"
        acts = td.get("shipment_track_activities") or []
        if acts:
            res.last_update = acts[0].get("date", "")
            res.last_location = acts[0].get("location") or res.last_location
        res.events = [{"date": a.get("date", ""), "activity": a.get("activity", ""),
                       "location": a.get("location", "")} for a in acts]
        res.track_url = td.get("track_url") or f"https://shiprocket.co/tracking/{tn}"
        return res


# --------------------------------------------------------------------------- #
# Ship24  (aggregator, best-effort parse)
# --------------------------------------------------------------------------- #
class Ship24Adapter(CourierAdapter):
    name = "ship24"
    requires = ("api_key",)
    BASE = "https://api.ship24.com/public/v1"

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.config['api_key']}",
                "Content-Type": "application/json"}

    def track(self, tracking_number: str) -> TrackingResult:
        h = self._headers()
        r = self.session.post(f"{self.BASE}/trackers", headers=h,
                              json={"trackingNumber": tracking_number}, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        data = (r.json() or {}).get("data", {}) or {}
        tracker_id = (data.get("tracker") or {}).get("trackerId")
        if not tracker_id:
            return TrackingResult(tracking_number=tracking_number, provider=self.name,
                                  error="Ship24 did not return a tracker id")
        r2 = self.session.get(f"{self.BASE}/trackers/{tracker_id}/results",
                              headers=h, timeout=REQUEST_TIMEOUT)
        r2.raise_for_status()
        return self._parse(tracking_number, (r2.json() or {}).get("data", {}) or {})

    def _parse(self, tn: str, data: dict) -> TrackingResult:
        res = TrackingResult(tracking_number=tn, provider=self.name)
        trackings = data.get("trackings") or []
        if not trackings:
            res.error = "No tracking results yet"
            return res
        t0 = trackings[0] or {}
        shipment = t0.get("shipment") or {}
        milestone = shipment.get("statusMilestone", "") or ""
        res.status = milestone.replace("_", " ").title()
        res.courier = ((t0.get("tracker") or {}).get("courierCode")
                       or shipment.get("courierCode", ""))
        events = t0.get("events") or []
        if events:
            last = events[-1] or {}
            res.last_update = last.get("occurrenceDatetime", "")
            res.last_location = ((last.get("location") or "") if isinstance(last.get("location"), str)
                                 else (last.get("location") or {}).get("address", ""))
        res.events = [{"date": e.get("occurrenceDatetime", ""),
                       "activity": e.get("status", "") or e.get("statusMilestone", ""),
                       "location": (e.get("location") if isinstance(e.get("location"), str)
                                    else (e.get("location") or {}).get("address", ""))}
                      for e in events]
        res.delivered = looks_delivered(res.status) or milestone.lower() == "delivered"
        res.track_url = f"https://ship24.com/track/{tn}"
        return res


# --------------------------------------------------------------------------- #
# TrackingMore  (aggregator - API v4)
# --------------------------------------------------------------------------- #
class TrackingMoreAdapter(CourierAdapter):
    name = "trackingmore"
    requires = ("api_key",)
    BASE = "https://api.trackingmore.com/v4"

    STATUS_MAP = {
        "pending": "Pending", "inforeceived": "Info Received", "transit": "In Transit",
        "pickup": "Out for Delivery", "delivered": "Delivered",
        "undelivered": "Delivery Failed", "exception": "Exception",
        "expired": "Expired", "notfound": "Not Found",
    }

    def _headers(self) -> dict:
        # v4 uses the header Tracking-Api-Key (the old v2 header was Trackingmore-Api-Key).
        return {"Tracking-Api-Key": self.config["api_key"],
                "Content-Type": "application/json"}

    def _detect_courier(self, tracking_number: str, h: dict) -> str:
        try:
            r = self.session.post(f"{self.BASE}/couriers/detect", headers=h,
                                  json={"tracking_number": tracking_number},
                                  timeout=REQUEST_TIMEOUT)
            data = (r.json() or {}).get("data")
            if isinstance(data, list) and data:
                return data[0].get("courier_code", "") or ""
            if isinstance(data, dict):
                return data.get("courier_code", "") or ""
        except Exception:
            pass
        return ""

    @staticmethod
    def _first(j: dict):
        data = (j or {}).get("data")
        if isinstance(data, list):
            return data[0] if data else None
        if isinstance(data, dict):
            for k in ("trackings", "items", "results"):
                v = data.get(k)
                if isinstance(v, list) and v:
                    return v[0]
            if data.get("tracking_number"):
                return data
        return None

    def track(self, tracking_number: str) -> TrackingResult:
        h = self._headers()
        body = {"tracking_number": tracking_number}
        cc = self.config.get("courier_code") or self._detect_courier(tracking_number, h)
        if cc:
            body["courier_code"] = cc

        # In v4, "create a tracking" is create-and-get (real-time results).
        try:
            r = self.session.post(f"{self.BASE}/trackings/create", headers=h,
                                  json=body, timeout=REQUEST_TIMEOUT)
            item = self._first(r.json() or {})
            if item and (item.get("status") or item.get("delivery_status")):
                return self._parse(tracking_number, item)
        except Exception:
            pass

        # Fallback: fetch stored results.
        r = self.session.get(f"{self.BASE}/trackings/get", headers=h,
                             params={"tracking_numbers": tracking_number},
                             timeout=REQUEST_TIMEOUT)
        j = r.json() or {}
        item = self._first(j)
        if item:
            return self._parse(tracking_number, item)
        return TrackingResult(tracking_number=tracking_number, provider=self.name,
                              error=(j.get("message") or "No tracking data returned"))

    def _parse(self, tn: str, item: dict) -> TrackingResult:
        res = TrackingResult(tracking_number=tn, provider=self.name)
        res.courier = item.get("courier_code", "") or ""
        raw = (item.get("status") or item.get("delivery_status") or "").strip()
        res.status = self.STATUS_MAP.get(raw.lower(), raw.replace("_", " ").title())
        res.status_detail = item.get("last_event") or item.get("latest_status") or ""
        res.delivered = raw.lower() == "delivered" or looks_delivered(res.status)

        # v4 puts events under origin_info / destination_info -> trackinfo
        events = []
        for key in ("origin_info", "destination_info"):
            info = item.get(key) or {}
            for e in info.get("trackinfo") or []:
                events.append({
                    "date": e.get("checkpoint_date") or e.get("Date", ""),
                    "activity": (e.get("details") or e.get("StatusDescription")
                                 or e.get("checkpoint_status", "")),
                    "location": e.get("location") or e.get("Details", ""),
                })
        # v3-style fallback
        for e in item.get("tracking_events") or []:
            events.append({
                "date": e.get("checkpoint_date", ""),
                "activity": e.get("tracking_detail") or e.get("checkpoint_delivery_status", ""),
                "location": e.get("location", ""),
            })
        seen, uniq = set(), []
        for e in events:
            k = (e["date"], e["activity"], e["location"])
            if k in seen:
                continue
            seen.add(k)
            uniq.append(e)
        uniq.sort(key=lambda x: x["date"] or "")
        res.events = uniq
        if uniq:
            res.last_update = uniq[-1]["date"]
            res.last_location = uniq[-1]["location"]
        else:
            res.last_update = item.get("last_update_time", "") or ""
        res.track_url = f"https://www.trackingmore.com/track/{tn}"
        return res


# --------------------------------------------------------------------------- #
# Shadowfax  (direct courier, India - public staging + production)
# --------------------------------------------------------------------------- #
class ShadowfaxAdapter(CourierAdapter):
    name = "shadowfax"
    requires = ("token",)
    BASE = {
        "staging": "https://dale.staging.shadowfax.in/api",
        "production": "https://dale.shadowfax.in/api",
    }

    def _base(self) -> str:
        return self.BASE.get(self.config.get("env", "staging"), self.BASE["staging"])

    def _headers(self) -> dict:
        return {"Authorization": f"Token {self.config['token']}", "Accept": "application/json"}

    def track(self, tracking_number: str) -> TrackingResult:
        url = f"{self._base()}/v4/clients/orders/{tracking_number}/track/"
        r = self.session.get(url, headers=self._headers(), timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return self._parse(tracking_number, r.json())

    def track_many(self, tracking_numbers: Iterable[str]) -> dict[str, TrackingResult]:
        tns = list(tracking_numbers)
        out: dict[str, TrackingResult] = {}
        headers = dict(self._headers())
        headers["Content-Type"] = "application/json"
        for i in range(0, len(tns), 50):  # Shadowfax bulk cap: 50 AWBs per call
            chunk = tns[i:i + 50]
            try:
                r = self.session.post(f"{self._base()}/v4/clients/bulk_track/",
                                      headers=headers, json={"awb_numbers": chunk},
                                      timeout=REQUEST_TIMEOUT)
                r.raise_for_status()
                data = r.json()
                items = data if isinstance(data, list) else (data.get("data") or data.get("orders") or [])
                found = {}
                for it in items:
                    if not isinstance(it, dict):
                        continue
                    awb = (it.get("order_details") or {}).get("awb_number") or it.get("awb_number")
                    if awb:
                        found[awb] = it
                for tn in chunk:
                    out[tn] = (self._parse(tn, found[tn]) if tn in found
                               else TrackingResult(tracking_number=tn, provider=self.name,
                                                   error="No data returned"))
            except Exception as exc:
                for tn in chunk:
                    out.setdefault(tn, TrackingResult(tracking_number=tn,
                                                      provider=self.name, error=str(exc)))
        return out

    def _parse(self, tn: str, data: dict) -> TrackingResult:
        res = TrackingResult(tracking_number=tn, provider=self.name, courier="Shadowfax")
        if not isinstance(data, dict):
            res.error = "unexpected response shape"
            return res
        # Error envelopes: V4 uses status/errorCode; older endpoints use responseCode.
        if data.get("status") == "FAILED" or data.get("errorCode") or data.get("message") == "Failure":
            res.error = (data.get("message") or data.get("errorCode")
                         or data.get("responseMsg") or "request failed")
            return res
        rc = data.get("responseCode")
        if rc is not None:
            try:
                if int(rc) >= 400:
                    res.error = data.get("responseMsg") or "request failed"
                    return res
            except (TypeError, ValueError):
                pass
        od = data.get("order_details") or {}
        res.status = od.get("status_display") or od.get("status") or ""
        res.status_detail = od.get("client_order_id", "")
        res.delivered = looks_delivered(res.status)
        for e in data.get("tracking_details") or []:
            res.events.append({
                "date": e.get("created", ""),
                "activity": e.get("status") or e.get("status_id", ""),
                "location": e.get("location", ""),
            })
        if res.events:
            res.last_update = res.events[-1]["date"]
            res.last_location = res.events[-1]["location"]
        return res


# --------------------------------------------------------------------------- #
# Manual / URL fallback  (no credentials, always works)
# --------------------------------------------------------------------------- #
COURIER_URLS = {
    "delhivery": "https://www.delhivery.com/track/package/{tn}",
    "bluedart": "https://www.bluedart.com/tracking",
    "dtdc": "https://www.dtdc.in/tracking/tracking_results.asp",
    "indiapost": "https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx",
    "speedpost": "https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx",
    "ekart": "https://ekartlogistics.com/track/{tn}",
    "xpressbees": "https://www.xpressbees.com/track?awb={tn}",
    "amazon": "https://www.amazon.in/progress-tracker",
}


class ManualAdapter(CourierAdapter):
    """No API. Emits the official tracking URL so a human can click through."""
    name = "manual"

    def track(self, tracking_number: str) -> TrackingResult:
        courier = (self.config.get("courier") or "").lower()
        url = COURIER_URLS.get(courier, "")
        if url and "{tn}" in url:
            url = url.format(tn=tracking_number)
        return TrackingResult(
            tracking_number=tracking_number,
            provider=self.name,
            courier=courier or "unknown",
            status="Manual - open track_url",
            track_url=url or "https://www.google.com/search?q=track+parcel+" + tracking_number,
        )


# --------------------------------------------------------------------------- #
# Demo adapter  (offline, deterministic fake data - for testing the tool)
# --------------------------------------------------------------------------- #
class DemoAdapter(CourierAdapter):
    name = "demo"
    _STATUSES = ["Manifested", "Picked Up", "In Transit", "Out for Delivery", "Delivered"]

    def track(self, tracking_number: str) -> TrackingResult:
        idx = sum(ord(c) for c in tracking_number) % len(self._STATUSES)
        status = self._STATUSES[idx]
        res = TrackingResult(tracking_number=tracking_number, provider="demo",
                             courier="Demo Courier", status=status,
                             last_location="Mumbai, MH" if idx else "New Delhi, DL",
                             last_update="2026-10-20 14:30:00",
                             delivered=looks_delivered(status),
                             track_url=f"https://example.com/track/{tracking_number}")
        res.events = [{"date": f"2026-10-{18 + i:02d} 09:00:00",
                       "activity": self._STATUSES[i],
                       "location": "Mumbai, MH"} for i in range(idx + 1)]
        return res


# --------------------------------------------------------------------------- #
# Registry
# --------------------------------------------------------------------------- #
ADAPTERS = {
    "delhivery": DelhiveryAdapter,
    "shiprocket": ShiprocketAdapter,
    "shadowfax": ShadowfaxAdapter,
    "ship24": Ship24Adapter,
    "trackingmore": TrackingMoreAdapter,
    "manual": ManualAdapter,
    "demo": DemoAdapter,
}


def get_adapter(name: str, config: dict, session: requests.Session | None = None) -> CourierAdapter:
    key = (name or "").lower().strip()
    if key not in ADAPTERS:
        raise ValueError(f"Unknown provider '{name}'. Choose from: {', '.join(sorted(ADAPTERS))}")
    return ADAPTERS[key](config, session=session)
