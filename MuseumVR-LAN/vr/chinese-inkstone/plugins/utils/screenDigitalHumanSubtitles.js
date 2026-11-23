// Ported from pre-view/src/utils/screenDigitalHumanSubtitles.js for the standalone download player.
(function () {
"use strict";
const subtitleCache = new Map();

function decodeScreenDigitalHumanSubtitleReference(value) {
  const raw = String(value || "");
  if (!raw) return { id: "", name: "" };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return { id: parsed.id == null ? "" : String(parsed.id), name: String(parsed.name || "") };
  } catch (error) {
    // 兼容早期直接保存文件名的数据。
  }
  return { id: "", name: raw };
}

function parseTimestamp(value) {
  const parts = String(value || "").trim().replace(",", ".").split(":").map(Number);
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return null;
  return parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function normalizeCueText(value) {
  return String(value || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\{\\[^}]+\}/g, "").replace(/\\[Nn]/g, "\n").trim();
}

function parseTimedText(content) {
  return String(content || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/^WEBVTT[^\n]*\n/i, "")
    .split(/\n{2,}/).map((block) => {
      const lines = block.split("\n").map((line) => line.trimEnd());
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) return null;
      const timing = lines[timingIndex].split("-->");
      const start = parseTimestamp(timing[0]);
      const end = parseTimestamp(String(timing[1] || "").trim().split(/\s+/)[0]);
      const text = normalizeCueText(lines.slice(timingIndex + 1).join("\n"));
      return start == null || end == null || end <= start || !text ? null : { start, end, text };
    }).filter(Boolean);
}

function parseAss(content) {
  let inEvents = false;
  let fields = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
  const cues = [];
  String(content || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (/^\[events\]$/i.test(trimmed)) { inEvents = true; return; }
    if (/^\[.+\]$/.test(trimmed)) { inEvents = false; return; }
    if (!inEvents) return;
    if (/^format\s*:/i.test(trimmed)) { fields = trimmed.replace(/^format\s*:/i, "").split(",").map((field) => field.trim().toLowerCase()); return; }
    if (!/^dialogue\s*:/i.test(trimmed)) return;
    const values = trimmed.replace(/^dialogue\s*:/i, "").split(",");
    const fixed = values.length <= fields.length ? values : values.slice(0, fields.length - 1).concat(values.slice(fields.length - 1).join(","));
    const start = parseTimestamp(fixed[fields.indexOf("start")]);
    const end = parseTimestamp(fixed[fields.indexOf("end")]);
    const text = normalizeCueText(fixed[fields.indexOf("text")]);
    if (start != null && end != null && end > start && text) cues.push({ start, end, text });
  });
  return cues;
}

function parseScreenDigitalHumanSubtitles(content, fileName = "") {
  const extension = String(fileName).split(".").pop().toLowerCase();
  const cues = extension === "ass" || extension === "ssa" || /\[events\]/i.test(content) ? parseAss(content) : parseTimedText(content);
  return cues.sort((a, b) => a.start - b.start).slice(0, 10000);
}

function loadScreenDigitalHumanSubtitles(path, fileName = "") {
  if (!path) return Promise.resolve([]);
  const cacheKey = `${path}|${fileName}`;
  if (subtitleCache.has(cacheKey)) return subtitleCache.get(cacheKey);
  const request = fetch(path).then((response) => {
    if (!response.ok) throw new Error(`字幕文件加载失败：${response.status}`);
    return response.text();
  }).then((content) => {
    if (content.includes("\uFFFD")) throw new Error("字幕文件需使用 UTF-8 编码");
    const cues = parseScreenDigitalHumanSubtitles(content, fileName);
    if (!cues.length) throw new Error("字幕文件中没有可识别的时间轴内容");
    return cues;
  }).catch((error) => { subtitleCache.delete(cacheKey); throw error; });
  subtitleCache.set(cacheKey, request);
  return request;
}

window.ScreenDigitalHumanSubtitles = { decodeScreenDigitalHumanSubtitleReference, parseScreenDigitalHumanSubtitles, loadScreenDigitalHumanSubtitles };
})();
