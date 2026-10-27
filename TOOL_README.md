# Parcel Tracker

Pull live tracking status for a list of parcels and write it back to a CSV or
Excel file. One small tool, several couriers, pluggable adapters.

You feed it a CSV of tracking numbers. It queries the courier or aggregator
API(s) you have credentials for, and returns each parcel's current status,
last scan location, last update time, a delivered flag and a clickable
tracking URL.

---

## Why there is no single "track any Indian courier" API

This matters before you start, because it decides which provider you pick:

| Courier | Official API? | What you need |
|---|---|---|
| **Delhivery** | Yes | A merchant API token from your Delhivery account |
| **Shiprocket** | Yes | Shiprocket account + API user (covers DTDC, Blue Dart, Ekart, XpressBees, Delhivery and more in one API) |
| **Blue Dart** | Yes | Business account credentials |
| **DTDC** | Yes | Business account credentials |
| **India Post / Speed Post** | No public API | Bulk track-and-trace via corporate portal/SFTP with IP whitelisting, or go through an aggregator |
| **Amazon / Flipkart shipping** | Not for sellers | Track via the marketplace panel or the shipping partner |

There is no free public endpoint that covers all of them. So the practical
setup is one of:

1. **You ship through Shiprocket** → use the `shiprocket` provider. One login
   covers every courier Shiprocket books.
2. **You have a Delhivery account** → use the `delhivery` provider.
3. **Mixed / no accounts** → use an aggregator (`ship24` or `trackingmore`),
   which cover 1,500+ couriers including India Post, and have free trial tiers.
4. **No credentials at all** → use the `manual` provider, which just builds the
   official tracking URL for each parcel so a human can click through. No key
   needed, works today.

---

## Install

```bash
cd parcel_tracker
pip install -r requirements.txt
```

Requires Python 3.10+.

---

## Quick start (no credentials needed)

Run it offline against fake data to see the output format:

```bash
python track_parcels.py --demo
```

Or generate clickable tracking URLs for real parcels with no API key:

```bash
python track_parcels.py -i parcels_sample.csv -o tracked.csv -p manual
```

---

## Configure credentials

Copy the example config and fill in only the providers you actually have:

```bash
cp config.example.json config.json
```

`config.json`:

```json
{
  "default_provider": "shiprocket",
  "providers": {
    "delhivery":   { "token": "", "client_name": "", "env": "production" },
    "shiprocket":  { "email": "", "password": "" },
    "ship24":      { "api_key": "" },
    "trackingmore":{ "api_key": "", "courier_code": "" }
  }
}
```

Every value can also be set as an **environment variable** (env vars win over
the file — handy for servers and CI):

| Setting | Environment variable |
|---|---|
| Delhivery token | `DELHIVERY_TOKEN` |
| Delhivery client name | `DELHIVERY_CLIENT_NAME` |
| Delhivery environment (`production`/`staging`) | `DELHIVERY_ENV` |
| Shiprocket email | `SHIPROCKET_EMAIL` |
| Shiprocket password | `SHIPROCKET_PASSWORD` |
| Ship24 API key | `SHIP24_API_KEY` |
| TrackingMore API key | `TRACKINGMORE_API_KEY` |
| TrackingMore courier code | `TRACKINGMORE_COURIER_CODE` |
| Shadowfax token | `SHADOWFAX_TOKEN` |
| Shadowfax environment (`staging`/`production`) | `SHADOWFAX_ENV` |
| UPS client ID | `UPS_CLIENT_ID` |
| UPS client secret | `UPS_CLIENT_SECRET` |
| UPS environment (`production`/`staging`) | `UPS_ENV` |

No credentials are ever hardcoded in the code. Keep `config.json` out of
version control.

### Where to get each credential

- **Delhivery**: log in to your Delhivery One account → Settings → API Setup →
  copy the API Token. The token is sent as `Authorization: Token <token>`.
  Use `"env": "staging"` while testing.
- **Shiprocket**: Settings → API → Create an API User. Use that email and
  password; the tool logs in and gets a bearer token automatically.
- **Ship24**: sign up, generate a tracking API key. Free plan available.
- **TrackingMore**: sign up, generate an API key. Free tier available. Check
  any key works with `python verify_key.py --key-file <file>` (or `--key`, or the
  `TRACKINGMORE_API_KEY` env var) — it calls the account-info endpoint and spends
  no tracking credits.
- **Shadowfax**: generate a token in the SFX 360 Partner Portal. Use
  `"env": "staging"` (dale.staging.shadowfax.in) while testing and swap to
  `production` when you go live. The token is static and does not expire.
- **UPS**: register an app at developer.ups.com; you get a client ID and a client
  secret. Use `"env": "staging"` (the CIE sandbox, wwwcie.ups.com) while testing
  and `production` when live. Tokens last about 4 hours and are cached
  automatically. UPS tracking numbers are the `1Z` + 16 character format.

---

## Usage

```bash
# demo / offline
python track_parcels.py --demo

# one provider for everything
python track_parcels.py -i parcels.csv -o tracked.csv -p shiprocket

# mixed couriers: add a 'provider' column to the CSV and omit -p
python track_parcels.py -i parcels.csv -o tracked.xlsx

# explicit config file
python track_parcels.py -i parcels.csv -o tracked.csv -c /etc/parcels/config.json
```

Options:

| Flag | Meaning |
|---|---|
| `-i, --input` | input CSV (default `parcels.csv`) |
| `-o, --output` | output file (default `tracked.csv`) |
| `-p, --provider` | force one provider for all rows |
| `-c, --config` | config file path (default `config.json`) |
| `--demo` | offline fake data, no credentials |
| `-f, --format` | `auto` (default), `csv`, `xlsx` or `json` |

The `json` format is what the tracking web page reads — see below.

Exit codes: `0` success, `2` bad input, `3` no provider could run (usually a
missing credential).

---

## Input format

A CSV. Column names are matched case-insensitively; extra columns are kept.

| Column | Required | Notes |
|---|---|---|
| `tracking_number` | yes | aliases: `awb`, `waybill`, `consignment`, `tracking_id` |
| `provider` | no | per-row provider override (e.g. `delhivery`, `shiprocket`) |
| `courier` | no | courier name; used by the `manual` provider for its URL |
| `order_id` | no | your own reference, carried through unchanged |

Example (`parcels_sample.csv`):

```csv
tracking_number,courier,order_id
DEMO123456789,delhivery,ORD-1001
DEMO987654321,dtdc,ORD-1002
```

---

## Output columns

| Column | Meaning |
|---|---|
| `tracking_number` | as supplied |
| `courier` | courier name (from the API, or your input) |
| `status` | current status text |
| `delivered` | `YES` when the status indicates delivery |
| `last_location` | most recent scan location |
| `last_update` | most recent scan time |
| `status_detail` | extra status text where available |
| `track_url` | clickable tracking URL |
| `provider` | which adapter answered |
| `error` | populated instead of a status when a parcel failed |

One bad parcel never kills the run — its error goes in the `error` column and
the rest are still tracked.

---

## The tracking web page

`tracking_page.html` is a standalone, customer-facing page: a search box for a
tracking number, a status card with the full scan-history timeline, a list of
all shipments with a filter, promotional cards for your two stores, and Google
AdSense slots. It works on its own or embedded in a website, on desktop and
mobile. No build step, no dependencies.

**Feed it live data.** The page loads `tracking_data.json` from the same folder.
Generate it with the tracker:

```bash
python track_parcels.py -i parcels.csv -o tracking_data.json -p shiprocket
```

If that file is missing (or you just open the page directly from disk), the
page shows built-in sample shipments so it never looks broken.

> Tip: browsers block `fetch()` on `file://` pages, so to load real data, host
the folder on a local web server, or upload both files to your web host. Opened
straight from disk, the page simply falls back to the samples.

**Set up Google Ads.** Open `tracking_page.html` and find the `CONFIG` object
near the bottom of the file. Set:

```js
adSenseClient: "ca-pub-XXXXXXXXXXXXXXXX",   // your AdSense publisher ID
adSlots: { top: "1234567890", bottom: "0987654321" }  // your ad unit slot IDs
```

Until you paste a real publisher ID, each ad position shows a tidy placeholder
box instead of a live ad, so nothing breaks. Create the ad units in AdSense
(Ads > By ad unit > Display ads) and copy each `data-ad-slot` number.

**Edit the promos.** The `stores` array in the same `CONFIG` object controls the
two promo cards (name, wording, colour, link). It ships pointing at hsk2020.in
and hsk.co.in.

---

## Providers

| Name | Type | Credentials | Notes |
|---|---|---|---|
| `delhivery` | direct courier | `token` | Delhivery's own tracking API |
| `shiprocket` | aggregator | `email`, `password` | Batches up to 50 AWBs per call |
| `shadowfax` | direct courier | `token` | Shadowfax staging + production; batches up to 50 AWBs |
| `ups` | direct courier | `client_id`, `client_secret` | UPS OAuth 2.0; `staging` = CIE sandbox |
| `ship24` | aggregator | `api_key` | 1,500+ couriers incl. India Post |
| `trackingmore` | aggregator | `api_key` | 1,600+ couriers |
| `manual` | none | none | Returns the official tracking URL only |
| `demo` | none | none | Offline fake data for testing |

---

## Adding your own courier

Open `adapters.py`, subclass `CourierAdapter`, implement `track()`, and register
it in the `ADAPTERS` dict at the bottom. Return a `TrackingResult`:

```python
class MyCourierAdapter(CourierAdapter):
    name = "mycourier"
    requires = ("api_key",)

    def track(self, tracking_number):
        r = self.session.get(
            "https://api.mycourier.com/track",
            headers={"X-API-Key": self.config["api_key"]},
            params={"awb": tracking_number},
            timeout=REQUEST_TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        return TrackingResult(
            tracking_number=tracking_number,
            provider=self.name,
            courier="MyCourier",
            status=data["status"],
            delivered=looks_delivered(data["status"]),
            track_url=f"https://mycourier.com/track/{tracking_number}",
        )
```

Add the credential name to `ENV_MAP` in `track_parcels.py` if you want an env
var for it too.

---

## Bulk-editing Delhivery shipments

`edit_shipments.py` updates package details *after* manifestation via
Delhivery's Edit Order API (`POST /api/p/edit`) — payment mode, COD amount,
weight, dimensions and consignee details — for a whole list of waybills at once.

Delhivery only accepts these edits while a parcel is **Manifested / In Transit /
Pending / Scheduled**. It rejects them once the parcel is Delivered, Dispatched,
RTO, DTO, Picked Up or Collected.

```bash
# always start with a dry run - it prints exactly what would be sent, no calls made
python edit_shipments.py -i shipments_to_edit.csv --dry-run

# real run against staging, then production
python edit_shipments.py -i shipments_to_edit.csv -o edit_results.csv --env staging
python edit_shipments.py -i shipments_to_edit.csv -o edit_results.csv --env production
```

Input CSV — only `waybill` is required; blank cells are skipped:

```csv
waybill,pt,cod,gm,shipment_length,shipment_width,shipment_height
843000000001,COD,100,100.2,20,15,40.2
843000000002,Pre-paid,,250,30,20,10
```

`pt` must be `COD` or `Pre-paid`. The token is read from `config.json`
(`providers.delhivery.token`) or the `DELHIVERY_TOKEN` env var. Results are
written to a CSV with the HTTP status, a success flag and Delhivery's message
for each row.

---

## TrackingMore courier coverage

TrackingMore covers ~1,700 carriers. The Indian couriers most relevant to us, with
their TrackingMore courier codes:

| Courier | Code |
|---|---|
| Delhivery | `delhivery` |
| Blue Dart | `bluedart` |
| DTDC | `dtdc` (and `dtdc-plus`) |
| India Post / Speed Post | `india-post` |
| Ekart (Flipkart) | `ekart` |
| Ecom Express | `ecom-express` |
| XpressBees | `xpressbees` |
| Shadowfax | `shadowfax` |
| Gati | `gaticn` / `gati-kwe` |
| Dotzot | `dotzot` |
| Delcart | `delcart-in` |
| First Flight | `first-flight` |
| GoJavas | `gojavas` |
| The Professional Couriers | `professional-couriers` |
| Trackon | `trackon` |
| Safexpress | `safexpress` |
| Amazon | `amazon` |
| UPS | `ups` |
| FedEx | `fedex` |
| DHL | `dhl` |
| Aramex | `aramex` |
| TNT | `tnt` |

**Get the complete live list** (authoritative, ~1,700 carriers):

```bash
python list_couriers.py --search india      # only India-related couriers
python list_couriers.py --csv couriers.csv  # save them all
```

**Mixed couriers in one run:** add a `courier_code` column to your CSV and use
`-p trackingmore` - each row is tracked with its own code.

```csv
tracking_number,courier_code
1Z999AA10123456784,ups
SF1234567890,shadowfax
```

Leave `courier_code` blank and TrackingMore's own detection picks the courier.

---

## Limitations and honest notes

- **Delhivery and Shiprocket endpoints** follow their published API docs and
  should be stable. The **Ship24** and **TrackingMore** adapters parse
  defensively and are written to the v4 / public-v1 shapes; check them against
  the provider's current docs if a field comes back empty.
- **Rate limits** apply per provider (e.g. Delhivery allows a set number of
  requests per 5 minutes per IP). The tool issues one request per parcel (or one
  batch per 50 for Shiprocket); add a delay for very large lists.
- **This environment** (the sandbox this was built in) could not reach the live
  courier hosts to do a real end-to-end call — outbound access to those domains
  is blocked here. The demo and manual paths are fully tested; the live adapters
  are built to the documented request/response shapes and run on any machine
  with normal internet access.
- Tracking data belongs to the courier; respect each provider's terms of use and
  only track parcels you are entitled to.

---

## Sources

Built from the published API documentation of:

- Delhivery — order tracking API and API token generation docs
- Shiprocket — API docs (track by AWB, track multiple AWBs)
- Ship24 — tracking API and India Post coverage
- TrackingMore — multi-carrier tracking API
- India Post / CEPT — data-sharing and bulk track-and-trace integration notes
- AfterShip — supported couriers reference

Always confirm the current endpoint and authentication details against the
provider's live documentation before going to production.
