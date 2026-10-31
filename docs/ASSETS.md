# Heavy files (WASM and models)

`assets.manifest.json` lists every file that is too big for git, with its size and sha256.

| Group | Files | Used by | Fetched from |
| --- | --- | --- | --- |
| `frontend` | ONNX Runtime WASM, face detector, face recognizer, liveness (MiniFASNet) | the student's browser | `frontendBaseUrl` (a CDN) |
| `backend` | CCTV detector and recognizer | the Python CCTV service | the entry's `url`, then the old Google Drive link |

## Setting up a machine

```
npm run assets                      # everything
npm run assets -- --scope=backend   # only the CCTV models
npm run assets -- --check           # report only
```

Files land in `frontend/utils/...` (for the source pages) and `backend/models/` (for CCTV). The Python service also downloads a missing model by itself on first run, using the same manifest.

## Where browsers get the frontend files

GitHub Releases and Google Drive links **cannot** be used for these: browsers are blocked from fetching GitHub release assets (the redirect carries no CORS header), and Drive answers large files with a confirmation page and quotas. jsDelivr works because it serves repo files with CORS and long caching. In source mode (`SERVE_DIST=0`), the backend injects `frontendBaseUrl` from this manifest into `utils/runtime-config.js`; built mode uses the manifest value unless overridden with `--assets`.

Today `frontendBaseUrl` points at the `v1` tag of this repo. Tags never change, so the files stay available there even after they are removed from `main`. The files are still in git history, though. To remove them for good:

1. Create a small public repo (for example `qr-attendance-assets`) containing only `utils/ort/...` and `utils/models/...`, and tag it `v1`.
2. Set `frontendBaseUrl` in `assets.manifest.json` to `https://cdn.jsdelivr.net/gh/<you>/qr-attendance-assets@v1`.
3. Rebuild and deploy. Optionally rewrite this repo's history with `git filter-repo` to shrink clones.

## Replacing a file

1. Put the new file in its folder, run `npm run assets -- --update-hashes`.
2. Update `bytes` in `frontend/js/face/engine.js` (the build refuses to run if the two disagree) and bump `VERSION` there so phones replace their cached copy.
3. Publish the file at a new tag (`v2`) and update `frontendBaseUrl`. Never reuse a tag: CDNs and phones cache it for a long time.

## Backend models

Upload `10g_bnkps.onnx` and `cvlface_adaface_ir101_webface12m.onnx` as release assets (tag `assets-v1`) of this repo, then run `npm run assets -- --scope=backend --update-hashes` on a machine that has them to record their hashes. Until the release exists, the Google Drive link is used.
