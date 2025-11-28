importScripts("https://cdn.jsdelivr.net/npm/jsqr/dist/jsQR.js");

self.onmessage = (e) => {
    const { data, width, height } = e.data;
    const result = jsQR(data, width, height);
    self.postMessage(result);
};