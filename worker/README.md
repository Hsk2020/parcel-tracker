# Live tracking worker (optional)

The app works without this. But to show **real live status for any tracking
number**, the browser needs a small backend — it can't call carrier APIs itself
(that would expose your key and the carriers block cross-origin calls). This
worker is that backend, and it's free to run.

## What it does

`GET https://your-worker.workers.dev/?tracking_number=1234567890`

→ returns clean JSON the app understands:

```json
{
  "status": "In Transit",
  "courier": "delhivery",
  "delivered": false,
  "last_location": "Mumbai, MH",
  "last_update": "2026-10-20 17:45:00",
  "track_url": "https://www.trackingmore.com/track/1234567890",
  "events": [ { "date": "...", "activity": "...", "location": "..." } ]
}
```

Your API key lives in a Worker **secret**, never in the browser.

## Setup (about 10 minutes)

1. **Get an aggregator key.** Sign up free at
   [TrackingMore](https://www.trackingmore.com/) (1,600+ carriers, includes
   Delhivery, Blue Dart, DTDC, India Post) and generate an API key.
   *(Prefer Ship24? It's a one-line swap — see the note at the bottom of
   `live-track-worker.js`.)*

2. **Install Wrangler and log in:**
   ```bash
   npm install -g wrangler
   wrangler login
   ```

3. **Create the worker project** and replace its `src/index.js` with
   `live-track-worker.js` from this folder.

4. **Store the key as a secret:**
   ```bash
   wrangler secret put TRACKINGMORE_API_KEY
   ```

5. **Deploy:**
   ```bash
   wrangler deploy
   ```
   Copy the printed URL, e.g. `https://hsk-track.<you>.workers.dev`.

6. **Point the app at it.** In `index.html`, set:
   ```js
   liveApi: "https://hsk-track.<you>.workers.dev",
   ```
   Commit. Now any number the user adds fetches live status.

## Notes

- The free tiers are rate-limited; check the provider's current limits.
- `Access-Control-Allow-Origin: *` is fine for a public tracking endpoint. If you
  want to lock it down, restrict it to your GitHub Pages origin.
- Nothing here is required for the app to work — without it, the app still
  auto-detects the courier and hands off to the courier's tracking page.
