// Ported from pre-view/src/utils/aiMediaCoordinator.js for the standalone download player.
(function () {
"use strict";
// Only explicitly registered project media participates. AI audio/video is never registered.
const AI_MEDIA_CATEGORIES = ["backgroundMusic", "backgroundNarration", "hotspotAudio"];

function pauseExemptions(value) {
  const values = Array.isArray(value) || value instanceof Set ? Array.from(value) : [];
  return new Set(values.filter((reason) => typeof reason === "string" && reason));
}

function createAiMediaCoordinator() {
  const records = new Map();
  const reasons = new Map();
  const listeners = new Set();
  let nextId = 0;

  const blocked = (record) => [...reasons.entries()].some(([reason, categories]) =>
    !record.ignoredPauseReasons.has(reason) && categories.has(record.category));
  const current = (record) => !record.removed && records.get(record.id) === record &&
    (!record.isCurrent || record.isCurrent()) &&
    (!record.getSceneId || record.getSceneId() === record.sceneId);
  const snapshot = (record) => ({ instance: record.getInstance(), manualVersion: record.manualVersion });
  const matches = (record, saved) => Boolean(saved && current(record) && !record.isEnded() &&
    saved.instance === record.getInstance() && saved.manualVersion === record.manualVersion);
  const getPendingResumes = () => [...records.values()]
    .filter((record) => !blocked(record) && matches(record, record.pendingResume))
    .map((record) => ({ id: record.id, category: record.category }));
  const emit = () => listeners.forEach((listener) => listener(getPendingResumes()));

  function pause(record) {
    try { record.pause(); } catch (error) { /* A removed plugin may already be disposing. */ }
  }

  function enforce(record, rememberPlaying = false) {
    if (!current(record)) {
      record.saved = record.pendingResume = null;
      return;
    }
    if (blocked(record) && record.isPlaying()) {
      // Only the transition into a paused category may capture a restoration mark.
      // A newly registered / late-autoplay player did not play before this dialog opened.
      if (rememberPlaying && !record.saved && !record.isEnded()) record.saved = snapshot(record);
      record.pendingResume = null;
      pause(record);
    }
  }

  function performPlay(record, saved = snapshot(record)) {
    if (!matches(record, saved) || blocked(record)) return Promise.resolve(false);
    record.pendingResume = null;
    const attempt = ++record.attempt;
    try {
      // Promise.resolve also handles krpano plugins whose play() returns undefined.
      return Promise.resolve(record.play()).then(() => {
        if (!current(record) || attempt !== record.attempt) return false;
        enforce(record); // The dialog could open while an asynchronous play() was pending.
        emit();
        return !blocked(record);
      }, () => {
        if (attempt === record.attempt && matches(record, saved) && !blocked(record)) record.pendingResume = saved;
        emit();
        return false;
      });
    } catch (error) {
      if (matches(record, saved) && !blocked(record)) record.pendingResume = saved;
      emit();
      return Promise.resolve(false);
    }
  }

  function registerMedia(options) {
    const media = options.media;
    if (!media || !AI_MEDIA_CATEGORIES.includes(options.category)) throw new Error("Invalid project media registration");
    const id = options.id || `project-media-${++nextId}`;
    const previous = records.get(id);
    if (previous) previous.handle.unregister();
    const record = {
      id, media, category: options.category, sceneId: options.sceneId,
      ignoredPauseReasons: pauseExemptions(options.ignoredPauseReasons),
      getSceneId: options.getSceneId, isCurrent: options.isCurrent,
      getInstance: options.getInstance || (() => media.currentSrc || media.src || ""),
      isPlaying: options.isPlaying || (() => media.paused === false && !media.ended),
      isEnded: options.isEnded || (() => media.ended === true),
      play: options.play || (() => media.play()), pause: options.pause || (() => media.pause()),
      saved: null, pendingResume: null, manualVersion: 0, attempt: 0, removed: false,
    };
    function invalidate() {
      record.manualVersion++;
      record.attempt++;
      record.saved = record.pendingResume = null;
      emit();
    }
    const handle = {
      play({ manual = false } = {}) {
        if (manual) invalidate();
        if (!current(record) || blocked(record)) { if (current(record)) pause(record); return Promise.resolve(false); }
        // An explicit play can restart a completed video, but a restoration never does.
        if (manual && record.isEnded()) {
          const ended = record.isEnded;
          record.isEnded = () => false;
          const result = performPlay(record);
          record.isEnded = ended;
          return result;
        }
        return performPlay(record);
      },
      pause({ manual = false } = {}) { if (manual) invalidate(); if (current(record)) pause(record); },
      toggle({ manual = true } = {}) {
        if (record.isPlaying()) { handle.pause({ manual }); return Promise.resolve(false); }
        return handle.play({ manual });
      },
      notifyPlaying() {
        if (!current(record)) return;
        record.pendingResume = null;
        enforce(record);
        emit();
      },
      // Legacy krpano plugins consume the native rejection and emit this event instead.
      reportPlayBlocked() {
        if (current(record) && !blocked(record) && !record.isEnded()) record.pendingResume = snapshot(record);
        emit();
      },
      invalidate,
      isBlocked: () => blocked(record),
      isRegistered: () => !record.removed && records.get(id) === record,
      unregister() {
        record.removed = true;
        record.attempt++;
        record.saved = record.pendingResume = null;
        if (records.get(id) === record) records.delete(id);
        if (media.removeEventListener) {
          media.removeEventListener("play", handle.notifyPlaying);
          media.removeEventListener("ended", invalidate);
          media.removeEventListener("emptied", invalidate);
        }
        emit();
      },
    };
    record.handle = handle;
    records.set(id, record);
    if (media.addEventListener) {
      media.addEventListener("play", handle.notifyPlaying);
      media.addEventListener("ended", invalidate);
      media.addEventListener("emptied", invalidate);
    }
    enforce(record);
    return handle;
  }

  function acquirePause(reason, categories) {
    const next = new Set((categories || []).filter((category) => AI_MEDIA_CATEGORIES.includes(category)));
    const previous = reasons.get(reason);
    if (previous && previous.size === next.size && [...next].every((category) => previous.has(category))) return;
    const previouslyBlocked = new Map([...records.values()].map((record) => [record, blocked(record)]));
    reasons.set(reason, next);
    records.forEach((record) => {
      if (blocked(record)) enforce(record, !previouslyBlocked.get(record));
      else restore(record);
    });
    emit();
  }

  function restore(record) {
    const saved = record.saved;
    if (blocked(record)) return;
    record.saved = null;
    if (matches(record, saved)) performPlay(record, saved);
  }

  function releasePause(reason, { resume = true } = {}) {
    const categories = reasons.get(reason);
    if (!categories) return;
    reasons.delete(reason);
    records.forEach((record) => {
      if (!categories.has(record.category) || record.ignoredPauseReasons.has(reason)) return;
      if (!resume) { record.saved = record.pendingResume = null; record.attempt++; }
      else restore(record);
    });
    emit();
  }

  return {
    registerMedia, acquirePause, releasePause, getPendingResumes,
    isCategoryPaused: (category) => [...reasons.values()].some((categories) => categories.has(category)),
    resumeBlocked: () => Promise.all([...records.values()].map((record) =>
      matches(record, record.pendingResume) && !blocked(record) ? performPlay(record, record.pendingResume) : false)),
    subscribe(listener) { listeners.add(listener); listener(getPendingResumes()); return () => listeners.delete(listener); },
    prune() { records.forEach((record) => { if (!current(record)) record.handle.unregister(); }); },
    clear({ resume = false } = {}) {
      [...reasons.keys()].forEach((reason) => releasePause(reason, { resume }));
      if (!resume) records.forEach((record) => record.handle.unregister());
    },
  };
}

const aiMediaCoordinator = createAiMediaCoordinator();

const krpanoMedia = new WeakMap();
// Register only a known implant / hotspot plugin, never scan the panorama DOM.
function registerKrpanoMedia(media, { sceneId, getSceneId, isCurrent, instance, ignoredPauseReasons } = {}) {
  if (!media) return null;
  const previous = krpanoMedia.get(media);
  const source = instance == null ? media.videourl : instance;
  const ignored = pauseExemptions(ignoredPauseReasons);
  const sameExemptions = previous && previous.ignored.size === ignored.size && [...ignored].every((reason) => previous.ignored.has(reason));
  if (previous && previous.handle.isRegistered() && previous.sceneId === sceneId && previous.source === source && sameExemptions) return previous.handle;
  if (previous) previous.handle.unregister();
  const handle = aiMediaCoordinator.registerMedia({
    media, category: "hotspotAudio", sceneId, getSceneId, isCurrent, ignoredPauseReasons: ignored,
    getInstance: () => media.videourl,
    isPlaying: () => media.ispaused === false && media.iscomplete !== true,
    isEnded: () => media.iscomplete === true || Boolean(media.videoDOM && media.videoDOM.ended),
    play: () => typeof media.play === "function" ? media.play() : undefined,
    pause: () => { if (typeof media.pause === "function") media.pause(); },
  });
  krpanoMedia.set(media, { sceneId, source, ignored, handle });
  return handle;
}

function unregisterKrpanoMedia(media) {
  const record = media && krpanoMedia.get(media);
  if (record) record.handle.unregister();
  if (media) krpanoMedia.delete(media);
}

window.ScreenDigitalHumanMedia = { AI_MEDIA_CATEGORIES, createAiMediaCoordinator, aiMediaCoordinator, registerKrpanoMedia, unregisterKrpanoMedia };
})();
