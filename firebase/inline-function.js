/**
 * HSK Parcel Tracker - live status function (ES module version)
 * ============================================================
 * Matches the Cloud Run / Google Cloud "Write a function" template, which uses
 * ES modules and registers the handler with http(). Paste this whole file over
 * index.js in the Source tab.
 *
 * Settings on that page:
 *   Function entry point : track
 *   Runtime              : Node.js 22   (Node.js 20 is decommissioned 30 Oct 2026)
 *   Variables & Secrets  : AFTERSHIP_API_KEY  = <your key>   (preferred)
 *                          TRACKINGMORE_API_KEY = <your key> (fallback, optional)
 *
 * AfterShip is tried first because it carries XpressBees and Amazon Logistics
 * data that TrackingMore does not. TrackingMore is still used when AfterShip
 * returns nothing, so the two cover each other.
 */

import { http } from '@google-cloud/functions-framework';

const TM_BASE = "https://api.trackingmore.com/v4";
const AS_BASE = "https://api.aftership.com/tracking/2024-04";

const TM_STATUS = {
  pending: "Pending", inforeceived: "Info Received", transit: "In Transit",
  pickup: "Out for Delivery", delivered: "Delivered", undelivered: "Delivery Failed",
  exception: "Exception", expired: "Expired", notfound: "Not Found",
};

// AfterShip uses its own tag vocabulary.
const AS_STATUS = {
  pending: "Pending",
  inforeceived: "Info Received",
  intransit: "In Transit",
  outfordelivery: "Out for Delivery",
  attemptfail: "Delivery Failed",
  delivered: "Delivered",
  availableforpickup: "Available for Pickup",
  exception: "Exception",
  expired: "Expired",
};

function pretty(s) {
  const raw = String(s || "");
  return raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ------------------------------------------------------------------ *
 * AfterShip                                                          *
 * ------------------------------------------------------------------ */

async function aftershipGet(url, key) {
  const r = await fetch(url, {
    headers: { "as-api-key": key, "Content-Type": "application/json" },
  });
  try { return await r.json(); } catch (_) { return null; }
}

function aftershipNormalise(t, tn, slug) {
  if (!t) return null;
  const cps = (t.checkpoints || []).slice().sort(
    (a, b) => String(a.checkpoint_time || "").localeCompare(String(b.checkpoint_time || ""))
  );
  const last = cps[cps.length - 1] || {};
  return {
    status: AS_STATUS[String(t.tag || "").toLowerCase()] || pretty(t.tag || "Pending"),
    courier: t.slug || slug || "",
    delivered: String(t.tag || "").toLowerCase() === "delivered",
    last_location: last.location || last.city || "",
    last_update: last.checkpoint_time || t.updated_at || "",
    track_url: t.courier_redirect_link || t.courier_tracking_link ||
      "https://www.aftership.com/track/" + encodeURIComponent(tn),
    events: cps.map((c) => ({
      date: c.checkpoint_time || "",
      activity: c.message || pretty(c.tag || ""),
      location: c.location || c.city || "",
    })),
  };
}

async function aftershipLookup(tn, slug, key) {
  // 1) Read first - no side effects, and returns full history when it exists.
  const qs = new URLSearchParams({ tracking_numbers: tn, limit: "1" });
  if (slug) qs.set("slug", slug);
  const found = await aftershipGet(`${AS_BASE}/trackings?${qs.toString()}`, key);
  const list = found && found.data && found.data.trackings;
  if (Array.isArray(list) && list.length) {
    const norm = aftershipNormalise(list[0], tn, slug);
    if (norm && norm.events.length) return norm;
  }

  // 2) Not tracked yet - register it, then read back by id.
  const body = { tracking: { tracking_number: tn } };
  if (slug) body.tracking.slug = slug;
  let created = null;
  try {
    const r = await fetch(`${AS_BASE}/trackings`, {
      method: "POST",
      headers: { "as-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    created = j && j.data && j.data.tracking;
  } catch (_) { /* ignore */ }

  if (created && created.id) {
    const one = await aftershipGet(`${AS_BASE}/trackings/${created.id}`, key);
    const t = (one && one.data && one.data.tracking) || created;
    return aftershipNormalise(t, tn, slug);
  }
  if (created) return aftershipNormalise(created, tn, slug);
  return null;
}

/* ------------------------------------------------------------------ *
 * TrackingMore (fallback)                                            *
 * ------------------------------------------------------------------ */

function tmFirstItem(j) {
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

async function trackingmoreLookup(tn, courierCode, key) {
  const headers = { "Tracking-Api-Key": key, "Content-Type": "application/json" };

  let item = null;
  try {
    const cr = await fetch(`${TM_BASE}/trackings/create`, {
      method: "POST", headers,
      body: JSON.stringify(courierCode
        ? { tracking_number: tn, courier_code: courierCode }
        : { tracking_number: tn }),
    });
    item = tmFirstItem(await cr.json());
  } catch (_) { /* ignore */ }

  if (!item || !(item.status || item.delivery_status)) {
    try {
      const r = await fetch(
        `${TM_BASE}/trackings/get?tracking_numbers=${encodeURIComponent(tn)}`,
        { headers }
      );
      item = tmFirstItem(await r.json()) || item;
    } catch (_) { /* ignore */ }
  }
  if (!item) return null;

  const events = [];
  for (const k of ["origin_info", "destination_info"]) {
    const info = item[k] || {};
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
  return {
    status: TM_STATUS[raw.toLowerCase()] || pretty(raw),
    courier: item.courier_code || courierCode || "",
    delivered: raw.toLowerCase() === "delivered",
    last_location: (events[events.length - 1] || {}).location || "",
    last_update: (events[events.length - 1] || {}).date || item.last_update_time || "",
    track_url: "https://www.trackingmore.com/track/" + encodeURIComponent(tn),
    events,
  };
}

/* ------------------------------------------------------------------ *
 * Handler                                                            *
 * ------------------------------------------------------------------ */

http('track', async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  const tn = String((req.query && req.query.tracking_number) || "").trim().toUpperCase();
  if (!tn) {
    res.status(400).json({ error: "missing tracking_number" });
    return;
  }

  // Courier slug/code supplied by the app. Without it an ambiguous number can
  // match the wrong carrier entirely (a 15-digit XpressBees AWB was being
  // detected as BRT Bartolini).
  const slug = String((req.query && req.query.courier_code) || "").trim().toLowerCase();

  const asKey = process.env.AFTERSHIP_API_KEY;
  const tmKey = process.env.TRACKINGMORE_API_KEY;
  if (!asKey && !tmKey) {
    res.status(500).json({
      error: "server not configured (set AFTERSHIP_API_KEY and/or TRACKINGMORE_API_KEY)",
    });
    return;
  }

  let out = null;
  let source = "";

  if (asKey) {
    try {
      out = await aftershipLookup(tn, slug, asKey);
      if (out) source = "aftership";
    } catch (_) { /* fall through */ }
  }

  // Use TrackingMore when AfterShip has nothing, or nothing beyond "Pending".
  const asHasEvents = out && Array.isArray(out.events) && out.events.length > 0;
  if (!asHasEvents && tmKey) {
    try {
      const tm = await trackingmoreLookup(tn, slug, tmKey);
      if (tm && (!out || (tm.events || []).length > (out.events || []).length)) {
        out = tm;
        source = "trackingmore";
      }
    } catch (_) { /* ignore */ }
  }

  if (!out) {
    res.status(404).json({ error: "no tracking data for this number" });
    return;
  }

  res.json({ ...out, source });
});
