# Jarvis Labs Maintenance Notes

This fork carries Jarvis Labs specific ComfyUI frontend changes. Keep Jarvis
behavior explicit and gated so upstream frontend updates remain easy to merge.

## Branches And Remotes

- `origin`: `https://github.com/svishnu88/ComfyUI_frontend.git`
- `upstream`: `https://github.com/Comfy-Org/ComfyUI_frontend.git`
- Jarvis branch: `jarvis-main`
- Upstream branch: `main`

## Jarvis Frontend Surface

Jarvis-specific frontend behavior should stay behind names that contain
`jarvis`:

- Distribution: `DISTRIBUTION=jarvis`
- Distribution helper: `isJarvis`
- Server feature flag: `jarvis_model_downloads`
- API route prefix: `/api/jarvis/...`

The missing-model downloader uses the Jarvis server-side path only when both
conditions are true:

- The frontend was built with `DISTRIBUTION=jarvis`.
- The backend advertises `jarvis_model_downloads`.

Otherwise, non-desktop behavior falls back to the regular browser download
path and desktop behavior stays on the Electron download path.

Current Jarvis model-download UI behavior:

- Keeps the existing `Download`, `Download all`, `Copy URL`, and
  `Use from Library` controls.
- Shows model download progress in the existing missing-model status card.
- Does not show a toast when the download starts because the progress card is
  the primary feedback.
- Hides the download button after the model is completed locally.

## Updating From Upstream

Use a merge-first workflow:

```bash
git checkout jarvis-main
git fetch upstream
git merge upstream/main
DISTRIBUTION=jarvis GENERATE_SOURCEMAP=false pnpm exec vite build --config vite.config.mts
pnpm exec vitest run src/platform/missingModel/missingModelDownload.test.ts
git diff --check
```

If conflicts happen, expect them around:

- `vite.config.mts`
- `src/platform/distribution/types.ts`
- `src/composables/useFeatureFlags.ts`
- `src/platform/missingModel/missingModelDownload.ts`
- `src/platform/missingModel/missingModelStore.ts`
- `src/platform/missingModel/components/MissingModelCard.vue`
- `src/platform/missingModel/components/MissingModelRow.vue`

Preserve the `DISTRIBUTION=jarvis` and `jarvis_model_downloads` gates. Do not
make server-side model downloads active for generic `localhost` or `cloud`
builds.

## Deploying To Jarvis Labs

Build with the Jarvis distribution flag:

```bash
export PATH=/home/node/bin:$PATH
cd /home/ComfyUI_frontend
DISTRIBUTION=jarvis GENERATE_SOURCEMAP=false pnpm exec vite build --config vite.config.mts
```

ComfyUI should be started with:

```bash
cd /home/ComfyUI
exec /home/comfyui-venv/bin/python main.py --listen 0.0.0.0 --port 6006 --front-end-root /home/ComfyUI_frontend/dist
```

After frontend-only changes, a backend restart is usually not required if
ComfyUI is already serving `/home/ComfyUI_frontend/dist`; a hard browser
refresh is enough.
