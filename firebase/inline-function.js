/**
 * HSK Parcel Tracker - live status function (ES module, hardened)
 * ================================================================
 * Paste this whole file over index.js in the Cloud Run Source tab.
 *
 * Settings:
 *   Function entry point : track
 *   Runtime              : Node.js 22
 *   Variables & Secrets  : AFTERSHIP_API_KEY      = <key>   (primary)
 *                          TRACKINGMORE_API_KEY   = <key>   (fallback, optional)
 *                          ALLOWED_ORIGINS        = <comma separated> (optional)
 *                          MAX_NEW_PER_MONTH      = 45      (optional)
 *                          MAX_NEW_PER_DAY        = 5       (optional)
 *                          RATE_LIMIT_PER_MIN     = 20      (optional)
 *
 * What changed from the first version, and why:
 *  - Input validation: tracking numbers are shape-checked and courier codes
 *    are whitelisted, so junk never reaches a paid provider.
 *  - Rate limit per IP: a public endpoint with no limit could be used to burn
 *    the monthly provider allowance.
 *  - Result cache: repeat searches within 10 minutes are served from memory,
 *    so they cost no provider credits.
 *  - Get-before-create on BOTH providers: a lookup that finds the shipment
 *    never registers it again.
 *  - Daily registration budget: caps how many NEW shipments can be registered
 *    per day, protecting the free-tier allowance. Lookups are never blocked.
 *  - Structured errors: every failure returns a code, so the caller can tell
 *    "wrong number" from "provider down" from "quota protected".
 *  - Origin allowlist: CORS restricted to the known app hosts.
 *
 * Note on limits: the counters live in instance memory. Cloud Run may run
 * several instances and they reset on cold start, so these are guards, not
 * accounting. They stop casual abuse, not a determined attacker.
 */

import { http } from '@google-cloud/functions-framework';

const TM_BASE = "https://api.trackingmore.com/v4";
const AS_BASE = "https://api.aftership.com/tracking/2024-04";

const CACHE_TTL_MS = 10 * 60 * 1000;
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 20);
// The provider allowance is MONTHLY (AfterShip free = 50 shipments), so the
// monthly cap is the real guard. The daily cap only stops a burst from eating
// the whole month in one afternoon.
const MAX_NEW_PER_MONTH = Number(process.env.MAX_NEW_PER_MONTH || 45);
const MAX_NEW_PER_DAY = Number(process.env.MAX_NEW_PER_DAY || 5);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "https://hsk-tracker-1a2b3-f20a4.web.app," +
  "https://hsk-tracker-1a2b3.firebaseapp.com," +
  "https://hsk2020.github.io," +
  "http://localhost:8080,http://127.0.0.1:8080"
).split(",").map((s) => s.trim()).filter(Boolean);

// Courier codes we accept. Anything else is rejected rather than forwarded.
const COURIERS = new Set([
  "amazon", "bluedart", "delhivery", "dtdc", "ecom-express", "ekart",
  "fedex", "india-post", "shadowfax", "ups", "valmo", "xpressbees",
]);

const TM_STATUS = {
  pending: "Pending", inforeceived: "Info Received", transit: "In Transit",
  pickup: "Out for Delivery", delivered: "Delivered", undelivered: "Delivery Failed",
  exception: "Exception", expired: "Expired", notfound: "Not Found",
};

const AS_STATUS = {
  pending: "Pending", inforeceived: "Info Received", intransit: "In Transit",
  outfordelivery: "Out for Delivery", attemptfail: "Delivery Failed",
  delivered: "Delivered", availableforpickup: "Available for Pickup",
  exception: "Exception", expired: "Expired",
};

const DETAIL_LABELS = {
  "pending": "Shipment info received",
  "out for pickup": "Out for pickup",
  "pickdone": "Picked up",
  "intransit": "In transit",
  "reached at destination": "Reached destination hub",
  "out for delivery": "Out for delivery",
  "delivered": "Delivered",
  "undelivered": "Delivery attempted",
};

/* ----------------------------- state ----------------------------- */

const cache = new Map();     // "TN|slug" -> { expires, value }
const buckets = new Map();   // ip -> { start, count }
let budget = { month: monthKey(), monthUsed: 0, day: dayKey(), dayUsed: 0 };

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

function rollBudget() {
  const d = dayKey(), m = monthKey();
  if (budget.day !== d) { budget.day = d; budget.dayUsed = 0; }
  if (budget.month !== m) { budget.month = m; budget.monthUsed = 0; }
  return budget;
}

function budgetExhausted() {
  const b = rollBudget();
  return b.monthUsed >= MAX_NEW_PER_MONTH || b.dayUsed >= MAX_NEW_PER_DAY;
}

function consumeBudget() {
  const b = rollBudget();
  b.monthUsed += 1;
  b.dayUsed += 1;
}

function budgetSummary() {
  const b = rollBudget();
  return b.monthUsed + "/" + MAX_NEW_PER_MONTH + " this month, " +
         b.dayUsed + "/" + MAX_NEW_PER_DAY + " today";
}

function rateLimited(ip) {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now - b.start > 60_000) {
    buckets.set(ip, { start: now, count: 1 });
    return false;
  }
  b.count += 1;
  return b.count > RATE_LIMIT_PER_MIN;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) { cache.delete(key); return null; }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
}

/* ---------------------------- helpers ---------------------------- */

function pretty(s) {
  return String(s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function prettyActivity(s) {
  const raw = String(s || "").trim();
  return DETAIL_LABELS[raw.toLowerCase()] || raw;
}

function shortRef(tn) {
  // Logging aid: never write a full tracking number to logs.
  const s = String(tn);
  return s.length <= 6 ? s : s.slice(0, 4) + "***" + s.slice(-2);
}

function validTrackingNumber(tn) {
  if (!tn || tn.length < 6 || tn.length > 40) return false;
  return /^[A-Z0-9][A-Z0-9-]*$/.test(tn);
}

/* --------------------------- AfterShip --------------------------- */

async function asFetchJson(url, key, init) {
  const r = await fetch(url, {
    ...(init || {}),
    headers: { "as-api-key": key, "Content-Type": "application/json" },
  });
  let body = null;
  try { body = await r.json(); } catch (_) { body = null; }
  return { ok: r.ok, status: r.status, body };
}

function asNormalise(t, tn, slug) {
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
      activity: prettyActivity(c.message || pretty(c.tag || "")),
      location: c.location || c.city || "",
    })),
  };
}

async function afterShipLookup(tn, slug, key, mayRegister) {
  // 1) Read only - no side effects, no credits spent on registration.
  const qs = new URLSearchParams({ tracking_numbers: tn, limit: "1" });
  if (slug) qs.set("slug", slug);
  const found = await asFetchJson(`${AS_BASE}/trackings?${qs.toString()}`, key);
  const list = found.body && found.body.data && found.body.data.trackings;
  if (Array.isArray(list) && list.length) {
    return { value: asNormalise(list[0], tn, slug), registered: false, error: null };
  }

  // 2) Not known yet - register it, but only inside the daily budget.
  if (!mayRegister) return { value: null, registered: false, error: "quota_guard" };

  const body = { tracking: { tracking_number: tn } };
  if (slug) body.tracking.slug = slug;
  const created = await asFetchJson(`${AS_BASE}/trackings`, key, {
    method: "POST", body: JSON.stringify(body),
  });
  const t = created.body && created.body.data && created.body.data.tracking;
  if (!t) {
    return { value: null, registered: false, error: created.ok ? null : "provider_error" };
  }

  let full = t;
  if (t.id) {
    const one = await asFetchJson(`${AS_BASE}/trackings/${t.id}`, key);
    const got = one.body && one.body.data && one.body.data.tracking;
    if (got) full = got;
  }
  return { value: asNormalise(full, tn, slug), registered: true, error: null };
}

/* -------------------------- TrackingMore ------------------------- */

function tmFirst(j) {
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

function tmNormalise(item, tn, courierCode) {
  const events = [];
  for (const k of ["origin_info", "destination_info"]) {
    const info = item[k] || {};
    for (const e of (info.trackinfo || [])) {
      events.push({
        date: e.checkpoint_date || e.Date || "",
        activity: prettyActivity(e.tracking_detail || e.details || e.StatusDescription ||
          e.checkpoint_status || e.status_description || ""),
        location: e.location || e.Details || "",
      });
    }
  }
  for (const e of (item.tracking_events || [])) {
    events.push({
      date: e.checkpoint_date || "",
      activity: prettyActivity(e.tracking_detail || e.details ||
        e.checkpoint_delivery_status || e.status_description || ""),
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

async function trackingMoreLookup(tn, courierCode, key, mayRegister) {
  const headers = { "Tracking-Api-Key": key, "Content-Type": "application/json" };

  // 1) Read first. This is the change the review asked for: never create
  //    before checking whether the shipment is already tracked.
  try {
    const r = await fetch(
      `${TM_BASE}/trackings/get?tracking_numbers=${encodeURIComponent(tn)}`,
      { headers }
    );
    const j = await r.json().catch(() => null);
    const item = tmFirst(j);
    if (item) return { value: tmNormalise(item, tn, courierCode), registered: false, error: null };
  } catch (_) { /* fall through to create */ }

  // 2) Register, inside the daily budget.
  if (!mayRegister) return { value: null, registered: false, error: "quota_guard" };

  try {
    const cr = await fetch(`${TM_BASE}/trackings/create`, {
      method: "POST", headers,
      body: JSON.stringify(courierCode
        ? { tracking_number: tn, courier_code: courierCode }
        : { tracking_number: tn }),
    });
    const j = await cr.json().catch(() => null);
    const item = tmFirst(j);
    if (!item) return { value: null, registered: false, error: cr.ok ? null : "provider_error" };
    return { value: tmNormalise(item, tn, courierCode), registered: true, error: null };
  } catch (_) {
    return { value: null, registered: false, error: "provider_error" };
  }
}

/* ---------------------------- handler ---------------------------- */

http('track', async (req, res) => {
  const origin = String(req.headers.origin || "");
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  } else if (!origin) {
    // Server-side or direct browser navigation: no CORS header needed.
  }
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }

  const started = Date.now();

  const tn = String((req.query && req.query.tracking_number) || "").trim().toUpperCase();
  const slugRaw = String((req.query && req.query.courier_code) || "").trim().toLowerCase();

  if (!tn) {
    res.status(400).json({ error: "missing tracking_number", code: "invalid_number" });
    return;
  }
  if (!validTrackingNumber(tn)) {
    res.status(400).json({
      error: "tracking number format not recognised", code: "invalid_number",
    });
    return;
  }
  if (slugRaw && !COURIERS.has(slugRaw)) {
    res.status(400).json({ error: "unsupported courier code", code: "invalid_courier" });
    return;
  }

  const ip = String(
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.headers["x-real-ip"] || req.ip || "unknown"
  );
  if (rateLimited(ip)) {
    res.status(429).json({
      error: "too many requests, please wait a minute", code: "rate_limited",
    });
    return;
  }

  const cacheKey = tn + "|" + slugRaw;
  const cached = cacheGet(cacheKey);
  if (cached) {
    res.set("X-Cache", "hit");
    res.json(cached);
    return;
  }

  const asKey = process.env.AFTERSHIP_API_KEY;
  const tmKey = process.env.TRACKINGMORE_API_KEY;
  if (!asKey && !tmKey) {
    res.status(500).json({
      error: "server not configured (set AFTERSHIP_API_KEY and/or TRACKINGMORE_API_KEY)",
      code: "not_configured",
    });
    return;
  }

  const mayRegister = !budgetExhausted();

  let out = null;
  let source = "";
  let sawProviderError = false;
  let registeredAny = false;

  if (asKey) {
    try {
      const r = await afterShipLookup(tn, slugRaw, asKey, mayRegister);
      if (r.value) { out = r.value; source = "aftership"; }
      if (r.registered) { registeredAny = true; consumeBudget(); }
      if (r.error === "provider_error") sawProviderError = true;
    } catch (_) { sawProviderError = true; }
  }

  const asHasEvents = out && Array.isArray(out.events) && out.events.length > 0;
  if (!asHasEvents && tmKey) {
    try {
      const r = await trackingMoreLookup(tn, slugRaw, tmKey, mayRegister);
      if (r.value && (!out || (r.value.events || []).length > (out.events || []).length)) {
        out = r.value; source = "trackingmore";
      }
      if (r.registered) { registeredAny = true; consumeBudget(); }
      if (r.error === "provider_error") sawProviderError = true;
    } catch (_) { sawProviderError = true; }
  }

  const ms = Date.now() - started;

  if (!out) {
    const code = !mayRegister && sawProviderError ? "provider_error"
      : !mayRegister ? "quota_guard"
      : sawProviderError ? "provider_error"
      : "not_found";
    const status = code === "provider_error" ? 502 : code === "quota_guard" ? 503 : 404;
    console.log(JSON.stringify({ ref: shortRef(tn), slug: slugRaw, outcome: code, ms }));
    res.status(status).json({
      error: code === "provider_error"
        ? "tracking provider unavailable, please try again shortly"
        : code === "quota_guard"
        ? "new shipment registrations are paused for today; open the courier's own tracking page"
        : "no tracking data for this number",
      code,
    });
    return;
  }

  const payload = { ...out, source, registered: registeredAny };
  cacheSet(cacheKey, payload);
  console.log(JSON.stringify({
    ref: shortRef(tn), slug: slugRaw, source, events: (out.events || []).length,
    registered: registeredAny, ms, budget: budgetSummary(),
  }));
  res.set("X-Cache", "miss");
  res.json(payload);
});
