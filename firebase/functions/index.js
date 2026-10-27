/**
 * HSK Parcel Tracker - live status endpoint (Firebase Functions v2)
 * ================================================================
 * The Firebase equivalent of worker/live-track-worker.js. Holds your
 * TrackingMore API key server-side and returns clean JSON the app understands.
 *
 * NOTE: Firebase Functions needs the Blaze (pay-as-you-go) plan for outbound
 * network calls. The free Spark plan blocks them. There is a free monthly
 * allowance inside Blaze, but a billing account must be attached.
 *
 * Deploy (from the firebase/ folder):
 *   npm install -g firebase-tools
 *   firebase login
 *   firebase use --add              # pick your Firebase project
 *   cd functions && npm install
 *   firebase functions:secrets:set TRACKINGMORE_API_KEY   # paste your key
 *   cd .. && firebase deploy --only functions
 *
 * Then copy the printed URL into CONFIG.liveApi in index.html:
 *   https://<region>-<project>.cloudfunctions.net/track
 */
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const TM_KEY = defineSecret("TRACKINGMORE_API_KEY");
const BASE = "https://api.trackingmore.com/v4";

const STATUS = {
  pending: "Pending", inforeceived: "Info Received", transit: "In Transit",
  pickup: "Out for Delivery", delivered: "Delivered", undelivered: "Delivery Failed",
  exception: "Exception", expired: "Expired", notfound: "Not Found",
};

function firstItem(j) {
  const d = j && j.data;
  if (Array.isArray(d)) return d[0] || null;
  if (d && typeof d === "object") {
    for (const k of ["trackings", "items", "results"]) {
      if (Array.isArray(d[k]) && d[k].length) return d[k][0];
    }
    if (d.tracking_number) return d;
  }
  return null;
}

exports.track = onRequest(
  { secrets: [TM_KEY], cors: true, region: "asia-south1", timeoutSeconds: 30 },
  async (req, res) => {
    const tn = String(req.query.tracking_number || "").trim().toUpperCase();
    if (!tn) {
      res.status(400).json({ error: "missing tracking_number" });
      return;
    }

    const headers = { "Tracking-Api-Key": TM_KEY.value(), "Content-Type": "application/json" };

    // 1) Best-effort courier detection, then create (create-and-get in v4).
    let courierCode = "";
    try {
      const dr = await fetch(`${BASE}/couriers/detect`, {
        method: "POST", headers, body: JSON.stringify({ tracking_number: tn }),
      });
      const dd = (await dr.json()).data;
      courierCode = (Array.isArray(dd) ? (dd[0] || {}).courier_code : (dd || {}).courier_code) || "";
    } catch (_) { /* ignore */ }

    let item = null;
    try {
      const cr = await fetch(`${BASE}/trackings/create`, {
        method: "POST", headers,
        body: JSON.stringify(courierCode
          ? { tracking_number: tn, courier_code: courierCode }
          : { tracking_number: tn }),
      });
      item = firstItem(await cr.json());
    } catch (_) { /* ignore */ }

    // 2) Fallback: stored results.
    if (!item || !(item.status || item.delivery_status)) {
      try {
        const r = await fetch(
          `${BASE}/trackings/get?tracking_numbers=${encodeURIComponent(tn)}`,
          { headers }
        );
        item = firstItem(await r.json()) || item;
      } catch (e) {
        res.status(502).json({ error: "upstream request failed: " + String(e) });
        return;
      }
    }
    if (!item) {
      res.status(404).json({ error: "no tracking data for this number" });
      return;
    }

    // 3) v4 events live under origin_info / destination_info -> trackinfo.
    const events = [];
    for (const key of ["origin_info", "destination_info"]) {
      const info = item[key] || {};
      for (const e of (info.trackinfo || [])) {
        events.push({
          date: e.checkpoint_date || e.Date || "",
          activity: e.details || e.StatusDescription || e.checkpoint_status || "",
          location: e.location || e.Details || "",
        });
      }
    }
    for (const e of (item.tracking_events || [])) {
      events.push({
        date: e.checkpoint_date || "",
        activity: e.tracking_detail || e.checkpoint_delivery_status || "",
        location: e.location || "",
      });
    }
    events.sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const raw = String(item.status || item.delivery_status || "");
    res.json({
      status: STATUS[raw.toLowerCase()] ||
        raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      courier: item.courier_code || courierCode || "",
      delivered: raw.toLowerCase() === "delivered",
      last_location: (events[events.length - 1] || {}).location || "",
      last_update: (events[events.length - 1] || {}).date || item.last_update_time || "",
      track_url: "https://www.trackingmore.com/track/" + encodeURIComponent(tn),
      events,
    });
  }
);
