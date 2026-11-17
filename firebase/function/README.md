# Live status function (deployable container)

This folder exists so the function can be **built and deployed automatically**
instead of pasted into the Cloud Run Source editor by hand.

- `index.js` — byte-identical copy of `../cloudrun-function.js`
- `package.json` — declares the functions-framework and the `track` entry point
- `Dockerfile` — Node 22 image that runs the function on `$PORT`

## One-time setup (Cloud Run console)

1. Cloud Run → service **track** → **Edit & deploy new revision**
2. Under **Source**, choose **Continuously deploy new revisions from a source repository**
3. **Set up with Cloud Build** → connect GitHub → repo `Hsk2020/parcel-tracker`
4. Branch: `^main$`
5. Build type: **Dockerfile**, source location: `firebase/function`
6. Save and deploy

From then on, every push to `main` rebuilds and redeploys the function.
The website already deploys the same way through Firebase Hosting.

## After changing the function

Edit `../cloudrun-function.js`, then copy it here:

```sh
cp cloudrun-function.js function/index.js
```

Bump `BUILD` in the file so `/?diag=1` shows the new version.

## Environment variables

Unchanged — set them in Cloud Run → Variables & Secrets. The Dockerfile does
not read or bake in any secret.
