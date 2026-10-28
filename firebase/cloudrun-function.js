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
 *   Variables & Secrets  : TRACKINGMORE_API_KEY = <your key>
 *
 * Then "Save and redeploy".
 */

import { http } from '@google-cloud/functions-framework';

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

http('track', async (req, res) => {
  // CORS so the browser app can call this
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

  const key = process.env.TRACKINGMORE_API_KEY;
  if (!key) {
    res.status(500).json({ error: "server not configured (missing TRACKINGMORE_API_KEY)" });
    return;
  }
  const headers = { "Tracking-Api-Key": key, "Content-Type": "application/json" };

  // 1) Courier code: use the explicit one when supplied (the app knows the
  //    courier), otherwise fall back to TrackingMore's auto-detection. Without
  //    this, an ambiguous number can match the wrong carrier entirely - a
  //    15-digit XpressBees AWB was being detected as BRT Bartolini.
  const ccParam = String((req.query && req.query.courier_code) || "").trim().toLowerCase();
  let courierCode = ccParam;
  if (!courierCode) {
    try {
      const dr = await fetch(`${BASE}/couriers/detect`, {
        method: "POST", headers, body: JSON.stringify({ tracking_number: tn }),
      });
      const dd = (await dr.json()).data;
      courierCode = (Array.isArray(dd) ? (dd[0] || {}).courier_code : (dd || {}).courier_code) || "";
    } catch (_) { /* ignore */ }
  }

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

  // 2) Fallback: stored results
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

  // 3) v4 scan events live under origin_info / destination_info -> trackinfo
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
});
