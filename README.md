# HSK Parcel Tracker

Parcel tracking app for **Hrudai Store Kart** — enter any tracking number, the
courier is detected automatically, and the live scan timeline is shown.

Built and operated for the stores:

- **Fashion & Accessories** → [hsk2020.in](https://hsk2020.in)
- **Organic Products** → [hsk.co.in](https://hsk.co.in)

---

## Live addresses

| Address | Serves |
|---|---|
| **https://hskparcel.in** | Primary tracker (canonical) |
| https://track.hsk2020.in | Same app, kept so older links keep working |
| https://hsk-tracker-1a2b3-f20a4.web.app | Firebase default hostname |
| https://hskparcel.in/guides/ | Seven tracking guides (content pages) |

`hsk2020.in` itself forwards to the MyDukaan store — do not point it at Firebase.

---

## Architecture

```
Browser (PWA)
   │
   ├── Firebase Hosting ── index.html, guides, manifest, service worker
   │
   └── fetch() ──► Cloud Run function ──► AfterShip (primary)
                     track-hsk-co-in.cloud.run        │
                                                      └► TrackingMore (fallback)
```

- **Front end** — one static `index.html` (HTML + CSS + JS inline), a PWA
  manifest and a self-updating service worker. No build step.
- **Back end** — a single Cloud Run function (`firebase/cloudrun-function.js`,
  ESM, entry point `track`). It holds the provider keys, so no credential is
  ever exposed to the browser.
- **Providers** — AfterShip first, TrackingMore when AfterShip has no data.
  Both are read-through caches: a lookup that finds a shipment never registers
  it again.

### Deploying

| Part | How it deploys |
|---|---|
| Static site | Automatic — any push to `main` runs `.github/workflows/firebase-hosting.yml` |
| Cloud Run function | **Manual** — paste `firebase/cloudrun-function.js` into the Cloud Run Source tab and Deploy |

The function is the one piece that cannot be deployed from this repository.

---

## Function configuration

Set as Cloud Run environment variables — never in the repo:

| Variable | Purpose |
|---|---|
| `AFTERSHIP_API_KEY` | Primary provider |
| `TRACKINGMORE_API_KEY` | Fallback provider |
| `ALLOWED_ORIGINS` | CORS allowlist (comma separated) |
| `MAX_NEW_PER_MONTH` | Default 100 — caps new registrations per month |
| `MAX_NEW_PER_DAY` | Default 25 — caps new registrations per day |
| `RATE_LIMIT_PER_MIN` | Default 20 — per-IP request limit |

Guard rails already in the function: input validation, courier-code slug check,
per-IP rate limit, 10-minute result cache, daily and monthly registration
budgets, get-before-create on both providers, structured error codes, and an
origin allowlist.

**Known limitation:** the counters live in instance memory, so they reset on
cold start and are not shared across instances. They stop casual abuse, not a
determined attacker.

---

## Couriers

Selectable in the app (18). Detection is automatic for the ones with a
distinctive number format; the rest are chosen from the dropdown.

**Live timeline:**

| Courier | Number format |
|---|---|
| Delhivery | 12–14 digits |
| Ekart | `FMPP`, `FMP`, `FMPC`, `DSPC`, `SHCP` + digits |
| DTDC | `D`/`V`/`X`/`Z` + 7–11 digits |
| XpressBees | 13–15 digits |
| Shadowfax | `SF` + digits |
| Blue Dart | 11 digits |
| India Post / Speed Post | two letters + 9 digits + `IN` |
| UPS | `1Z` + 16 alphanumerics |
| Cainiao / AliExpress | `ALS` or `LP` + digits |
| Amazon Logistics | `TBA`/`TBC`/`TBM` + 12 digits |
| Amazon order ID | `404-1234567-1234567` (explained, not tracked) |
| **VRL Logistics** | LR number, ~10 digits — confirmed working |
| **Gati (Allcargo)** | docket, 9–10 digits — wired, awaiting a real test |

**Hand-off only** — these do not publish tracking to third parties, so the app
opens their own page instead of pretending to have a timeline:

- **APSRTC Cargo** — also requires the sender's or receiver's mobile number
- **Porter**
- **Rapido**

---

## App features

- **Courier auto-detection** with manual override from the dropdown
- **Saved parcels** in `localStorage` (per browser, never uploaded)
- **Delivery ETA** when the provider publishes one
- **In-app change alerts** — saved parcels re-check on open; anything that moved
  gets a dot and a toast. Capped at 8 parcels per visit, once per 15 minutes.
- **Deep links** — `?tracking_number=AWB&courier=code` opens straight onto a
  parcel. Also accepts `tn`, `awb`, `number`.
- **Shareable parcel links** and an address bar that follows the open parcel
- **APSRTC mobile field** — appears only when that courier is selected,
  validated, stored locally, never transmitted
- **Feedback link** — opens WhatsApp with the message prefilled
- **Installable PWA** with a self-updating service worker (no hard refresh)

---

## Content and SEO

- `guides/` — seven articles on Indian parcel tracking, written to answer real
  searches (courier formats, status meanings, APSRTC, Cainiao, VRL, Gati)
- `sitemap.xml` and `robots.txt` — sitemap submitted to Search Console
- Canonical tags point every page at `hskparcel.in`
- Open Graph and Twitter cards with a 1200×630 share image (`og-image.png`)
- JSON-LD `WebApplication` structured data

---

## Advertising (Google AdSense)

Publisher ID `ca-pub-2396239883686272`.

| Item | State |
|---|---|
| Ad code on all pages | Yes, in `<head>` |
| `ads.txt` | Served at the domain root, byte-exact |
| Sites in AdSense | `hskparcel.in` and the `.web.app` host |
| Approval | **Pending review** |
| Known risk | AdSense previously rejected the site for "screens without publisher content" — the guides section was added to address that |

Ad units sit on the guide pages only. The tracker screen is deliberately
ad-light.

---

## Repository layout

```
index.html                 the whole app
about.html, privacy.html   supporting pages
guides/                    seven content pages + index
manifest.webmanifest       PWA manifest
sw.js                      service worker (cache version bumped on each release)
firebase/
  cloudrun-function.js     the live function — paste this into Cloud Run
  inline-function.js       byte-identical mirror
firebase.json, .firebaserc hosting config (public: ".", no public/ folder)
ads.txt, robots.txt, sitemap.xml
og-image.png, icon-*.png, logo-full.png, qr-*.png
adapters.py, track_parcels.py, …   Python toolkit (separate from the web app)
```

---

## Python toolkit

`track_parcels.py` and `adapters.py` are a command-line toolkit for bulk
tracking, separate from the web app. Adapters included: direct Delhivery,
Shiprocket, Ship24, TrackingMore, and manual hand-off. Credentials come from a
git-ignored `config.json` or environment variables.

---

## Deliberate limitations

Stated plainly, because the app says the same to users:

- **Amazon order IDs cannot be tracked** by any third party. Only Amazon's own
  account pages resolve them.
- **Porter, Rapido and APSRTC Cargo** publish no tracking data. Hand-off only.
- **Aggregator data lags** the courier's own site by minutes to hours.
- **Free-tier ceiling** — roughly 100 new parcels per month. Direct carrier
  APIs are the way past it.
- **Firebase billing** — the project runs on a Google Cloud trial that expires
  **26 January 2027**. Without a payment method, tracking lookups stop.

---

## Pending work

1. Test Gati with a real docket number; switch the slug to `gati` if
   `gati-kwe` returns nothing.
2. Redeploy the function to pick up the location-merge fix (`ad0aa08`).
3. AdSense review outcome.
4. When parcel volume justifies it: direct carrier APIs (Delhivery first) to
   reduce dependence on the aggregators.
