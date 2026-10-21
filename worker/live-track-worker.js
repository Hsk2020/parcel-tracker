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

    const headers = { "Trackingmore-Api-Key": key, "Content-Type": "application/json" };

    // 1) Create the tracking (ignore "already exists" errors), then fetch.
    try {
      await fetch("https://api.trackingmore.com/v4/trackings/create", {
        method: "POST", headers, body: JSON.stringify({ tracking_number: tn }),
      });
    } catch (_) { /* ignore */ }

    let data;
    try {
      const r = await fetch(
        "https://api.trackingmore.com/v4/trackings/get?tracking_numbers=" + encodeURIComponent(tn),
        { headers }
      );
      data = await r.json();
    } catch (e) {
      return json({ error: "upstream request failed: " + String(e) }, 502);
    }

    const item = (data && data.data && data.data[0]) || null;
    if (!item) return json({ error: "no tracking data for this number" }, 404);

    const events = (item.tracking_events || []).map((e) => ({
      date: e.checkpoint_date || "",
      activity: e.checkpoint_delivery_status || e.tracking_detail || "",
      location: e.location || "",
    }));

    const status = (item.delivery_status || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    return json({
      status: item.latest_status || status,
      courier: item.courier_code || "",
      delivered: String(item.delivery_status || "").toLowerCase() === "delivered",
      last_location: (events[events.length - 1] || {}).location || "",
      last_update: (events[events.length - 1] || {}).date || "",
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
