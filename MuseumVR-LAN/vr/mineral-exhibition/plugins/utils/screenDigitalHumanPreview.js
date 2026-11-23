// Ported from pre-view/src/utils/screenDigitalHumanPreview.js for the standalone download player.
(function () {
"use strict";
const { decodeScreenDigitalHumanSubtitleReference, loadScreenDigitalHumanSubtitles } = window.ScreenDigitalHumanSubtitles;
const { aiMediaCoordinator, registerKrpanoMedia, unregisterKrpanoMedia } = window.ScreenDigitalHumanMedia;

const DIGITAL_HUMAN_IMPLANT_TYPE = 8;

const HOTSPOT_PREFIX = "screen_digital_human_";
const VIDEO_PLAYER_URL = "plugins/jy-config/videoplayer.js";
const activeHotspotNames = new Set();
const sourceKeys = new Map();
const previewData = new Map();
const subtitleOverlays = new Map();
const controlOverlays = new Map();
const userGesturePlayHandlers = new Map();
let subtitleInterval = 0;
let activePreviewDevice = "pc";

function getKrpano() {
  return typeof window !== "undefined" ? window.krpano : null;
}

function emitPanorama(eventName, payload) {
  if (window.Panorama && typeof window.Panorama.emit === "function") window.Panorama.emit(eventName, payload);
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function getHotspotName(id) {
  return HOTSPOT_PREFIX + String(id).replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}

function getCurrentSceneName() {
  const krpano = getKrpano();
  return krpano && krpano.xml ? krpano.xml.scene : "";
}

function getMediaHandle(hotspot) {
  const name = hotspot.name;
  return registerKrpanoMedia(hotspot, {
    sceneId: getCurrentSceneName(), getSceneId: getCurrentSceneName,
    instance: sourceKeys.get(name) || hotspot.videourl,
    isCurrent: () => Boolean(getKrpano() && getKrpano().get(`hotspot[${name}]`) === hotspot),
  });
}

function getChromakey(particulars = {}) {
  const color = String(particulars.color || "#00FF00").replace("#", "").toUpperCase();
  return `0x${color}|${clamp(particulars.threshold, 0, 1, 0.29)}|${clamp(particulars.smoothness, 0, 1, 0.13)}`;
}

function getVideoRatio(hotspot, data) {
  const liveRatio = Number(hotspot.videowidth) / Number(hotspot.videoheight);
  const savedRatio = clamp(data.particulars && data.particulars.aspectRatio, 0.1, 10, 16 / 9);
  return clamp(liveRatio, 0.1, 10, savedRatio);
}

function isScreenDigitalHuman(data) {
  return Boolean(data && Number(data.implantType) === DIGITAL_HUMAN_IMPLANT_TYPE);
}

function getScreenDigitalHumanPreviewHotspot(id) {
  const krpano = getKrpano();
  return krpano && id != null ? krpano.get(`hotspot[${getHotspotName(id)}]`) : null;
}

function setScreenDigitalHumanPreviewDevice(device) {
  activePreviewDevice = device === "mobile" ? "mobile" : "pc";
}

function syncScreenDigitalHumanRuntimeDevice() {
  const krpano = getKrpano();
  const isMobile = Boolean(krpano && krpano.device && krpano.device.mobile) || window.innerWidth < window.innerHeight;
  setScreenDigitalHumanPreviewDevice(isMobile ? "mobile" : "pc");
}

function resolveScreenDigitalHumanLayout(data, device = activePreviewDevice) {
  const position = data.position || {};
  const particulars = data.particulars || {};
  const pc = {
    x: clamp(position.ath, 0, 100, 50),
    y: clamp(position.atv, 0, 100, 50),
    scale: clamp(particulars.scale, 10, 80, 26),
  };
  const mobile = Array.isArray(data.positionList) ? data.positionList[0] : null;
  if (device !== "mobile" || !mobile) return pc;
  return {
    x: clamp(mobile.x, 0, 100, pc.x),
    y: clamp(mobile.y, 0, 100, pc.y),
    scale: clamp(mobile.z, 10, 80, pc.scale),
  };
}

function isScreenDigitalHumanAppliedToScene(data, sceneName = getCurrentSceneName()) {
  const scenes = Array.isArray(data && data.scenes) ? data.scenes : [];
  return isScreenDigitalHuman(data) && (scenes.length === 0 || Boolean(sceneName && scenes.includes(sceneName)));
}

function toRgba(color, opacity, fallback) {
  const normalized = String(color || fallback).replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return fallback;
  const alpha = clamp(opacity, 0, 100, 100) / 100;
  return `rgba(${parseInt(normalized.slice(0, 2), 16)}, ${parseInt(normalized.slice(2, 4), 16)}, ${parseInt(normalized.slice(4, 6), 16)}, ${alpha})`;
}

function removeSubtitleOverlayByName(name) {
  const record = subtitleOverlays.get(name);
  if (!record) return;
  if (record.element.parentNode) record.element.parentNode.removeChild(record.element);
  subtitleOverlays.delete(name);
  if (!subtitleOverlays.size && subtitleInterval) {
    window.clearInterval(subtitleInterval);
    subtitleInterval = 0;
  }
}

function runSubtitleLoop() {
  const krpano = getKrpano();
  subtitleOverlays.forEach((record, name) => {
    const hotspot = krpano && krpano.get(`hotspot[${name}]`);
    if (!hotspot) {
      removeSubtitleOverlayByName(name);
      return;
    }
    const time = Number(hotspot.time != null ? hotspot.time : hotspot.videoDOM && hotspot.videoDOM.currentTime);
    const text = Number.isFinite(time)
      ? record.cues.filter((cue) => time >= cue.start && time <= cue.end).map((cue) => cue.text).join("\n")
      : "";
    if (text === record.currentText) return;
    record.currentText = text;
    record.textElement.textContent = text;
    record.textElement.style.display = text ? "inline-block" : "none";
  });
}

function createSubtitleOverlay(name) {
  const host = document.querySelector("#pano");
  if (!host) return null;
  const element = document.createElement("div");
  const textElement = document.createElement("span");
  Object.assign(element.style, {
    position: "absolute", zIndex: "52", display: "flex", alignItems: "flex-end", justifyContent: "center",
    boxSizing: "border-box", paddingBottom: "5%", pointerEvents: "none", transform: "translate(-50%, -50%)",
  });
  Object.assign(textElement.style, {
    display: "none", maxWidth: "92%", padding: "4px 10px", borderRadius: "3px", lineHeight: "1.45",
    textAlign: "center", whiteSpace: "pre-line", wordBreak: "break-word", textShadow: "0 1px 2px rgba(0, 0, 0, 0.8)",
  });
  element.appendChild(textElement);
  host.appendChild(element);
  const record = { element, textElement, sourceKey: "", cues: [], currentText: "", loadToken: 0 };
  subtitleOverlays.set(name, record);
  if (!subtitleInterval) subtitleInterval = window.setInterval(runSubtitleLoop, 150);
  return record;
}

function syncSubtitleOverlay(name, hotspot, data, layout) {
  const textSet = data.textSet || {};
  const path = textSet.endImgPath || "";
  if (!path) {
    removeSubtitleOverlayByName(name);
    return;
  }
  const record = subtitleOverlays.get(name) || createSubtitleOverlay(name);
  if (!record) return;
  Object.assign(record.element.style, {
    left: `${layout.x}%`, top: `${layout.y}%`, width: `${layout.scale}%`, aspectRatio: String(getVideoRatio(hotspot, data)),
  });
  Object.assign(record.textElement.style, {
    color: toRgba(textSet.fontColor, textSet.fontColorOpacity, "#FFFFFF"),
    backgroundColor: toRgba(textSet.bgColor, textSet.bgColorOpacity, "#000000"),
    fontSize: `${activePreviewDevice === "mobile" ? 14 : 16}px`,
  });
  const subtitleName = decodeScreenDigitalHumanSubtitleReference(textSet.endImgId).name;
  const sourceKey = `${path}|${subtitleName}`;
  if (sourceKey === record.sourceKey) return;
  record.sourceKey = sourceKey;
  record.cues = [];
  record.currentText = "";
  record.textElement.textContent = "";
  record.textElement.style.display = "none";
  const loadToken = ++record.loadToken;
  loadScreenDigitalHumanSubtitles(path, subtitleName)
    .then((cues) => {
      if (subtitleOverlays.has(name) && record.loadToken === loadToken) record.cues = cues;
    })
    .catch((error) => console.warn("屏幕数字人字幕加载失败", error));
}

function togglePlayback(name) {
  const krpano = getKrpano();
  const hotspot = krpano && krpano.get(`hotspot[${name}]`);
  const data = previewData.get(name);
  if (!hotspot || !data || data.isLock) return;
  // A manual decision supersedes the pending page-wide autoplay retry.
  removeUserGesturePlayback(name);
  getMediaHandle(hotspot).toggle({ manual: true });
  hotspot.isuserplay = !hotspot.ispaused;
}

function createControlOverlay(name) {
  const host = document.querySelector("#pano");
  if (!host) return null;
  const element = document.createElement("div");
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "播放屏幕数字人");
  button.textContent = "▶";
  Object.assign(element.style, {
    position: "absolute", zIndex: "51", display: "flex", alignItems: "center", justifyContent: "center",
    transform: "translate(-50%, -50%)", boxSizing: "border-box", background: "transparent",
  });
  Object.assign(button.style, {
    width: "52px", height: "52px", padding: "0 0 0 4px", border: "0", borderRadius: "50%",
    background: "rgba(0, 0, 0, 0.58)", color: "#fff", fontSize: "24px", lineHeight: "52px",
    cursor: "pointer", boxShadow: "0 1px 5px rgba(0, 0, 0, 0.35)",
  });
  element.appendChild(button);
  element.addEventListener("pointerdown", (event) => event.stopPropagation());
  element.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    togglePlayback(name);
  });
  host.appendChild(element);
  const record = { element, button };
  controlOverlays.set(name, record);
  return record;
}

function updateControlOverlay(name) {
  const krpano = getKrpano();
  const hotspot = krpano && krpano.get(`hotspot[${name}]`);
  const data = previewData.get(name);
  const record = controlOverlays.get(name);
  if (!record || !hotspot || !data) return;
  const isLocked = data.isLock === true;
  record.element.style.pointerEvents = isLocked ? "none" : "auto";
  record.element.style.cursor = isLocked ? "default" : "pointer";
  record.button.style.display = hotspot.ispaused && data.isHidePauseButton !== true && !isLocked ? "block" : "none";
}

function syncControlOverlay(name, hotspot, data, layout) {
  const record = controlOverlays.get(name) || createControlOverlay(name);
  if (!record) return;
  Object.assign(record.element.style, {
    left: `${layout.x}%`, top: `${layout.y}%`, width: `${layout.scale}%`, aspectRatio: String(getVideoRatio(hotspot, data)),
  });
  updateControlOverlay(name);
}

function removeControlOverlayByName(name) {
  const record = controlOverlays.get(name);
  if (!record) return;
  if (record.element.parentNode) record.element.parentNode.removeChild(record.element);
  controlOverlays.delete(name);
}

function applyScreenLayout(hotspot, data) {
  const layout = resolveScreenDigitalHumanLayout(data);
  Object.assign(hotspot, {
    renderer: "webgl", distorted: true, flying: 1, scaleflying: true, camroll: false,
    align: `${layout.x / 100}|${layout.y / 100}`, edge: "center", ox: 0, oy: 0, ath: 0, atv: 0,
    width: `${layout.scale}%`, height: "prop", scale: 1, zoom: false, depthbuffer: false, keep: true,
    visible: data.isShow !== false, enabled: false, capture: false, handcursor: false, zorder: 50,
    chromakey: getChromakey(data.particulars || {}),
  });
  return layout;
}

function applyRuntimePlayback(hotspot, data) {
  Object.assign(hotspot, {
    videourl: data.videoPath, posterurl: data.videoPosterPath || "",
    pausedonstart: data.isAutoPlay === false || aiMediaCoordinator.isCategoryPaused("hotspotAudio"),
    loop: data.isLoop !== false, muted: data.isMute !== false, volume: data.isMute === false ? 1 : 0,
    autopause: true, autoresume: true, playsinline: true, html5controls: false,
    // The DOM overlay owns the gesture. The plugin's body mousedown/touchend
    // recovery would otherwise play before our click toggles it back to pause.
    userinteractionworkarounds: false,
  });
}

function pauseConfiguredAudio(data) {
  if (data.isCloseBgm) emitPanorama("pause_music");
  if (data.isCloseExplain) emitPanorama("pause_voice");
}

function restoreConfiguredAudio(data) {
  emitPanorama("is_implant_play");
  if (data.isCloseBgm && !(window.isImplantPlay && window.isImplantPlay[0])) emitPanorama("play_music");
  if (data.isCloseExplain && !(window.isImplantPlay && window.isImplantPlay[1])) emitPanorama("play_voice");
}

function enableUserGesturePlayback(name, hotspot) {
  if (userGesturePlayHandlers.has(name)) return;
  const handler = () => {
    userGesturePlayHandlers.delete(name);
    const data = previewData.get(name);
    if (data && data.isAutoPlay !== false && getKrpano() && getKrpano().get(`hotspot[${name}]`) === hotspot
        && typeof hotspot.play === "function") getMediaHandle(hotspot).play();
  };
  userGesturePlayHandlers.set(name, handler);
  window.addEventListener("pointerdown", handler, { once: true });
}

function removeUserGesturePlayback(name) {
  const handler = userGesturePlayHandlers.get(name);
  if (handler) window.removeEventListener("pointerdown", handler);
  userGesturePlayHandlers.delete(name);
}

function removePreviewByName(name) {
  const krpano = getKrpano();
  const hotspot = krpano && krpano.get(`hotspot[${name}]`);
  const data = previewData.get(name);
  const wasPlaying = hotspot && hotspot.ispaused === false;
  unregisterKrpanoMedia(hotspot);
  if (hotspot && typeof hotspot.closevideo === "function") {
    try {
      hotspot.closevideo();
    } catch (error) {
      // 插件卸载时也会释放视频资源。
    }
  }
  if (hotspot && krpano.actions && typeof krpano.actions.removehotspot === "function") krpano.actions.removehotspot(name);
  removeUserGesturePlayback(name);
  activeHotspotNames.delete(name);
  sourceKeys.delete(name);
  previewData.delete(name);
  removeSubtitleOverlayByName(name);
  removeControlOverlayByName(name);
  if (wasPlaying && data) restoreConfiguredAudio(data);
}

function removeScreenDigitalHumanPreview(id) {
  if (id != null) removePreviewByName(getHotspotName(id));
}

function removeAllScreenDigitalHumanPreviews() {
  new Set([...activeHotspotNames, ...subtitleOverlays.keys(), ...controlOverlays.keys()]).forEach(removePreviewByName);
}

function syncScreenDigitalHumanPreview(data) {
  const krpano = getKrpano();
  if (!krpano || !isScreenDigitalHuman(data) || data.id == null) return;
  if (!data.videoPath || data.isShow === false || !isScreenDigitalHumanAppliedToScene(data)) {
    removeScreenDigitalHumanPreview(data.id);
    return;
  }

  const name = getHotspotName(data.id);
  let hotspot = krpano.get(`hotspot[${name}]`);
  const isNew = !hotspot;
  if (!hotspot && krpano.actions && typeof krpano.actions.addhotspot === "function") hotspot = krpano.actions.addhotspot(name);
  if (!hotspot) return;

  activeHotspotNames.add(name);
  previewData.set(name, data);
  const layout = applyScreenLayout(hotspot, data);
  applyRuntimePlayback(hotspot, data);
  syncSubtitleOverlay(name, hotspot, data, layout);
  syncControlOverlay(name, hotspot, data, layout);

  const sourceKey = `${data.videoPath}|${data.videoPosterPath || ""}`;
  if (isNew) {
    sourceKeys.set(name, sourceKey);
    getMediaHandle(hotspot);
    hotspot.isuserplay = false;
    if (typeof hotspot.addevent === "function") {
      hotspot.addevent("onloaded", () => {
        const currentData = previewData.get(name);
        updateControlOverlay(name);
        if (!currentData || currentData.isAutoPlay === false) return;
        if (hotspot.muted && typeof hotspot.play === "function") getMediaHandle(hotspot).play();
        else enableUserGesturePlayback(name, hotspot);
      });
      hotspot.addevent("onvideoready", () => {
        const currentData = previewData.get(name);
        if (!currentData) return;
        const currentLayout = resolveScreenDigitalHumanLayout(currentData);
        syncSubtitleOverlay(name, hotspot, currentData, currentLayout);
        syncControlOverlay(name, hotspot, currentData, currentLayout);
      });
      hotspot.addevent("onvideoplay", () => {
        const mediaHandle = getMediaHandle(hotspot);
        mediaHandle.notifyPlaying();
        if (mediaHandle.isBlocked()) return;
        const currentData = previewData.get(name);
        updateControlOverlay(name);
        if (currentData) pauseConfiguredAudio(currentData);
      });
      hotspot.addevent("onvideopaused", () => {
        const currentData = previewData.get(name);
        updateControlOverlay(name);
        if (aiMediaCoordinator.isCategoryPaused("hotspotAudio")) return;
        if (currentData) restoreConfiguredAudio(currentData);
      });
      hotspot.addevent("onvideocomplete", () => {
        const currentData = previewData.get(name);
        updateControlOverlay(name);
        if (currentData && currentData.isLoop === false) restoreConfiguredAudio(currentData);
      });
      hotspot.addevent("onneeduserinteraction", () => {
        getMediaHandle(hotspot).reportPlayBlocked();
        enableUserGesturePlayback(name, hotspot);
      });
    }
    hotspot.url = VIDEO_PLAYER_URL;
  } else if (sourceKeys.get(name) !== sourceKey) {
    sourceKeys.set(name, sourceKey);
    getMediaHandle(hotspot).invalidate();
    if (typeof hotspot.playvideo === "function") {
      hotspot.playvideo(data.videoPath, data.videoPosterPath || "", hotspot.pausedonstart, 0);
    } else {
      hotspot.url = VIDEO_PLAYER_URL;
    }
  } else {
    // A kept overlay entering another scene is a new playback registration, even with the same URL.
    getMediaHandle(hotspot);
  }
}

function rebuildScreenDigitalHumanPreviews(implantList) {
  const desired = new Set();
  (implantList || []).forEach((data) => {
    if (!isScreenDigitalHuman(data)) return;
    if (data.id != null && data.videoPath && data.isShow !== false && isScreenDigitalHumanAppliedToScene(data)) {
      desired.add(getHotspotName(data.id));
    }
    syncScreenDigitalHumanPreview(data);
  });
  [...activeHotspotNames].forEach((name) => {
    if (!desired.has(name)) removePreviewByName(name);
  });
}

// Download pages use classic scripts and project.json instead of the preview Vue store.
function syncRuntime() {
  if (!getKrpano()) return;
  syncScreenDigitalHumanRuntimeDevice();
  rebuildScreenDigitalHumanPreviews(window.hideImplant ? [] : (window.jydata && window.jydata.implantList) || []);
}

function toggleDialogPause(isPlay) {
  if (isPlay) aiMediaCoordinator.releasePause("implant-dialog");
  else aiMediaCoordinator.acquirePause("implant-dialog", ["hotspotAudio"]);
}

function destroy() {
  window.removeEventListener("resize", syncRuntime);
  window.removeEventListener("pagehide", destroy);
  removeAllScreenDigitalHumanPreviews();
  aiMediaCoordinator.clear();
}

function init() {
  // addEventListener deduplicates the same callback when the page is initialized again.
  window.addEventListener("resize", syncRuntime);
  window.addEventListener("pagehide", destroy);
  syncRuntime();
}

window.ScreenDigitalHuman = { DIGITAL_HUMAN_IMPLANT_TYPE, isScreenDigitalHuman, getScreenDigitalHumanPreviewHotspot, setScreenDigitalHumanPreviewDevice, syncScreenDigitalHumanRuntimeDevice, resolveScreenDigitalHumanLayout, isScreenDigitalHumanAppliedToScene, removeScreenDigitalHumanPreview, removeAllScreenDigitalHumanPreviews, syncScreenDigitalHumanPreview, rebuildScreenDigitalHumanPreviews, syncRuntime, toggleDialogPause, init, destroy };
})();
