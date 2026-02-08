"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { AssistantReply, AnalysisTimeline, ProjectClip, ProjectTimeline } from "../../lib/types";
import { projectClipOffsets, projectDurationSeconds, splitProjectClipAt, trimProjectTimelineToTargetSeconds } from "../../lib/timeline";

type ExportSettings = {
  resolution: "720p" | "1080p" | "4K";
  format: "MP4";
};

const DEFAULT_EXPORT: ExportSettings = { resolution: "720p", format: "MP4" };

type Asset = {
  assetId: string;
  name: string;
  videoUrl: string;
  durationSeconds: number;
  hasAudio: boolean;
  waveformUrl: string | null;
  analysis: AnalysisTimeline | null;
};

type HistoryState = {
  timeline: ProjectTimeline;
  selectedClipId: string | null;
};

type PendingSeek = {
  expectedSrc: string;
  time: number;
  play: boolean;
};

type DragPayload =
  | { kind: "asset"; assetId: string }
  | { kind: "clip"; clipId: string };

const DRAG_MIME = "application/x-clipgenius-studio";

export default function StudioPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bgVideoRef = useRef<HTMLVideoElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const pendingSeekRef = useRef<PendingSeek | null>(null);
  const switchingRef = useRef(false);
  const currentDragRef = useRef<DragPayload | null>(null);
  const altDownRef = useRef(false);

  const [assets, setAssets] = useState<Asset[]>([]);
  const assetsById = useMemo(() => new Map(assets.map((a) => [a.assetId, a])), [assets]);
  const snapPointsByAssetId = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const a of assets) {
      const pts: number[] = [];
      if (Number.isFinite(a.durationSeconds) && a.durationSeconds > 0) {
        pts.push(0, a.durationSeconds);
      }
      if (a.analysis?.clips?.length) {
        for (const c of a.analysis.clips) {
          if (Number.isFinite(c.start)) pts.push(c.start);
          if (Number.isFinite(c.end)) pts.push(c.end);
        }
      }
      pts.sort((x, y) => x - y);
      // De-dupe (with small epsilon).
      const out: number[] = [];
      const eps = 0.01;
      for (const p of pts) {
        if (out.length === 0 || Math.abs(p - out[out.length - 1]) > eps) out.push(p);
      }
      map.set(a.assetId, out);
    }
    return map;
  }, [assets]);

  const [timeline, setTimeline] = useState<ProjectTimeline>({ projectId: "local", clips: [] });
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  const [playerSrc, setPlayerSrc] = useState<string | null>(null);
  const [timelineZoom, setTimelineZoom] = useState(1.6);
  const [snappingEnabled, setSnappingEnabled] = useState(true);
  const [altDown, setAltDown] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [past, setPast] = useState<HistoryState[]>([]);
  const [future, setFuture] = useState<HistoryState[]>([]);

  const [isExporting, setIsExporting] = useState(false);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSettings, setExportSettings] = useState<ExportSettings>(DEFAULT_EXPORT);

  const [chatInput, setChatInput] = useState("");
  const [chat, setChat] = useState<Array<{ role: "ai" | "user"; text: string }>>([
    { role: "ai", text: "Upload clips and I’ll draft a highlight timeline. Then tell me how to improve it." }
  ]);

  // ---- Preview playback across multiple assets ----
  const previewRef = useRef<{
    enabled: boolean;
    mode: "sequence" | "single";
    idx: number;
    clipId: string | null;
    clipOffset: number;
    stopAtSourceOut: number;
  }>({ enabled: false, mode: "sequence", idx: 0, clipId: null, clipOffset: 0, stopAtSourceOut: 0 });

  const [isPreviewing, setIsPreviewing] = useState(false);
  const [playheadProjectTime, setPlayheadProjectTime] = useState(0);

  const duration = useMemo(() => projectDurationSeconds(timeline), [timeline]);
  const offsets = useMemo(() => projectClipOffsets(timeline), [timeline]);

  const selectedClip = useMemo(() => {
    if (!selectedClipId) return null;
    return timeline.clips.find((c) => c.id === selectedClipId) ?? null;
  }, [timeline, selectedClipId]);

  const selectedAsset = useMemo(() => {
    if (!selectedClip) return null;
    return assetsById.get(selectedClip.assetId) ?? null;
  }, [assetsById, selectedClip]);

  function sanitizeTimelineIfNeeded(t: ProjectTimeline) {
    if (t.clips.length === 0) return t;
    const minLen = 0.2;
    let changed = false;
    const clips = t.clips.map((c) => {
      const asset = assetsById.get(c.assetId);
      const maxOut = asset?.durationSeconds || 0;
      if (!maxOut || !Number.isFinite(maxOut) || maxOut <= 0) return c;

      const sourceIn = clamp(c.sourceIn, 0, Math.max(0, maxOut - minLen));
      const sourceOut = clamp(c.sourceOut, sourceIn + minLen, maxOut);
      if (sourceIn === c.sourceIn && sourceOut === c.sourceOut) return c;
      changed = true;
      return { ...c, sourceIn, sourceOut };
    });
    return changed ? { ...t, clips } : t;
  }

  function makeClipFromAsset(a: Asset): ProjectClip | null {
    if (!a.durationSeconds || !Number.isFinite(a.durationSeconds) || a.durationSeconds <= 0) return null;
    return {
      id: crypto.randomUUID(),
      assetId: a.assetId,
      label: cleanName(a.name),
      sourceIn: 0,
      sourceOut: a.durationSeconds
    };
  }

  function computeInsertIndex(projectTime: number) {
    // Choose insertion index by the closest boundary between clips.
    const t = clamp(projectTime, 0, duration);
    let acc = 0;
    for (let i = 0; i < timeline.clips.length; i++) {
      const c = timeline.clips[i];
      const len = Math.max(0, c.sourceOut - c.sourceIn);
      const start = acc;
      const end = acc + len;
      if (t >= start && t <= end) {
        const before = t - start;
        const after = end - t;
        return before <= after ? i : i + 1;
      }
      acc = end;
    }
    return timeline.clips.length;
  }

  async function insertAssetAtTime(assetId: string, projectTime: number) {
    const a = assetsById.get(assetId);
    if (!a) return;
    const clip = makeClipFromAsset(a);
    if (!clip) return;
    const idx = computeInsertIndex(projectTime);
    const nextClips = [...timeline.clips.slice(0, idx), clip, ...timeline.clips.slice(idx)];
    applyWithHistory({ timeline: { ...timeline, clips: nextClips }, selectedClipId: clip.id });
    await ensurePlayerOnAsset(a, clip.sourceIn, false);
  }

  async function reorderClipToTime(clipId: string, projectTime: number) {
    const fromIdx = timeline.clips.findIndex((c) => c.id === clipId);
    if (fromIdx === -1) return;
    const clip = timeline.clips[fromIdx];
    let toIdx = computeInsertIndex(projectTime);
    // If we're moving forward, removing the clip shifts the target left by 1.
    if (toIdx > fromIdx) toIdx -= 1;
    if (toIdx === fromIdx) return;
    const remaining = timeline.clips.filter((c) => c.id !== clipId);
    const nextClips = [...remaining.slice(0, toIdx), clip, ...remaining.slice(toIdx)];
    applyWithHistory({ timeline: { ...timeline, clips: nextClips }, selectedClipId: clipId });
  }

  function setDragData(e: React.DragEvent, payload: DragPayload) {
    try {
      const raw = JSON.stringify(payload);
      // Safari is picky about custom drag types; provide text/plain fallback.
      e.dataTransfer.setData(DRAG_MIME, raw);
      e.dataTransfer.setData("text/plain", raw);
      e.dataTransfer.effectAllowed = "copyMove";
    } catch {}
  }

  function getDragData(e: React.DragEvent): DragPayload | null {
    try {
      const raw = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData("text/plain");
      if (!raw) return null;
      const parsed = JSON.parse(raw) as DragPayload;
      if (parsed?.kind === "asset" && typeof parsed.assetId === "string") return parsed;
      if (parsed?.kind === "clip" && typeof parsed.clipId === "string") return parsed;
      return null;
    } catch {
      return null;
    }
  }

  function beginDrag(payload: DragPayload) {
    currentDragRef.current = payload;
  }

  function endDrag() {
    currentDragRef.current = null;
  }

  function getCurrentDrag() {
    return currentDragRef.current;
  }

  // Keep the preview synced to the selected timeline clip (when we're not actively previewing playback).
  useEffect(() => {
    if (!selectedClip || !selectedAsset) return;
    if (previewRef.current.enabled) return;
    void ensurePlayerOnAsset(selectedAsset, selectedClip.sourceIn, false);
  }, [selectedClipId, selectedAsset?.assetId]);

  // ---- Undo / redo ----
  function applyWithHistory(next: { timeline: ProjectTimeline; selectedClipId: string | null }) {
    const sanitized = sanitizeTimelineIfNeeded(next.timeline);
    setPast((p) => [...p, { timeline, selectedClipId }].slice(-80));
    setFuture([]);
    setTimeline(sanitized);
    setSelectedClipId(next.selectedClipId);
    setExportUrl(null);
    setExportError(null);
  }

  function undo() {
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      setFuture((f) => [{ timeline, selectedClipId }, ...f].slice(0, 80));
      setTimeline(prev.timeline);
      setSelectedClipId(prev.selectedClipId);
      setExportUrl(null);
      setExportError(null);
      return p.slice(0, -1);
    });
  }

  function redo() {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      setPast((p) => [...p, { timeline, selectedClipId }].slice(-80));
      setTimeline(next.timeline);
      setSelectedClipId(next.selectedClipId);
      setExportUrl(null);
      setExportError(null);
      return f.slice(1);
    });
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;

      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [timeline, selectedClipId]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        altDownRef.current = true;
        setAltDown(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        altDownRef.current = false;
        setAltDown(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // ---- Player helpers ----
  async function ensurePlayerOnAsset(asset: Asset, seekTo: number, play: boolean) {
    const nextSrc = asset.videoUrl;
    pendingSeekRef.current = { expectedSrc: nextSrc, time: seekTo, play };
    setPlayerSrc(nextSrc);

    const v = videoRef.current;
    if (!v) return;
    const bg = bgVideoRef.current;

    // If src already matches, onLoadedMetadata may not fire; seek immediately.
    if (v.currentSrc && v.currentSrc.endsWith(nextSrc)) {
      switchingRef.current = false;
      v.currentTime = clamp(seekTo, 0, Number.isFinite(v.duration) ? v.duration : seekTo);
      if (play) v.play().catch(() => {});
      if (bg) {
        bg.currentTime = clamp(seekTo, 0, Number.isFinite(bg.duration) ? bg.duration : seekTo);
        if (play) bg.play().catch(() => {});
        else bg.pause();
      }
      pendingSeekRef.current = null;
      return;
    }

    // Source swap in progress: some browsers briefly fire pause during swaps.
    switchingRef.current = true;
  }

  function onLoadedMetadata() {
    const v = videoRef.current;
    const pending = pendingSeekRef.current;
    if (!v || !pending) return;

    // Ensure we're acting on the right source.
    if (!v.currentSrc.endsWith(pending.expectedSrc)) return;

    v.currentTime = clamp(pending.time, 0, Number.isFinite(v.duration) ? v.duration : pending.time);
    if (pending.play) v.play().catch(() => {});
    const bg = bgVideoRef.current;
    if (bg) {
      bg.currentTime = clamp(pending.time, 0, Number.isFinite(bg.duration) ? bg.duration : pending.time);
      if (pending.play) bg.play().catch(() => {});
      else bg.pause();
    }
    pendingSeekRef.current = null;
    switchingRef.current = false;
  }

  // ---- Upload / import ----
  async function uploadOne(file: File) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as {
      assetId: string;
      videoUrl: string;
      hasAudio?: boolean;
      waveformUrl?: string | null;
      analysis?: AnalysisTimeline | null;
    };

    const analysis = data.analysis ?? null;
    const durationSeconds = analysis?.durationSeconds ?? 0;

    const asset: Asset = {
      assetId: data.assetId,
      name: file.name || "Untitled",
      videoUrl: data.videoUrl,
      durationSeconds,
      hasAudio: Boolean(data.hasAudio),
      waveformUrl: data.waveformUrl ?? null,
      analysis
    };
    setAssets((prev) => [...prev, asset]);

    // Import should only add to the Library. The user explicitly adds to the timeline.
    setSelectedClipId(null);
    await ensurePlayerOnAsset(asset, 0, false);

    setChat((prev) => [
      ...prev,
      { role: "ai", text: "Imported to Library. Drag it into the timeline (or hit +), then tell me the vibe." }
    ]);
  }

  async function onPickFiles(files?: FileList | null) {
    if (!files || files.length === 0) return;
    setIsUploading(true);
    setUploadError(null);
    setExportUrl(null);
    setExportError(null);
    setPast([]);
    setFuture([]);
    try {
      // Upload sequentially to keep it simple for MVP.
      for (const f of Array.from(files)) {
        // Only accept video for now.
        if (!f.type.startsWith("video/")) continue;
        await uploadOne(f);
      }
    } catch (e: any) {
      setUploadError(e?.message ?? "Upload failed");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // ---- Timeline editing ----
  function deleteSelected() {
    if (!selectedClip) return;
    const remaining = timeline.clips.filter((c) => c.id !== selectedClip.id);
    applyWithHistory({ timeline: { ...timeline, clips: remaining }, selectedClipId: remaining[0]?.id ?? null });
  }

  function splitSelectedAtPlayhead() {
    const v = videoRef.current;
    if (!v || !selectedClip) return;
    const t = v.currentTime || 0;
    const next = splitProjectClipAt(timeline, selectedClip.id, t);
    if (!next) return;
    applyWithHistory({ timeline: next.timeline, selectedClipId: next.newSelectedId });
  }

  function setInToPlayhead() {
    const v = videoRef.current;
    if (!v || !selectedClip) return;
    const maxOut = selectedAsset?.durationSeconds || selectedClip.sourceOut;
    const safeOut = Math.min(selectedClip.sourceOut, maxOut);
    const t = clamp(v.currentTime || 0, 0, safeOut - 0.2);
    const next = updateClipById(timeline, selectedClip.id, { sourceIn: t });
    applyWithHistory({ timeline: next, selectedClipId: selectedClip.id });
  }

  function setOutToPlayhead() {
    const v = videoRef.current;
    if (!v || !selectedClip) return;
    const maxOut = selectedAsset?.durationSeconds || selectedClip.sourceOut;
    const t = clamp(v.currentTime || 0, selectedClip.sourceIn + 0.2, maxOut);
    const next = updateClipById(timeline, selectedClip.id, { sourceOut: Math.max(t, selectedClip.sourceIn + 0.2) });
    applyWithHistory({ timeline: next, selectedClipId: selectedClip.id });
  }

  // ---- AI ----
  async function sendToAssistant(text: string) {
    const userText = text.trim();
    if (!userText) return;

    setChat((prev) => [...prev, { role: "user", text: userText }]);
    setChatInput("");

    const res = await fetch("/api/assistant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: timeline.projectId,
        message: userText,
        timeline
      })
    });

    const data = (await res.json()) as AssistantReply;
    setChat((prev) => [...prev, { role: "ai", text: data.reply }]);

    if (data.operations?.length) {
      let t = timeline;
      for (const op of data.operations) {
        if (op.op === "trim_to_target_seconds") {
          t = trimProjectTimelineToTargetSeconds(t, op.targetSeconds);
        }
      }
      applyWithHistory({ timeline: t, selectedClipId: t.clips[0]?.id ?? null });
    }
  }

  // ---- Export ----
  async function onExport() {
    if (timeline.clips.length === 0) return;
    setIsExporting(true);
    setExportError(null);
    setExportUrl(null);
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assets: assets.map((a) => ({ assetId: a.assetId, videoUrl: a.videoUrl })),
          timeline,
          resolution: exportSettings.resolution,
          format: exportSettings.format
        })
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { exportUrl: string };
      setExportUrl(data.exportUrl);
    } catch (e: any) {
      setExportError(e?.message ?? "Export failed");
    } finally {
      setIsExporting(false);
    }
  }

  async function startClipPlayback(clip: ProjectClip, clipIndex: number, mode: "sequence" | "single") {
    const asset = assetsById.get(clip.assetId);
    if (!asset) return;
    const clipOffset = offsets.get(clip.id) ?? 0;
    setSelectedClipId(clip.id);
    previewRef.current = {
      enabled: true,
      mode,
      idx: clipIndex,
      clipId: clip.id,
      clipOffset,
      stopAtSourceOut: clip.sourceOut
    };
    setIsPreviewing(true);
    setPlayheadProjectTime(clamp(clipOffset, 0, Math.max(0.001, duration)));
    await ensurePlayerOnAsset(asset, clip.sourceIn, true);
  }

  async function previewAll() {
    if (timeline.clips.length === 0) return;
    await startClipPlayback(timeline.clips[0], 0, "sequence");
  }

  function stopPreview() {
    previewRef.current = { enabled: false, mode: "sequence", idx: 0, clipId: null, clipOffset: 0, stopAtSourceOut: 0 };
    setIsPreviewing(false);
    const v = videoRef.current;
    if (v) v.pause();
    const bg = bgVideoRef.current;
    if (bg) bg.pause();
    switchingRef.current = false;
  }

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const epsilon = 0.05;
    const advanceToNext = async () => {
      const state = previewRef.current;
      if (!state.enabled || state.mode !== "sequence") return;
      if (switchingRef.current) return;
      const nextIdx = state.idx + 1;
      const next = timeline.clips[nextIdx];
      if (!next) {
        stopPreview();
        return;
      }
      switchingRef.current = true;
      await startClipPlayback(next, nextIdx, "sequence");
    };

    const onTimeUpdateAsync = async () => {
      const state = previewRef.current;
      if (!state.enabled) {
        // When not in preview mode, map playhead to the currently selected clip (if any).
        if (selectedClipId) {
          const sel = timeline.clips.find((c) => c.id === selectedClipId);
          if (sel) {
            const off = offsets.get(sel.id) ?? 0;
            const within = (v.currentTime || 0) - sel.sourceIn;
            setPlayheadProjectTime(clamp(off + Math.max(0, within), 0, Math.max(0.001, duration)));
          } else {
            setPlayheadProjectTime(0);
          }
        } else {
          setPlayheadProjectTime(0);
        }
        return;
      }

      const clip = timeline.clips[state.idx];
      if (!clip) {
        stopPreview();
        return;
      }

      const within = (v.currentTime || 0) - clip.sourceIn;
      setPlayheadProjectTime(clamp(state.clipOffset + Math.max(0, within), 0, Math.max(0.001, duration)));

      if ((v.currentTime || 0) >= state.stopAtSourceOut - epsilon) {
        if (state.mode === "single") {
          stopPreview();
          return;
        }
        await advanceToNext();
      }
    };

    const onTimeUpdate = () => void onTimeUpdateAsync();
    const onEnded = () => void advanceToNext();
    v.addEventListener("timeupdate", onTimeUpdate);
    v.addEventListener("ended", onEnded);
    return () => {
      v.removeEventListener("ended", onEnded);
      v.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [timeline, duration, offsets, assetsById]);

  // Keep playhead visible while playing through the timeline.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    if (!previewRef.current.enabled) return;
    if (dragRef.current) return;
    const d = Math.max(0.001, duration || 0.001);
    const x = (playheadProjectTime / d) * (el.scrollWidth || el.clientWidth);
    const target = clamp(x - el.clientWidth * 0.35, 0, Math.max(0, (el.scrollWidth || 0) - el.clientWidth));
    el.scrollLeft = target;
  }, [playheadProjectTime, duration, timelineZoom]);

  // ---- Timeline strip drag trimming ----
  const dragRef = useRef<null | {
    clipId: string;
    handle: "in" | "out";
    startX: number;
    startIn: number;
    startOut: number;
    secondsPerPx: number;
    prevState: HistoryState;
    didMove: boolean;
  }>(null);

  function beginTrimDrag(clipId: string, handle: "in" | "out", startX: number) {
    const el = stripRef.current;
    const clip = timeline.clips.find((c) => c.id === clipId);
    if (!el || !clip) return;
    const secondsPerPx = duration / Math.max(1, el.scrollWidth || el.getBoundingClientRect().width);
    dragRef.current = {
      clipId,
      handle,
      startX,
      startIn: clip.sourceIn,
      startOut: clip.sourceOut,
      secondsPerPx,
      prevState: { timeline, selectedClipId },
      didMove: false
    };
  }

  function onTrimMove(clientX: number) {
    const d = dragRef.current;
    if (!d) return;
    const clip = timeline.clips.find((c) => c.id === d.clipId);
    if (!clip) return;
    const asset = assetsById.get(clip.assetId);
    const maxOut = asset?.durationSeconds || Number.POSITIVE_INFINITY;
    const dx = clientX - d.startX;
    const delta = dx * d.secondsPerPx;
    const minLen = 0.2;
    const snapThreshold = clamp(d.secondsPerPx * 10, 0.06, 0.35);
    const snapPoints = snapPointsByAssetId.get(clip.assetId);
    const fg = videoRef.current;
    const playheadSourceTime =
      fg && asset && fg.currentSrc && fg.currentSrc.endsWith(asset.videoUrl) ? Number(fg.currentTime || 0) : null;
    const doSnap = snappingEnabled && !altDownRef.current;

    let nextIn = clip.sourceIn;
    let nextOut = clip.sourceOut;
    const startOutBounded = Math.min(d.startOut, maxOut);
    if (d.handle === "in") {
      nextIn = clamp(d.startIn + delta, 0, startOutBounded - minLen);
      if (doSnap) {
        nextIn = snapWithin(snapPoints, nextIn, snapThreshold, 0, startOutBounded - minLen);
        if (playheadSourceTime != null && Math.abs(playheadSourceTime - nextIn) <= snapThreshold) {
          nextIn = clamp(playheadSourceTime, 0, startOutBounded - minLen);
        }
      }
    }
    if (d.handle === "out") {
      nextOut = clamp(d.startOut + delta, d.startIn + minLen, maxOut);
      if (doSnap) {
        nextOut = snapWithin(snapPoints, nextOut, snapThreshold, d.startIn + minLen, maxOut);
        if (playheadSourceTime != null && Math.abs(playheadSourceTime - nextOut) <= snapThreshold) {
          nextOut = clamp(playheadSourceTime, d.startIn + minLen, maxOut);
        }
      }
    }

    d.didMove = true;
    // Live update without pushing undo history for every tick.
    setTimeline((t) => updateClipById(t, d.clipId, { sourceIn: nextIn, sourceOut: nextOut }));
  }

  function endTrimDrag() {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    if (!d.didMove) return;
    setPast((p) => [...p, d.prevState].slice(-80));
    setFuture([]);
    setExportUrl(null);
    setExportError(null);
  }

  useEffect(() => {
    const onMove = (e: PointerEvent) => onTrimMove(e.clientX);
    const onUp = () => endTrimDrag();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [timeline, duration]);

  // ---- Scrub on strip ----
  async function scrubToProjectTime(projectTime: number, play: boolean) {
    if (timeline.clips.length === 0) return;
    const t = clamp(projectTime, 0, duration);
    setPlayheadProjectTime(t);
    let acc = 0;
    for (let i = 0; i < timeline.clips.length; i++) {
      const c = timeline.clips[i];
      const len = Math.max(0, c.sourceOut - c.sourceIn);
      if (t <= acc + len || i === timeline.clips.length - 1) {
        const within = clamp(t - acc, 0, len);
        const asset = assetsById.get(c.assetId);
        if (!asset) return;
        setSelectedClipId(c.id);
        if (!play) {
          // Scrub/seek without playing — also cancel any active preview sequence.
          previewRef.current = { enabled: false, mode: "sequence", idx: 0, clipId: null, clipOffset: 0, stopAtSourceOut: 0 };
          setIsPreviewing(false);
          const v = videoRef.current;
          if (v) v.pause();
          const bg = bgVideoRef.current;
          if (bg) bg.pause();
          // Avoid reloading sources on every mouse move: seek directly when possible.
          const seekTo = c.sourceIn + within;
          const fg = videoRef.current;
          const bg2 = bgVideoRef.current;
          if (fg && fg.currentSrc && fg.currentSrc.endsWith(asset.videoUrl)) {
            fg.currentTime = clamp(seekTo, 0, Number.isFinite(fg.duration) ? fg.duration : seekTo);
            if (bg2) bg2.currentTime = clamp(seekTo, 0, Number.isFinite(bg2.duration) ? bg2.duration : seekTo);
            return;
          }
          await ensurePlayerOnAsset(asset, seekTo, false);
          return;
        }

        // Click-to-play: start from this point and continue through the rest of the timeline.
        previewRef.current = {
          enabled: true,
          mode: "sequence",
          idx: i,
          clipId: c.id,
          clipOffset: acc,
          stopAtSourceOut: c.sourceOut
        };
        setIsPreviewing(true);
        await ensurePlayerOnAsset(asset, c.sourceIn + within, true);
        return;
      }
      acc += len;
    }
  }

  // ---- UI ----
  return (
    <main className="studio">
      <header className="studioTop" role="banner">
        <div className="filePill">
          <span className={`statusDot ${assets.length ? "on" : ""}`} aria-hidden="true" />
          <div>
            <div className="fileTitle">{assets.length ? "ClipGenius Studio" : "No project yet"}</div>
            <div className="fileSub">{assets.length ? `${assets.length} assets • ${timeline.clips.length} timeline clips` : "Upload clips to start"}</div>
          </div>
        </div>

        <div className="topActions">
          <button className="btn ghost" onClick={undo} disabled={past.length === 0} aria-label="Undo">
            Undo
          </button>
          <button className="btn ghost" onClick={redo} disabled={future.length === 0} aria-label="Redo">
            Redo
          </button>
          <button className="btn ghost" onClick={() => fileInputRef.current?.click()} disabled={isUploading}>
            {isUploading ? "Importing…" : "Import"}
          </button>
          <input
            ref={fileInputRef}
            className="fileInput"
            type="file"
            accept="video/*"
            multiple
            onChange={(e) => onPickFiles(e.target.files)}
          />
        </div>
      </header>

      {uploadError ? <div className="alert" role="alert">{uploadError}</div> : null}

      <section className="shell">
        <aside className="sidebar" aria-label="Library">
          <div className="sideTitle">Library</div>
          <div className="sideNav" role="list">
            <button className="sideItem isActive" type="button" role="listitem">
              Footage
            </button>
            <button className="sideItem" type="button" role="listitem" disabled>
              Audio
            </button>
            <button className="sideItem" type="button" role="listitem" disabled>
              Text
            </button>
            <button className="sideItem" type="button" role="listitem" disabled>
              Effects
            </button>
            <button className="sideItem" type="button" role="listitem" disabled>
              Transitions
            </button>
          </div>

          <div className="sideBin">
            <div className="sideBinHead">
              <div className="sideBinTitle">Clips</div>
              <div className="sideBinMeta">{assets.length ? String(assets.length) : "—"}</div>
            </div>
            <div className="sideBinBody">
              {assets.map((a) => (
                <div key={a.assetId} className="binRow">
                  <button
                    type="button"
                    className="binClip"
                    draggable
                    onDragStart={(e) => {
                      const payload: DragPayload = { kind: "asset", assetId: a.assetId };
                      beginDrag(payload);
                      setDragData(e, payload);
                    }}
                    onDragEnd={endDrag}
                    onClick={() => {
                      // Seek player to start of this asset for preview convenience.
                      ensurePlayerOnAsset(a, 0, false);
                    }}
                    title={a.name}
                  >
                    <div className="binClipTitle">{cleanName(a.name)}</div>
                    <div className="binClipSub">{a.durationSeconds ? fmt(a.durationSeconds) : "—"} • Video</div>
                  </button>
                  <button
                    type="button"
                    className="binAdd"
                    title="Add to timeline"
                    onClick={() => {
                      if (!a.durationSeconds) return;
                      const clip = makeClipFromAsset(a);
                      if (!clip) return;
                      applyWithHistory({ timeline: { ...timeline, clips: [...timeline.clips, clip] }, selectedClipId: clip.id });
                      // Immediately show this clip in the preview (without starting playback).
                      void ensurePlayerOnAsset(a, 0, false);
                    }}
                  >
                    +
                  </button>
                </div>
              ))}
              {assets.length === 0 ? <div className="binEmpty">Import a few clips to start building.</div> : null}
            </div>
          </div>
        </aside>

        <section className="center">
          <section className="playerCard">
            <div className="player">
              <div className="playerViewport" aria-label="Preview">
                {playerSrc ? (
                  <div className="playerStack">
                    <video
                      ref={bgVideoRef}
                      className="bgVideo"
                      src={playerSrc}
                      muted
                      playsInline
                      preload="metadata"
                      aria-hidden="true"
                    />
                    <video
                      ref={videoRef}
                      className="fgVideo"
                      src={playerSrc}
                      controls
                      autoPlay
                      playsInline
                      preload="metadata"
                      onLoadedMetadata={onLoadedMetadata}
                      onTimeUpdate={() => {
                        const fg = videoRef.current;
                        const bg = bgVideoRef.current;
                        if (!fg || !bg) return;
                        if (Math.abs((bg.currentTime || 0) - (fg.currentTime || 0)) > 0.12) {
                          bg.currentTime = fg.currentTime || 0;
                        }
                      }}
                      onPlay={() => {
                        // If the user hits play in the native controls, keep playback in "project timeline" mode.
                        if (!previewRef.current.enabled && timeline.clips.length) {
                          const idx = selectedClipId ? timeline.clips.findIndex((c) => c.id === selectedClipId) : 0;
                          const i = idx >= 0 ? idx : 0;
                          const c = timeline.clips[i];
                          const off = offsets.get(c.id) ?? 0;
                          previewRef.current = {
                            enabled: true,
                            mode: "sequence",
                            idx: i,
                            clipId: c.id,
                            clipOffset: off,
                            stopAtSourceOut: c.sourceOut
                          };
                          setIsPreviewing(true);
                        }
                        bgVideoRef.current?.play().catch(() => {});
                      }}
                      onPause={() => {
                        // Pause should pause timeline playback as well (without resetting state).
                        // During source swaps some browsers briefly pause; don't treat that as a user pause.
                        if (switchingRef.current) return;
                        previewRef.current.enabled = false;
                        setIsPreviewing(false);
                        bgVideoRef.current?.pause();
                      }}
                    />
                  </div>
                ) : (
                  <div className="playerEmpty" aria-label="No video loaded">
                    <div className="bigPlay" aria-hidden="true" />
                  </div>
                )}
              </div>
            </div>

            <div className="toolbar" aria-label="Editing tools">
              <button className="tool" onClick={previewAll} disabled={timeline.clips.length === 0}>
                Preview
              </button>
              <button className="tool" onClick={stopPreview} disabled={!isPreviewing}>
                Stop
              </button>

              <button className="tool" onClick={splitSelectedAtPlayhead} disabled={!selectedClip}>
                Split
              </button>
              <button className="tool" onClick={deleteSelected} disabled={!selectedClip}>
                Delete
              </button>
              <button className="tool" onClick={setInToPlayhead} disabled={!selectedClip}>
                Set In
              </button>
              <button className="tool" onClick={setOutToPlayhead} disabled={!selectedClip}>
                Set Out
              </button>

              <button className="tool" disabled>Transitions</button>
              <button className="tool" disabled>Music</button>
              <button className="tool" disabled>Captions</button>

              <div className="toolHint">Drag clip edges in the bottom timeline to trim.</div>
            </div>
          </section>
        </section>

        <aside className="right">
          <section className="card">
            <div className="cardHead">
              <div className="cardTitle">AI Assistant</div>
              <div className="pill">Live</div>
            </div>

            <div className="chat">
              <div className="chatBody" role="log" aria-label="Assistant messages">
                {chat.map((m, idx) => (
                  <div key={idx} className={`bubble ${m.role}`}>
                    {m.text}
                  </div>
                ))}
              </div>

              <div className="chips" aria-label="Quick prompts">
                <button className="chip" onClick={() => sendToAssistant("Make it more fast-paced")}>Make it more fast-paced</button>
                <button className="chip" onClick={() => sendToAssistant("Add smoother transitions")}>Add smoother transitions</button>
                <button className="chip" onClick={() => sendToAssistant("Focus on action scenes")}>Focus on action scenes</button>
                <button className="chip" onClick={() => sendToAssistant("Make it shorter")}>Make it shorter</button>
              </div>

              <form
                className="chatInput"
                onSubmit={(e) => {
                  e.preventDefault();
                  sendToAssistant(chatInput);
                }}
              >
                <label className="srOnly" htmlFor="assistantInput">Tell the AI how to improve</label>
                <input
                  id="assistantInput"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Describe style, mood, pacing…"
                  autoComplete="off"
                />
                <button className="send" type="submit" aria-label="Send">
                  <span aria-hidden="true">➤</span>
                </button>
              </form>
            </div>
          </section>

          <section className="card">
            <div className="cardHead">
              <div className="cardTitle">Export Settings</div>
              <div className="pill muted">Ready</div>
            </div>

            <div className="form">
              <label className="field">
                <span>Resolution</span>
                <select
                  value={exportSettings.resolution}
                  onChange={(e) => setExportSettings({ ...exportSettings, resolution: e.target.value as ExportSettings["resolution"] })}
                >
                  <option value="720p">720p</option>
                  <option value="1080p">1080p Full HD</option>
                  <option value="4K">4K</option>
                </select>
              </label>

              <label className="field">
                <span>Format</span>
                <select value={exportSettings.format} onChange={() => {}}>
                  <option value="MP4">MP4</option>
                </select>
              </label>

              <button className="btn primary full" type="button" onClick={onExport} disabled={timeline.clips.length === 0 || isExporting}>
                {isExporting ? "Rendering…" : "Export Video"}
              </button>

              {exportError ? <div className="hint" style={{ color: "rgba(255, 162, 162, .9)" }}>{exportError}</div> : null}
              {exportUrl ? (
                <a className="hint" href={exportUrl} target="_blank" rel="noopener">
                  Download export
                </a>
              ) : (
                <div className="hint">Exports cut &amp; stitch your timeline using FFmpeg.</div>
              )}
            </div>
          </section>
        </aside>

        <section className="bottomTimeline" aria-label="Timeline">
          <div className="timelineCard">
            <div className="timelineHead">
              <div className="timelineTitle">
                <span className="spark" aria-hidden="true">✦</span>
                <span>Timeline</span>
              </div>
              <div className="timelineRight">
                <button
                  type="button"
                  className={`snapBtn ${snappingEnabled ? "on" : "off"}`}
                  onClick={() => setSnappingEnabled((s) => !s)}
                  title={snappingEnabled ? "Snapping ON (hold Alt to disable)" : "Snapping OFF"}
                  aria-pressed={snappingEnabled}
                >
                  Snap {snappingEnabled ? "On" : "Off"}
                </button>
                <label className="zoomCtl">
                  <span>Zoom</span>
                  <input
                    type="range"
                    min={1}
                    max={4}
                    step={0.1}
                    value={timelineZoom}
                    onChange={(e) => setTimelineZoom(Number(e.target.value))}
                    aria-label="Timeline zoom"
                  />
                  <span className="zoomVal">{timelineZoom.toFixed(1)}×</span>
                </label>
                <div className="timelineMeta">{duration ? fmt(duration) : "—"}</div>
              </div>
            </div>

            <TimelineStrip
              refEl={stripRef}
              timeline={timeline}
              durationSeconds={duration}
              zoom={timelineZoom}
              snappingEnabled={snappingEnabled}
              altDown={altDown}
              getAsset={(assetId) => assetsById.get(assetId) ?? null}
              offsets={offsets}
              selectedClipId={selectedClipId}
              playheadSeconds={playheadProjectTime}
              onSelect={async (id) => {
                setSelectedClipId(id);
                const clip = timeline.clips.find((c) => c.id === id);
                if (!clip) return;
                const asset = assetsById.get(clip.assetId);
                if (!asset) return;
                await startClipPlayback(clip, timeline.clips.findIndex((c) => c.id === id), "sequence");
              }}
              onScrub={(t, play) => scrubToProjectTime(t, play)}
              onBeginDrag={(clipId, handle, startX) => beginTrimDrag(clipId, handle, startX)}
              onDropPayload={async (payload, t) => {
                if (payload.kind === "asset") await insertAssetAtTime(payload.assetId, t);
                if (payload.kind === "clip") await reorderClipToTime(payload.clipId, t);
              }}
              getGhostLenSeconds={(payload) => {
                if (payload.kind === "asset") return assetsById.get(payload.assetId)?.durationSeconds ?? null;
                const c = timeline.clips.find((x) => x.id === payload.clipId);
                if (!c) return null;
                return Math.max(0.2, c.sourceOut - c.sourceIn);
              }}
              getDragData={getDragData}
              getCurrentDrag={getCurrentDrag}
              onAnyDragStart={beginDrag}
              onAnyDragEnd={endDrag}
            />

            <div className="timelineFooter">
              <div className="mono">Assets: {assets.length}</div>
              <div className="mono">Clips: {timeline.clips.length}</div>
              <div className="mono">Selected: {selectedClip ? selectedClip.label : "—"}</div>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}

function TimelineStrip({
  refEl,
  timeline,
  durationSeconds,
  zoom,
  snappingEnabled,
  altDown,
  getAsset,
  offsets,
  selectedClipId,
  playheadSeconds,
  onSelect,
  onScrub,
  onBeginDrag
  ,
  onDropPayload,
  getGhostLenSeconds,
  getDragData,
  getCurrentDrag,
  onAnyDragStart,
  onAnyDragEnd
}: {
  refEl: MutableRefObject<HTMLDivElement | null>;
  timeline: ProjectTimeline;
  durationSeconds: number;
  zoom: number;
  snappingEnabled: boolean;
  altDown: boolean;
  getAsset: (assetId: string) => Asset | null;
  offsets: Map<string, number>;
  selectedClipId: string | null;
  playheadSeconds: number;
  onSelect: (id: string) => void;
  onScrub: (t: number, play: boolean) => void;
  onBeginDrag: (clipId: string, handle: "in" | "out", startX: number) => void;
  onDropPayload: (payload: DragPayload, projectTime: number) => void;
  getGhostLenSeconds: (payload: DragPayload) => number | null;
  getDragData: (e: React.DragEvent) => DragPayload | null;
  getCurrentDrag: () => DragPayload | null;
  onAnyDragStart: (payload: DragPayload) => void;
  onAnyDragEnd: () => void;
}) {
  const duration = Math.max(0.001, durationSeconds || 0.001);
  const playheadX = clamp(playheadSeconds / duration, 0, 1);
  const scrubRef = useRef<null | { startX: number; moved: boolean }>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [dropPayload, setDropPayload] = useState<DragPayload | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragDepthRef = useRef(0);
  const [snapFlashAt, setSnapFlashAt] = useState<number | null>(null);

  function clientXToProjectTime(clientX: number) {
    const el = refEl.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const xPx = (clientX - rect.left) + (el.scrollLeft || 0);
    const x = clamp(xPx / Math.max(1, el.scrollWidth || rect.width), 0, 1);
    return x * duration;
  }

  function computeDropIndex(t: number) {
    const tt = clamp(t, 0, duration);
    let acc = 0;
    for (let i = 0; i < timeline.clips.length; i++) {
      const c = timeline.clips[i];
      const len = Math.max(0, c.sourceOut - c.sourceIn);
      const start = acc;
      const end = acc + len;
      if (tt >= start && tt <= end) {
        const before = tt - start;
        const after = end - tt;
        return before <= after ? i : i + 1;
      }
      acc = end;
    }
    return timeline.clips.length;
  }

  function indexToLeftSeconds(idx: number) {
    if (timeline.clips.length === 0) return 0;
    if (idx <= 0) return 0;
    if (idx >= timeline.clips.length) return duration;
    const id = timeline.clips[idx].id;
    return offsets.get(id) ?? 0;
  }

  function getSnapThresholdSeconds() {
    const el = refEl.current;
    const px = el ? Math.max(1, el.scrollWidth || el.clientWidth) : 1;
    const secondsPerPx = duration / px;
    return clamp(secondsPerPx * 10, 0.06, 0.35);
  }

  function projectBoundaries() {
    const out: number[] = [0, duration];
    for (const c of timeline.clips) {
      const start = offsets.get(c.id) ?? 0;
      const len = Math.max(0, c.sourceOut - c.sourceIn);
      out.push(start);
      out.push(start + len);
    }
    out.sort((a, b) => a - b);
    // De-dupe small.
    const dedup: number[] = [];
    const eps = 0.01;
    for (const t of out) {
      if (dedup.length === 0 || Math.abs(t - dedup[dedup.length - 1]) > eps) dedup.push(t);
    }
    return dedup;
  }

  function snapProjectTime(t: number) {
    const thr = getSnapThresholdSeconds();
    if (!snappingEnabled || altDown) return t;
    const snapped = snapNearest(projectBoundaries(), t, thr);
    if (Math.abs(snapped - t) > 0.001) {
      setSnapFlashAt(snapped);
      window.setTimeout(() => setSnapFlashAt((cur) => (cur === snapped ? null : cur)), 220);
    }
    return snapped;
  }

  function waveformStyle(asset: Asset | null, clip: ProjectClip) {
    if (!asset?.hasAudio || !asset.waveformUrl || !asset.durationSeconds) return null;
    const total = asset.durationSeconds;
    const clipLen = Math.max(0.2, clip.sourceOut - clip.sourceIn);
    const sizeX = (total / clipLen) * 100;
    const posX = total > clipLen ? (clip.sourceIn / (total - clipLen)) * 100 : 0;
    return {
      backgroundImage: `url(${asset.waveformUrl})`,
      backgroundRepeat: "no-repeat",
      backgroundSize: `${sizeX.toFixed(3)}% 100%`,
      backgroundPosition: `${clamp(posX, 0, 100).toFixed(3)}% 50%`
    } as any;
  }

  return (
    <div className="timelineStripWrap">
      <div
        className="timelineStrip"
        ref={refEl}
        onPointerDownCapture={(e) => {
          if (e.button !== 0) return;
          const el = refEl.current;
          if (!el) return;
          const target = e.target as HTMLElement | null;
          if (target?.closest?.(".tlHandle")) return; // let trim handles handle the drag
          scrubRef.current = { startX: e.clientX, moved: false };
          el.setPointerCapture?.(e.pointerId);
          onScrub(clientXToProjectTime(e.clientX), false);
        }}
        onPointerMoveCapture={(e) => {
          const s = scrubRef.current;
          if (!s) return;
          if (Math.abs(e.clientX - s.startX) > 2) s.moved = true;
          onScrub(clientXToProjectTime(e.clientX), false);
        }}
        onPointerUpCapture={(e) => {
          const s = scrubRef.current;
          scrubRef.current = null;
          if (!s) return;
          if (!s.moved) onScrub(clientXToProjectTime(e.clientX), true);
        }}
        role="list"
        aria-label="Timeline strip"
        onDragEnter={(e) => {
          const payload = getCurrentDrag() || getDragData(e);
          if (!payload) return;
          dragDepthRef.current += 1;
        }}
        onDragOver={(e) => {
          const payload = getCurrentDrag() || getDragData(e);
          if (!payload) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = payload.kind === "asset" ? "copy" : "move";
          setDropAt(snapProjectTime(clientXToProjectTime(e.clientX)));
          setDropPayload(payload);
        }}
        onDragLeave={() => {
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) {
            setDropAt(null);
            setDropPayload(null);
          }
        }}
        onDrop={(e) => {
          const payload = getCurrentDrag() || getDragData(e);
          if (!payload) return;
          e.preventDefault();
          const t = snapProjectTime(clientXToProjectTime(e.clientX));
          setDropAt(null);
          setDropPayload(null);
          setDraggingId(null);
          dragDepthRef.current = 0;
          onDropPayload(payload, t);
          onAnyDragEnd();
        }}
      >
        <div className="timelineStripInner" style={{ width: pct(zoom) } as any}>
          {timeline.clips.length === 0 ? (
            <div className="timelineEmptyDrop" aria-hidden="true">
              Drop clips here
            </div>
          ) : null}
          <div className="lane laneVideo" aria-label="Video track" role="list">
            {timeline.clips.map((c) => {
              const clipOffset = offsets.get(c.id) ?? 0;
              const len = Math.max(0.001, c.sourceOut - c.sourceIn);
              const left = clamp(clipOffset / duration, 0, 1);
              const width = clamp(len / duration, 0.002, 1);
              const isSelected = c.id === selectedClipId;
              return (
                <div
                  key={c.id}
                  className={`tlClip ${isSelected ? "isSelected" : ""} ${draggingId === c.id ? "isDragging" : ""}`}
                  style={{ left: pct(left), width: pct(width) } as any}
                  role="listitem"
                  title={`${c.label} (${fmt(len)})`}
                  draggable
                  onDragStart={(e) => {
                    onAnyDragStart({ kind: "clip", clipId: c.id });
                    setDraggingId(c.id);
                    try {
                      const raw = JSON.stringify({ kind: "clip", clipId: c.id });
                      e.dataTransfer.setData(DRAG_MIME, raw);
                      e.dataTransfer.setData("text/plain", raw);
                      e.dataTransfer.effectAllowed = "move";
                    } catch {}
                  }}
                  onDragEnd={() => {
                    setDraggingId(null);
                    onAnyDragEnd();
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onSelect(c.id);
                  }}
                >
                  <div
                    className="tlHandle left"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault(); // prevent native drag start
                      onSelect(c.id);
                      onBeginDrag(c.id, "in", e.clientX);
                    }}
                    aria-label="Trim in"
                    draggable={false}
                  />
                  <div className="tlLabel">{c.label}</div>
                  <div
                    className="tlHandle right"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault(); // prevent native drag start
                      onSelect(c.id);
                      onBeginDrag(c.id, "out", e.clientX);
                    }}
                    aria-label="Trim out"
                    draggable={false}
                  />
                </div>
              );
            })}
          </div>

          <div className="lane laneAudio" aria-label="Audio track" aria-hidden="true">
            {timeline.clips.map((c) => {
              const clipOffset = offsets.get(c.id) ?? 0;
              const len = Math.max(0.001, c.sourceOut - c.sourceIn);
              const left = clamp(clipOffset / duration, 0, 1);
              const width = clamp(len / duration, 0.002, 1);
              const asset = getAsset(c.assetId);
              const ws = waveformStyle(asset, c);
              const has = Boolean(asset?.hasAudio);
              return (
                <div
                  key={`a-${c.id}`}
                  className={`audioClip ${has ? "has" : "none"}`}
                  style={{ left: pct(left), width: pct(width), ...(ws ?? {}) } as any}
                />
              );
            })}
          </div>

          <div className="playhead" style={{ left: pct(playheadX) } as any} aria-hidden="true" />
          {dropAt != null ? (
            <div className="dropMarker" style={{ left: pct(clamp(dropAt / duration, 0, 1)) } as any} aria-hidden="true" />
          ) : null}
          {dropAt != null && dropPayload ? (() => {
            const len = getGhostLenSeconds(dropPayload);
            if (!len || !Number.isFinite(len) || len <= 0) return null;
            const idx = computeDropIndex(dropAt);
            const leftSeconds = indexToLeftSeconds(idx);
            const left = clamp(leftSeconds / duration, 0, 1);
            // When the timeline is empty, treat the ghost as a medium-size block.
            const width = timeline.clips.length === 0 ? 0.35 : clamp(len / duration, 0.01, 0.9);
            return (
              <div
                className="ghostClip"
                style={{ left: pct(left), width: pct(width) } as any}
                aria-hidden="true"
              />
            );
          })() : null}
          {snapFlashAt != null ? (
            <div
              className="snapFlash"
              style={{ left: pct(clamp(snapFlashAt / duration, 0, 1)) } as any}
              aria-hidden="true"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function updateClipById(t: ProjectTimeline, clipId: string, patch: Partial<Pick<ProjectClip, "sourceIn" | "sourceOut" | "label">>) {
  const minLen = 0.2;
  const clips = t.clips.map((c) => {
    if (c.id !== clipId) return c;
    const nextIn = patch.sourceIn != null ? patch.sourceIn : c.sourceIn;
    const nextOut = patch.sourceOut != null ? patch.sourceOut : c.sourceOut;
    const sourceIn = clamp(nextIn, 0, nextOut - minLen);
    const sourceOut = Math.max(sourceIn + minLen, nextOut);
    return { ...c, ...patch, sourceIn, sourceOut };
  });
  return { ...t, clips };
}

function cleanName(name: string) {
  return name.replace(/\.[a-z0-9]+$/i, "");
}

function fmt(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function pct(n: number) {
  return `${(n * 100).toFixed(3)}%`;
}

function snapWithin(points: number[] | undefined, value: number, threshold: number, min: number, max: number) {
  const snapped = snapNearest(points, value, threshold);
  if (snapped < min || snapped > max) return value;
  return snapped;
}

function snapNearest(points: number[] | undefined, value: number, threshold: number) {
  if (!points || points.length === 0) return value;
  // Binary search for insertion point.
  let lo = 0;
  let hi = points.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const m = points[mid];
    if (m < value) lo = mid + 1;
    else hi = mid - 1;
  }
  const cand: number[] = [];
  if (lo < points.length) cand.push(points[lo]);
  if (lo - 1 >= 0) cand.push(points[lo - 1]);
  let best = value;
  let bestDist = threshold + 1;
  for (const c of cand) {
    const d = Math.abs(c - value);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return bestDist <= threshold ? best : value;
}
