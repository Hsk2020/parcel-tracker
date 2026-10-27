# Live tracking on Firebase (alternative to Cloudflare)

The Firebase equivalent of `worker/live-track-worker.js`: one HTTPS function that
holds your TrackingMore key server-side and returns the JSON the app expects.

**Read this first:** Firebase Functions needs the **Blaze (pay-as-you-go) plan**
to make outbound network calls — the free Spark plan blocks them. There's a free
monthly allowance inside Blaze (≈2M invocations), but a billing account must be
attached. Cloudflare Workers stays free without that, so it's the cheaper option
if it works for you.

## Deploy (about 10 minutes)

```bash
npm install -g firebase-tools
firebase login
cd firebase
firebase use --add                 # choose (or create) your Firebase project
cd functions && npm install && cd ..
firebase functions:secrets:set TRACKINGMORE_API_KEY    # paste your key
firebase deploy --only functions
```

It prints a URL like:

```
https://asia-south1-yourproject.cloudfunctions.net/track
```

Test it in a browser:

```
https://asia-south1-yourproject.cloudfunctions.net/track
```

You should get JSON with `status`, `courier`, `events`.

## Wire it into the app

In `index.html`, set:

```js
liveApi: "https://asia-south1-yourproject.cloudfunctions.net/track",
```

Commit. Any tracking number typed into the app will now resolve live.

## Notes

- **Region** is `asia-south1` (Mumbai) in `functions/index.js` — good for India.
  Change it there if you prefer another.
- **CORS** is enabled (`cors: true`), so the browser can call it directly.
- **Key handling:** the key lives in a Firebase secret, never in the browser.
- Same parsing as the Worker: detects the courier, creates the tracking
  (create-and-get in TrackingMore v4), falls back to a stored lookup, and maps
  `origin_info` / `destination_info` scan events into a timeline.

---

# Hosting the app on Firebase Hosting

The site can be served from Firebase Hosting instead of GitHub Pages. The
config lives at the **repo root** (`firebase.json` + `.firebaserc`), and it
publishes the repo root itself, so there is only ONE copy of the app - no
`public/` duplicate to drift out of sync.

## Deploy

From the **repo root** (not the `firebase/` folder):

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only hosting
```

It prints your live URLs:

```
Hosting URL: https://hsk-tracker-1a2b3-f20a4.web.app
             https://hsk-tracker-1a2b3-f20a4.firebaseapp.com
```

## What gets published

Only the site files: `index.html`, `tracking_data.json`,
`manifest.webmanifest`, `sw.js`, `icon-192.png`, `icon-512.png`,
`tracking-page.html`. Python scripts, docs, CSVs, the `worker/` and `firebase/`
folders are excluded by the `ignore` list in `firebase.json`.

`tracking_data.json` and `sw.js` are served with `no-cache` so updates show up
immediately.

## Notes

- The scheduled GitHub Action still refreshes `tracking_data.json` and commits
  it; the next `firebase deploy` picks it up. To auto-deploy on every commit,
  add a GitHub Actions workflow that runs `firebase deploy --only hosting` with
  a `FIREBASE_TOKEN`.
- The Cloud Run function (`track`) is unaffected - it was deployed from the
  Cloud Console, so the `functions` block is not needed here.
- Once Firebase Hosting is live and you're happy, GitHub Pages can be disabled
  in repo Settings -> Pages.
