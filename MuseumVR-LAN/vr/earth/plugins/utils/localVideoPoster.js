// Downloaded videos are ordinary local files: OSS snapshot query strings cannot render images.
(function () {
  'use strict';
  const fallback = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270"><rect width="480" height="270" fill="#20242b"/><circle cx="240" cy="135" r="34" fill="#ffffff" fill-opacity=".2"/><path d="M231 115L259 135L231 155Z" fill="white"/></svg>'
  );
  const state = window.Vue.observable({ posters: {} });
  const requests = new Map();
  const queue = [];
  let running = 0;

  function sourceKey(source) {
    if (!source) return '';
    try {
      const url = new URL(source, document.baseURI);
      if (!['http:', 'https:', 'file:', 'blob:'].includes(url.protocol)) return '';
      // Also accept legacy callers that already appended the OSS transformation.
      url.searchParams.delete('x-oss-process');
      return url.href;
    } catch (error) {
      return '';
    }
  }

  function capture(source) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      let done = false;
      let targetTime = null;
      const finish = (poster) => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        video.onloadedmetadata = video.onloadeddata = video.onseeked = video.onerror = null;
        video.removeAttribute('src');
        video.load(); // Release the decoder and any in-flight media request.
        resolve(poster);
      };
      const timer = window.setTimeout(() => finish(''), 15000);
      const draw = () => {
        if (done || targetTime === null || video.seeking || video.readyState < 2) return;
        // Static servers without byte-range support can clamp a seek back to zero.
        // The decoded frame is still a valid offline poster; do not wait forever for exactly 1s.
        if (!video.videoWidth || !video.videoHeight) return;
        try {
          const canvas = document.createElement('canvas');
          const scale = Math.min(1, 480 / video.videoWidth, 480 / video.videoHeight);
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          const context = canvas.getContext('2d');
          if (!context) { finish(''); return; }
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          finish(canvas.toDataURL('image/jpeg', 0.8));
        } catch (error) {
          // Unsupported media or a server without CORS still gets a usable play placeholder.
          finish('');
        }
      };
      video.muted = true;
      video.preload = 'auto';
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      // Same-origin HTTP and file exports do not need a CORS-enabled request.
      if (/^https?:/.test(source) && new URL(source).origin !== new URL(document.baseURI).origin) {
        video.crossOrigin = 'anonymous';
      }
      video.onloadedmetadata = () => {
        if (!Number.isFinite(video.duration) || video.duration <= 0) { finish(''); return; }
        targetTime = Math.min(1, video.duration / 2);
        try { video.currentTime = targetTime; } catch (error) { finish(''); }
      };
      video.onloadeddata = draw;
      video.onseeked = draw;
      video.onerror = () => finish('');
      video.src = source;
      video.load(); // Never call play(): thumbnail generation must not play audio.
    });
  }

  function drain() {
    while (running < 2 && queue.length) {
      const job = queue.shift();
      running++;
      capture(job.key).catch(() => '').then((poster) => {
        // Vue renders <img> and bound poster attributes again when the frame is ready.
        window.Vue.set(state.posters, job.key, poster);
        job.resolve(poster);
        running--;
        drain();
      });
    }
  }

  function request(key) {
    if (!key) return Promise.resolve('');
    if (!requests.has(key)) {
      const promise = new Promise((resolve) => queue.push({ key, resolve }));
      requests.set(key, promise);
      drain();
    }
    return requests.get(key);
  }

  function get(source, placeholder = fallback) {
    const key = sourceKey(source);
    const poster = state.posters[key];
    request(key);
    return poster || placeholder;
  }

  function apply(video) {
    const key = sourceKey(video.currentSrc || video.src);
    if (!key) return;
    const existing = video.getAttribute('poster');
    if (existing && !existing.includes('x-oss-process=')) return;
    video.poster = get(key);
    const pendingPoster = video.poster;
    request(key).then((poster) => {
      if (poster && sourceKey(video.currentSrc || video.src) === key && video.poster === pendingPoster) {
        video.poster = poster;
      }
    });
  }

  window.DownloadVideoPoster = { get, apply };
})();
