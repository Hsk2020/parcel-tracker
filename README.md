# Hrudai Store Kart — Parcel Tracking Page

A customer-facing parcel tracking page for **Hrudai Store Kart**, with promo
cards for our two stores and Google AdSense slots.

- **Fashion & Accessories** → [hsk2020.in](https://hsk2020.in)
- **Organic Products** → [hsk.co.in](https://hsk.co.in)

The whole site is one static page (`index.html`) plus a data file
(`tracking_data.json`). No server, no build step. It is built to be hosted free
on **GitHub Pages**.

---

## Publish it on GitHub Pages (5 minutes, no coding)

### Step 1 — create the repository

1. Sign in to [github.com](https://github.com) and click **New repository**.
2. Name it something like `parcel-tracker`.
3. Set it to **Public** (GitHub Pages is free on public repos).
4. Click **Create repository**.

### Step 2 — upload the files

Easiest way (no tools to install):

1. On the empty repo page, click **uploading an existing file**.
2. Drag in **everything inside this folder** — `index.html`,
   `tracking_data.json`, `.nojekyll`, and the rest.
   *(The `.nojekyll` file may be hidden on your computer; if you can't see it,
   that's fine — the site still works. It only stops GitHub from running an
   extra processing step.)*
3. Click **Commit changes**.

### Step 3 — turn on Pages

1. In the repo, go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Branch: **main**, folder: **/ (root)**. Click **Save**.
4. Wait about a minute. Your page goes live at:

   ```
   https://YOUR-USERNAME.github.io/parcel-tracker/
   ```

   (Replace `YOUR-USERNAME` with your GitHub username.)

> Want the shortest possible URL? Name the repository
> `YOUR-USERNAME.github.io` instead — then the site serves at
> `https://YOUR-USERNAME.github.io/`.

### Step 2 (alternative) — using git on your computer

If you prefer the command line:

```bash
git init
git add .
git commit -m "Hrudai Store Kart tracking page"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/parcel-tracker.git
git push -u origin main
```

Then do Step 3 above.

---

## Updating the parcel data

The page reads `tracking_data.json` from the same folder. To refresh it:

1. Run the tracker tool on your own computer (see `TOOL_README.md`):

   ```bash
   python track_parcels.py -i parcels.csv -o tracking_data.json -p shiprocket
   ```

2. Upload the new `tracking_data.json` to the repo (drag it onto the repo page
   and commit, or `git add tracking_data.json && git commit -m "update" && git push`).

The page updates as soon as GitHub republishes (usually under a minute).

If `tracking_data.json` is missing, the page automatically shows sample
shipments, so it never looks broken.

---

## Turning on Google Ads

Open `index.html`, scroll to the `CONFIG` object near the bottom, and set:

```js
adSenseClient: "ca-pub-XXXXXXXXXXXXXXXX",          // your AdSense publisher ID
adSlots: { top: "1234567890", bottom: "0987654321" } // your ad unit slot IDs
```

Create the ad units in AdSense under **Ads → By ad unit → Display ads**, then
copy each `data-ad-slot` number. Until you paste a real publisher ID, each ad
position shows a tidy placeholder box instead of a live ad.

---

## Important: your parcel data is public

On a **public** repo, anyone who knows the URL can read `tracking_data.json` —
which contains tracking numbers and delivery statuses. That is usually fine
(tracking numbers are semi-public), but if you'd rather keep it private, you
have options:

- Keep the file out of the repo (add it to `.gitignore`) and host the data
  somewhere private, or
- Use a **private** repository with GitHub Pages (available on paid GitHub
  plans), or
- Only put test/sample data in the public file.

This is your call — just be aware of it before you publish real customer data.

---

## Files in this repo

| File | What it is |
|---|---|
| `index.html` | The tracking page (this is what GitHub Pages serves) |
| `tracking_data.json` | The parcel data the page displays |
| `.nojekyll` | Tells GitHub Pages to serve files as-is |
| `track_parcels.py`, `adapters.py` | The tracker tool that builds `tracking_data.json` |
| `edit_shipments.py`, `shipments_to_edit.csv` | Bulk-edit Delhivery shipment details (Edit Order API) |
| `config.example.json` | Copy to `config.json` and add API credentials (never commit it) |
| `parcels_sample.csv` | Example input for the tracker |
| `TOOL_README.md` | Full documentation for the tracker tool |

---

## Custom domain (optional)

If you want the page at, say, `track.hsk.co.in`, add a `CNAME` file containing
that domain, point a DNS record at GitHub Pages, and set it under
**Settings → Pages → Custom domain**. GitHub's docs cover the exact DNS steps.

---

## Credits

Built for Hrudai Store Kart. Tracking data is provided by the courier APIs via
the tracker tool; this page just displays it.
