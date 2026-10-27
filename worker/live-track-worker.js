/**
 * HSK Parcel Tracker - live status worker (Cloudflare Workers)
 * ============================================================
 * Gives the PWA real live tracking for ANY number, without exposing your API
 * key to the browser. The app calls this worker; the worker calls the carrier
 * aggregator with the key kept in a Worker secret.
 *
 * Deploy (free):
 *   1. npm install -g wrangler && wrangler login
 *   2. wrangler init hsk-track      (or drop this file into a worker project)
 *   3. wrangler secret put TRACKINGMORE_API_KEY     # paste your key
 *   4. wrangler deploy
 *   5. Copy the worker URL into CONFIG.liveApi in index.html
 *
 * Uses TrackingMore v4 (1,600+ carriers, free tier). To use Ship24 instead,
 * see the alternate block near the bottom.
 *
 * Response shape returned to the app:
 *   { status, courier, delivered, last_location, last_update, track_url, events:[{date,activity,location}] }
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const tn = (url.searchParams.get("tracking_number") || "").trim().toUpperCase();
    if (!tn) return json({ error: "missing tracking_number" }, 400);

    const key = env.TRACKINGMORE_API_KEY;
    if (!key) return json({ error: "server not configured (missing API key)" }, 500);

    // v4 uses the header Tracking-Api-Key (the old v2 header was Trackingmore-Api-Key).
    const headers = { "Tracking-Api-Key": key, "Content-Type": "application/json" };

    // v4 can return data as an array or as { trackings: [...] } - handle both.
    const first = (j) => {
      const d = j && j.data;
      if (Array.isArray(d)) return d[0] || null;
      if (d && typeof d === "object") {
        for (const k of ["trackings", "items", "results"]) {
          if (Array.isArray(d[k]) && d[k].length) return d[k][0];
        }
        if (d.tracking_number) return d;
      }
      return null;
    };
    const STATUS = { pending: "Pending", inforeceived: "Info Received", transit: "In Transit",
      pickup: "Out for Delivery", delivered: "Delivered", undelivered: "Delivery Failed",
      exception: "Exception", expired: "Expired", notfound: "Not Found" };

    // 1) Detect the courier (best effort), then create (create-and-get in v4).
    let courierCode = "";
    try {
      const dr = await fetch("https://api.trackingmore.com/v4/couriers/detect", {
        method: "POST", headers, body: JSON.stringify({ tracking_number: tn }),
      });
      const dd = (await dr.json() || {}).data;
      courierCode = (Array.isArray(dd) ? (dd[0] || {}).courier_code : (dd || {}).courier_code) || "";
    } catch (_) { /* ignore */ }

    let item = null;
    try {
      const cr = await fetch("https://api.trackingmore.com/v4/trackings/create", {
        method: "POST", headers,
        body: JSON.stringify(courierCode
          ? { tracking_number: tn, courier_code: courierCode }
          : { tracking_number: tn }),
      });
      item = first(await cr.json());
    } catch (_) { /* ignore */ }

    // 2) Fallback: fetch stored results.
    if (!item || !(item.status || item.delivery_status)) {
      try {
        const r = await fetch(
          "https://api.trackingmore.com/v4/trackings/get?tracking_numbers=" + encodeURIComponent(tn),
          { headers }
        );
        item = first(await r.json()) || item;
      } catch (e) {
        return json({ error: "upstream request failed: " + String(e) }, 502);
      }
    }
    if (!item) return json({ error: "no tracking data for this number" }, 404);

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
      events.push({ date: e.checkpoint_date || "",
        activity: e.tracking_detail || e.checkpoint_delivery_status || "",
        location: e.location || "" });
    }
    events.sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const raw = (item.status || item.delivery_status || "").toString();
    const status = STATUS[raw.toLowerCase()]
      || raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    return json({
      status,
      courier: item.courier_code || courierCode || "",
      delivered: raw.toLowerCase() === "delivered",
      last_location: (events[events.length - 1] || {}).location || "",
      last_update: (events[events.length - 1] || {}).date || item.last_update_time || "",
      track_url: "https://www.trackingmore.com/track/" + encodeURIComponent(tn),
      events,
    });
  },
};

/* ---------------------------------------------------------------------------
   ALTERNATE: Ship24 instead of TrackingMore
   ---------------------------------------------------------------------------
   const h = { "Authorization": "Bearer " + env.SHIP24_API_KEY, "Content-Type": "application/json" };
   const created = await (await fetch("https://api.ship24.com/public/v1/trackers",
       { method:"POST", headers:h, body: JSON.stringify({ trackingNumber: tn }) })).json();
   const id = created?.data?.tracker?.trackerId;
   const res = await (await fetch(`https://api.ship24.com/public/v1/trackers/${id}/results`, { headers:h })).json();
   // then map res.data.trackings[0] the same way.
--------------------------------------------------------------------------- */
