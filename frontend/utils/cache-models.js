// ==========================================================================
// cache-models.js — STAND-IN. js/student.js calls cacheModelsFromManifest();
// if your project already has its own utils/cache-models.js, keep yours and
// ignore this file.
//
// This version fetches every file listed in the manifest once, so the browser
// HTTP cache is warm before faceapi.nets.*.loadFromUri() asks for them. It
// accepts a manifest that is either ["a.json", "b-shard1"] or
// { "files": [...] } — adjust if yours differs.
// ==========================================================================

window.cacheModelsFromManifest = async function (manifestUrl) {
  try {
    const res = await fetch(manifestUrl);
    if (!res.ok) return;

    const manifest = await res.json();
    const files = Array.isArray(manifest) ? manifest : manifest.files || [];
    const base = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);

    await Promise.all(
      files.map(file => {
        const url = /^(https?:)?\//.test(file) ? file : base + file;
        return fetch(url, { cache: 'force-cache' }).catch(() => {});
      }),
    );
  } catch (err) {
    console.warn('Model pre-caching skipped:', err);
  }
};
