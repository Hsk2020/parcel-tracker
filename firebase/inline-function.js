/**
 * HSK Parcel Tracker - live status endpoint (paste-in version, NO dependencies)
 * ===========================================================================
 * Use this if you don't have a computer/terminal. It runs directly in the
 * Google Cloud Console browser editor.
 *
 * STEPS (browser only, ~5 minutes):
 *  1. Open  https://console.cloud.google.com/functions
 *     Make sure the project selector (top bar) says  hsk-tracker-1a2b3
 *  2. Click  Create function
 *  3. Fill in:
 *       Environment : 2nd gen
 *       Function name: track
 *       Region      : asia-south1
 *       Trigger     : HTTPS
 *       Authentication: Allow unauthenticated  (it's a public tracking lookup)
 *  4. Runtime: Node.js 20
 *  5. In "Runtime environment variables" add:
 *       Name : TRACKINGMORE_API_KEY
 *       Value: <your TrackingMore key>
 *  6. Delete whatever is in the code editor, paste THIS WHOLE FILE
 *  7. Entry point: track
 *  8. Click Deploy (takes 2-3 minutes)
 *  9. Copy the URL it shows and send it to me - it looks like
 *       https://track-xxxxxxxx-as.a.run.app
 *     or  https://asia-south1-hsk-tracker-1a2b3.cloudfunctions.net/track
 *
 * The URL is NOT always the same, so send me the one it gives you and I'll
 * put it in CONFIG.liveApi.
 */

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

exports.track = async (req, res) => {
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

  // 1) Courier code: explicit when supplied, else auto-detect.
  const ccParam = String((req.query && req.query.courier_code) || "").trim().toLowerCase();
  let courierCode = ccParam;
  if (!courierCode) {
    try {
      const dr = await fetch(`${BASE}/couriers/detect`, {
        method: "POST", headers, body: JSON.stringify({ tracking_number: tn }),
      });
      const dd = (await dr.json()).data;
      courierCode = (Array.isArray(dd) ? (dd[0] || {}).courier_code : (dd || {}).courier_code) || "";
    } catch (_) {}
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
  } catch (_) {}

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
};
