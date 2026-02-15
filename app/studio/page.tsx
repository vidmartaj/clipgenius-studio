"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { AssistantReply, AnalysisTimeline, AudioClip, ProjectClip, ProjectTimeline } from "../../lib/types";
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
  selectedAudioClipId: string | null;
};

type PendingSeek = {
  expectedSrc: string;
  time: number;
  play: boolean;
};

type DragPayload =
  | { kind: "asset"; assetId: string }
  | { kind: "clip"; clipId: string }
  | { kind: "audio_clip"; clipId: string };

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
  const unlinkedAudioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const playheadRef = useRef(0);

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

  const [timeline, setTimeline] = useState<ProjectTimeline>({
    projectId: "local",
    clips: [],
    audioLinked: true,
    trackAudioMuted: false,
    trackAudioVolume: 1,
    trackVideoHidden: false
  });
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedAudioClipId, setSelectedAudioClipId] = useState<string | null>(null);

  const [playerSrc, setPlayerSrc] = useState<string | null>(null);
  const [timelineZoom, setTimelineZoom] = useState(1.6);
  // Snapping exists in code, but we keep it off by default for now (we'll revisit later).
  const [snappingEnabled] = useState(false);
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

  useEffect(() => {
    playheadRef.current = playheadProjectTime;
  }, [playheadProjectTime]);

  const duration = useMemo(() => projectDurationSeconds(timeline), [timeline]);
  const offsets = useMemo(() => projectClipOffsets(timeline), [timeline]);

  const audioClips = useMemo<AudioClip[]>(() => {
    if (timeline.audioLinked === false && Array.isArray(timeline.audioClips)) return timeline.audioClips;
    // Linked mode: derive audio clips from video clips for display. These are not editable.
    return timeline.clips.map((c) => ({
      id: `linked-${c.id}`,
      assetId: c.assetId,
      label: c.label,
      sourceIn: c.sourceIn,
      sourceOut: c.sourceOut,
      start: offsets.get(c.id) ?? 0,
      volume: c.audioVolume ?? 1,
      muted: Boolean(c.audioMuted),
      fadeIn: c.audioFadeIn ?? 0,
      fadeOut: c.audioFadeOut ?? 0
    }));
  }, [timeline, offsets]);

  const selectedClip = useMemo(() => {
    if (!selectedClipId) return null;
    return timeline.clips.find((c) => c.id === selectedClipId) ?? null;
  }, [timeline, selectedClipId]);

  const selectedAudioClip = useMemo(() => {
    if (!selectedAudioClipId) return null;
    return audioClips.find((c) => c.id === selectedAudioClipId) ?? null;
  }, [audioClips, selectedAudioClipId]);

  const selectedUnlinkedAudioClip = useMemo(() => {
    if (timeline.audioLinked !== false) return null;
    if (!selectedAudioClipId || String(selectedAudioClipId).startsWith("linked-")) return null;
    return (timeline.audioClips || []).find((c) => c.id === selectedAudioClipId) ?? null;
  }, [timeline.audioLinked, timeline.audioClips, selectedAudioClipId]);

  const selectedAsset = useMemo(() => {
    if (!selectedClip) return null;
    return assetsById.get(selectedClip.assetId) ?? null;
  }, [assetsById, selectedClip]);

  function sanitizeTimelineIfNeeded(t: ProjectTimeline) {
    if (t.clips.length === 0) return t;
    const minLen = 0.2;
    let changed = false;
    const trackAudioVolumeRaw = t.trackAudioVolume ?? 1;
    const trackAudioVolume = clamp(Number.isFinite(trackAudioVolumeRaw) ? trackAudioVolumeRaw : 1, 0, 2);
    const clips = t.clips.map((c) => {
      const asset = assetsById.get(c.assetId);
      const maxOut = asset?.durationSeconds || 0;
      if (!maxOut || !Number.isFinite(maxOut) || maxOut <= 0) return c;

      const sourceIn = clamp(c.sourceIn, 0, Math.max(0, maxOut - minLen));
      const sourceOut = clamp(c.sourceOut, sourceIn + minLen, maxOut);
      const audioVolumeRaw = c.audioVolume ?? 1;
      const audioVolume = clamp(Number.isFinite(audioVolumeRaw) ? audioVolumeRaw : 1, 0, 2);
      const audioMuted = Boolean(c.audioMuted);
      const len = Math.max(minLen, sourceOut - sourceIn);
      const audioFadeInRaw = c.audioFadeIn ?? 0;
      const audioFadeOutRaw = c.audioFadeOut ?? 0;
      const audioFadeIn = clamp(Number.isFinite(audioFadeInRaw) ? audioFadeInRaw : 0, 0, Math.max(0, len / 2));
      const audioFadeOut = clamp(Number.isFinite(audioFadeOutRaw) ? audioFadeOutRaw : 0, 0, Math.max(0, len / 2));
      if (
        sourceIn === c.sourceIn &&
        sourceOut === c.sourceOut &&
        audioVolume === (c.audioVolume ?? 1) &&
        audioMuted === Boolean(c.audioMuted) &&
        audioFadeIn === (c.audioFadeIn ?? 0) &&
        audioFadeOut === (c.audioFadeOut ?? 0)
      )
        return c;
      changed = true;
      return { ...c, sourceIn, sourceOut, audioVolume, audioMuted, audioFadeIn, audioFadeOut };
    });

    const projectDuration = Math.max(0.001, projectDurationSeconds({ ...t, clips }));
    let audioClips: AudioClip[] | undefined = t.audioClips;
    if (t.audioLinked === false && Array.isArray(t.audioClips)) {
      audioClips = t.audioClips.map((c) => {
        const asset = assetsById.get(c.assetId);
        const maxOut = asset?.durationSeconds || 0;
        if (!maxOut || !Number.isFinite(maxOut) || maxOut <= 0) return c;
        const sourceIn = clamp(c.sourceIn, 0, Math.max(0, maxOut - minLen));
        const sourceOut = clamp(c.sourceOut, sourceIn + minLen, maxOut);
        const len = Math.max(minLen, sourceOut - sourceIn);
        const startRaw = Number.isFinite(c.start) ? c.start : 0;
        const start = clamp(startRaw, 0, Math.max(0, projectDuration - len));
        const volumeRaw = c.volume ?? 1;
        const volume = clamp(Number.isFinite(volumeRaw) ? volumeRaw : 1, 0, 2);
        const muted = Boolean(c.muted);
        if (sourceIn === c.sourceIn && sourceOut === c.sourceOut && start === c.start && volume === (c.volume ?? 1) && muted === Boolean(c.muted)) return c;
        changed = true;
        return { ...c, sourceIn, sourceOut, start, volume, muted };
      });
    }

    if (trackAudioVolume !== (t.trackAudioVolume ?? 1)) changed = true;
    return changed ? { ...t, clips, audioClips, trackAudioVolume } : t;
  }

  function makeClipFromAsset(a: Asset): ProjectClip | null {
    if (!a.durationSeconds || !Number.isFinite(a.durationSeconds) || a.durationSeconds <= 0) return null;
    return {
      id: crypto.randomUUID(),
      assetId: a.assetId,
      label: cleanName(a.name),
      sourceIn: 0,
      sourceOut: a.durationSeconds,
      audioVolume: 1,
      audioMuted: false,
      audioFadeIn: 0,
      audioFadeOut: 0
    };
  }

  function makeAudioClipFromAsset(a: Asset): AudioClip | null {
    if (!a.hasAudio) return null;
    if (!a.durationSeconds || !Number.isFinite(a.durationSeconds) || a.durationSeconds <= 0) return null;
    return {
      id: crypto.randomUUID(),
      assetId: a.assetId,
      label: cleanName(a.name),
      sourceIn: 0,
      sourceOut: a.durationSeconds,
      start: 0,
      volume: 1,
      muted: false,
      fadeIn: 0,
      fadeOut: 0
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

  function computeAudioInsertIndex(projectTime: number, clips: AudioClip[]) {
    const t = clamp(projectTime, 0, duration);
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const len = Math.max(0.2, c.sourceOut - c.sourceIn);
      const mid = c.start + len / 2;
      if (t < mid) return i;
    }
    return clips.length;
  }

  async function insertAssetAtTime(assetId: string, projectTime: number) {
    const a = assetsById.get(assetId);
    if (!a) return;
    const clip = makeClipFromAsset(a);
    if (!clip) return;
    const idx = computeInsertIndex(projectTime);
    const nextClips = [...timeline.clips.slice(0, idx), clip, ...timeline.clips.slice(idx)];
    let nextTimeline: ProjectTimeline = { ...timeline, clips: nextClips };
    if (timeline.audioLinked === false && a.hasAudio) {
      const offsetsNext = projectClipOffsets(nextTimeline);
      const start = offsetsNext.get(clip.id) ?? 0;
      const audioClip = makeAudioClipFromAsset(a);
      if (audioClip) {
        audioClip.start = start;
        const existing = Array.isArray(timeline.audioClips) ? timeline.audioClips : [];
        const sorted = [...existing].sort((x, y) => x.start - y.start);
        const insertIdx = computeAudioInsertIndex(start, sorted);
        nextTimeline = { ...nextTimeline, audioClips: [...sorted.slice(0, insertIdx), audioClip, ...sorted.slice(insertIdx)] };
      }
    }
    applyWithHistory({ timeline: nextTimeline, selectedClipId: clip.id });
    await ensurePlayerOnAsset(a, clip.sourceIn, false);
  }

  async function insertAssetAudioAtTime(assetId: string, projectTime: number) {
    const a = assetsById.get(assetId);
    if (!a) return;
    const clip = makeAudioClipFromAsset(a);
    if (!clip) return;
    const len = Math.max(0.2, clip.sourceOut - clip.sourceIn);
    clip.start = clamp(projectTime, 0, Math.max(0, duration - len));
    const existing = timeline.audioLinked === false && Array.isArray(timeline.audioClips) ? timeline.audioClips : [];
    const sorted = [...existing].sort((x, y) => x.start - y.start);
    const idx = computeAudioInsertIndex(clip.start, sorted);
    const nextAudio = [...sorted.slice(0, idx), clip, ...sorted.slice(idx)];
    applyWithHistory({
      timeline: { ...timeline, audioLinked: false, audioClips: nextAudio },
      selectedClipId,
      selectedAudioClipId: clip.id
    });
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

  async function reorderAudioClipToTime(clipId: string, projectTime: number) {
    if (timeline.audioLinked !== false || !Array.isArray(timeline.audioClips)) return;
    const fromIdx = timeline.audioClips.findIndex((c) => c.id === clipId);
    if (fromIdx === -1) return;
    const clip = timeline.audioClips[fromIdx];
    const len = Math.max(0.2, clip.sourceOut - clip.sourceIn);
    const nextStart = clamp(projectTime, 0, Math.max(0, duration - len));
    const remaining = timeline.audioClips.filter((c) => c.id !== clipId);
    const sorted = [...remaining].sort((x, y) => x.start - y.start);
    const toIdx = computeAudioInsertIndex(nextStart, sorted);
    const nextAudio = [...sorted.slice(0, toIdx), { ...clip, start: nextStart }, ...sorted.slice(toIdx)];
    applyWithHistory({
      timeline: { ...timeline, audioLinked: false, audioClips: nextAudio },
      selectedClipId,
      selectedAudioClipId: clipId
    });
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
      if (parsed?.kind === "audio_clip" && typeof parsed.clipId === "string") return parsed;
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

  // Track mute: controls preview audio immediately.
  useEffect(() => {
    const fg = videoRef.current;
    const bg = bgVideoRef.current;
    if (bg) bg.muted = true; // background layer is always muted
    if (!fg) return;
    // When audio is unlinked, mute the video element to avoid double-audio.
    if (timeline.audioLinked === false) fg.muted = true;
    // Track mute overrides everything when linked too.
    else if (timeline.trackAudioMuted) fg.muted = true;
  }, [timeline.trackAudioMuted, timeline.audioLinked]);

  // ---- Undo / redo ----
  function applyWithHistory(next: { timeline: ProjectTimeline; selectedClipId: string | null; selectedAudioClipId?: string | null }) {
    const sanitized = sanitizeTimelineIfNeeded(next.timeline);
    setPast((p) => [...p, { timeline, selectedClipId, selectedAudioClipId }].slice(-80));
    setFuture([]);
    setTimeline(sanitized);
    setSelectedClipId(next.selectedClipId);
    setSelectedAudioClipId(next.selectedAudioClipId ?? null);
    setExportUrl(null);
    setExportError(null);
  }

  function undo() {
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      setFuture((f) => [{ timeline, selectedClipId, selectedAudioClipId }, ...f].slice(0, 80));
      setTimeline(prev.timeline);
      setSelectedClipId(prev.selectedClipId);
      setSelectedAudioClipId(prev.selectedAudioClipId);
      setExportUrl(null);
      setExportError(null);
      return p.slice(0, -1);
    });
  }

  function redo() {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      setPast((p) => [...p, { timeline, selectedClipId, selectedAudioClipId }].slice(-80));
      setTimeline(next.timeline);
      setSelectedClipId(next.selectedClipId);
      setSelectedAudioClipId(next.selectedAudioClipId);
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
      const el = document.activeElement as HTMLElement | null;
      const tag = (el?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || (el as any)?.isContentEditable) return;

      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        deleteSelection();
      }
      if (e.key.toLowerCase() === "s") {
        // Split shortcut (simple MVP).
        e.preventDefault();
        splitSelectionAtPlayhead();
      }
      if (e.key === "Escape") {
        setSelectedAudioClipId(null);
        setSelectedClipId(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [timeline, selectedClipId, selectedAudioClipId, playheadProjectTime]);

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
  function pauseAllUnlinkedAudio() {
    for (const el of unlinkedAudioElsRef.current.values()) {
      try {
        el.pause();
      } catch {}
    }
  }

  function getOrCreateUnlinkedAudioEl(id: string, src: string) {
    const map = unlinkedAudioElsRef.current;
    const existing = map.get(id);
    if (existing) {
      if (!existing.src || !existing.src.endsWith(src)) {
        existing.src = src;
        existing.load?.();
      }
      return existing;
    }
    const el = new Audio();
    el.preload = "auto";
    el.src = src;
    el.crossOrigin = "anonymous";
    map.set(id, el);
    return el;
  }

  function fadeGain(fadeIn: number, fadeOut: number, within: number, len: number) {
    const L = Math.max(0.001, len);
    const w = clamp(within, 0, L);
    const fi = clamp(Number.isFinite(fadeIn as any) ? (fadeIn as any) : 0, 0, L / 2);
    const fo = clamp(Number.isFinite(fadeOut as any) ? (fadeOut as any) : 0, 0, L / 2);
    let g = 1;
    if (fi > 0.001) g *= clamp(w / fi, 0, 1);
    if (fo > 0.001) g *= clamp((L - w) / fo, 0, 1);
    return clamp(g, 0, 1);
  }

  function syncUnlinkedAudio(projectTime: number, play: boolean) {
    if (timeline.audioLinked !== false) {
      pauseAllUnlinkedAudio();
      return;
    }
    if (timeline.trackAudioMuted) {
      pauseAllUnlinkedAudio();
      return;
    }
    if (!Array.isArray(timeline.audioClips) || timeline.audioClips.length === 0) {
      pauseAllUnlinkedAudio();
      return;
    }

    const active = new Set<string>();
    const trackVol = clamp(Number.isFinite(timeline.trackAudioVolume as any) ? (timeline.trackAudioVolume as any) : 1, 0, 2);
    for (const c of timeline.audioClips) {
      if (!c || !c.id || typeof c.id !== "string") continue;
      if (c.muted) continue;
      const asset = assetsById.get(c.assetId);
      if (!asset?.videoUrl || !asset.hasAudio) continue;
      const len = Math.max(0.001, Number(c.sourceOut) - Number(c.sourceIn));
      const start = Math.max(0, Number(c.start) || 0);
      const end = start + len;
      if (projectTime < start || projectTime >= end) continue;

      const within = clamp(projectTime - start, 0, len);
      const desired = clamp(Number(c.sourceIn) + within, 0, Number.isFinite(asset.durationSeconds) ? asset.durationSeconds : Number.POSITIVE_INFINITY);

      const el = getOrCreateUnlinkedAudioEl(c.id, asset.videoUrl);
      el.muted = false;
      const vol = clamp(Number.isFinite(c.volume as any) ? (c.volume as any) : 1, 0, 2);
      const g = fadeGain(c.fadeIn ?? 0, c.fadeOut ?? 0, within, len);
      el.volume = clamp((vol * trackVol * g) / 2, 0, 1);
      // Keep audio in sync with the timeline playhead.
      if (Number.isFinite(el.currentTime) && Math.abs(el.currentTime - desired) > 0.25) {
        try {
          el.currentTime = desired;
        } catch {}
      }

      active.add(c.id);
      if (play) {
        if (el.paused) el.play().catch(() => {});
      } else {
        el.pause();
      }
    }

    // Pause any non-active audio elements.
    for (const [id, el] of unlinkedAudioElsRef.current.entries()) {
      if (active.has(id)) continue;
      try {
        el.pause();
      } catch {}
    }
  }

  function applyLinkedClipAudio(clip: ProjectClip | null, within: number, len: number) {
    const fg = videoRef.current;
    if (!fg) return;
    if (timeline.audioLinked === false) return; // unlinked is handled by HTMLAudio elements
    if (timeline.trackAudioMuted) {
      fg.muted = true;
      return;
    }
    const muted = Boolean(clip?.audioMuted);
    const vol = clamp(Number.isFinite(clip?.audioVolume as any) ? (clip?.audioVolume as any) : 1, 0, 2);
    const trackVol = clamp(Number.isFinite(timeline.trackAudioVolume as any) ? (timeline.trackAudioVolume as any) : 1, 0, 2);
    fg.muted = muted;
    const g = fadeGain(clip?.audioFadeIn ?? 0, clip?.audioFadeOut ?? 0, within, len);
    fg.volume = clamp((vol * trackVol * g) / 2, 0, 1);
  }

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
  function deleteSelection() {
    // Delete unlinked audio clip if selected.
    if (timeline.audioLinked === false && selectedUnlinkedAudioClip && Array.isArray(timeline.audioClips)) {
      const remaining = timeline.audioClips.filter((c) => c.id !== selectedUnlinkedAudioClip.id);
      applyWithHistory({
        timeline: { ...timeline, audioClips: remaining },
        selectedClipId,
        selectedAudioClipId: remaining[0]?.id ?? null
      });
      return;
    }

    // Otherwise delete video clip.
    if (!selectedClip) return;
    const remaining = timeline.clips.filter((c) => c.id !== selectedClip.id);
    applyWithHistory({ timeline: { ...timeline, clips: remaining }, selectedClipId: remaining[0]?.id ?? null });
  }

  function splitSelectionAtPlayhead() {
    // Split unlinked audio clip at project playhead.
    if (timeline.audioLinked === false && selectedUnlinkedAudioClip && Array.isArray(timeline.audioClips)) {
      const clip = selectedUnlinkedAudioClip;
      const len = Math.max(0.001, clip.sourceOut - clip.sourceIn);
      const within = playheadProjectTime - clip.start;
      if (!(within > 0.2 && within < len - 0.2)) return;
      const splitSource = clamp(clip.sourceIn + within, clip.sourceIn + 0.2, clip.sourceOut - 0.2);
      const leftLen = splitSource - clip.sourceIn;
      const rightLen = clip.sourceOut - splitSource;
      if (leftLen <= 0.2 || rightLen <= 0.2) return;

      const left: AudioClip = {
        ...clip,
        id: crypto.randomUUID(),
        sourceOut: splitSource,
        // keep start
        // avoid double-fade semantics for now
        muted: clip.muted,
        volume: clip.volume
      };
      const right: AudioClip = {
        ...clip,
        id: crypto.randomUUID(),
        sourceIn: splitSource,
        start: clip.start + within,
        muted: clip.muted,
        volume: clip.volume
      };

      const nextAudio = timeline.audioClips
        .filter((c) => c.id !== clip.id)
        .concat([left, right])
        .sort((a, b) => a.start - b.start);

      applyWithHistory({
        timeline: { ...timeline, audioClips: nextAudio },
        selectedClipId,
        selectedAudioClipId: right.id
      });
      return;
    }

    // Otherwise split video clip at source playhead.
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

  function toggleAudioLink() {
    if (timeline.audioLinked === false) {
      // Relink: derive audio from video clips.
      applyWithHistory({
        timeline: { ...timeline, audioLinked: true, audioClips: undefined },
        selectedClipId,
        selectedAudioClipId: null
      });
      return;
    }

    // Unlink: materialize audio clips from current video clips that actually have audio.
    const nextAudio: AudioClip[] = [];
    for (const c of timeline.clips) {
      const a = assetsById.get(c.assetId);
      if (!a?.hasAudio) continue;
      const start = offsets.get(c.id) ?? 0;
      nextAudio.push({
        id: crypto.randomUUID(),
        assetId: c.assetId,
        label: c.label,
        sourceIn: c.sourceIn,
        sourceOut: c.sourceOut,
        start,
        volume: 1,
        muted: false,
        fadeIn: c.audioFadeIn ?? 0,
        fadeOut: c.audioFadeOut ?? 0
      });
    }

    applyWithHistory({
      timeline: { ...timeline, audioLinked: false, audioClips: nextAudio.sort((x, y) => x.start - y.start) },
      selectedClipId,
      selectedAudioClipId: nextAudio[0]?.id ?? null
    });
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
    applyLinkedClipAudio(clip, 0, Math.max(0.001, clip.sourceOut - clip.sourceIn));
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
    pauseAllUnlinkedAudio();
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
            const within = (v.currentTime || 0) - sel.sourceIn;
            const len = Math.max(0.001, sel.sourceOut - sel.sourceIn);
            applyLinkedClipAudio(sel, within, len);
            const off = offsets.get(sel.id) ?? 0;
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
      const len = Math.max(0.001, clip.sourceOut - clip.sourceIn);
      applyLinkedClipAudio(clip, within, len);

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

  // While previewing, drive unlinked audio playback from the project playhead.
  useEffect(() => {
    if (!isPreviewing) {
      pauseAllUnlinkedAudio();
      return;
    }
    if (timeline.audioLinked !== false || timeline.trackAudioMuted) {
      pauseAllUnlinkedAudio();
      return;
    }

    let raf = 0;
    const tick = () => {
      syncUnlinkedAudio(playheadRef.current, true);
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [isPreviewing, timeline.audioLinked, timeline.trackAudioMuted, timeline.audioClips, assetsById]);

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

  // ---- Audio trim drag (unlinked audio lane) ----
  const audioDragRef = useRef<null | {
    clipId: string;
    handle: "in" | "out";
    startX: number;
    startIn: number;
    startOut: number;
    secondsPerPx: number;
    prevState: HistoryState;
    didMove: boolean;
  }>(null);

  function beginAudioTrimDrag(clipId: string, handle: "in" | "out", startX: number) {
    if (timeline.audioLinked !== false || !Array.isArray(timeline.audioClips)) return;
    const el = stripRef.current;
    const clip = timeline.audioClips.find((c) => c.id === clipId);
    if (!el || !clip) return;
    const secondsPerPx = duration / Math.max(1, el.scrollWidth || el.getBoundingClientRect().width);
    audioDragRef.current = {
      clipId,
      handle,
      startX,
      startIn: clip.sourceIn,
      startOut: clip.sourceOut,
      secondsPerPx,
      prevState: { timeline, selectedClipId, selectedAudioClipId },
      didMove: false
    };
  }

  function updateAudioClipById(
    t: ProjectTimeline,
    clipId: string,
    patch: Partial<Pick<AudioClip, "sourceIn" | "sourceOut" | "start" | "label" | "volume" | "muted" | "fadeIn" | "fadeOut">>
  ) {
    if (t.audioLinked !== false || !Array.isArray(t.audioClips)) return t;
    const minLen = 0.2;
    const projectDuration = Math.max(0.001, projectDurationSeconds(t));
    const next = t.audioClips.map((c) => {
      if (c.id !== clipId) return c;
      const asset = assetsById.get(c.assetId);
      const maxOut = asset?.durationSeconds || Number.POSITIVE_INFINITY;
      const nextIn = patch.sourceIn != null ? patch.sourceIn : c.sourceIn;
      const nextOut = patch.sourceOut != null ? patch.sourceOut : c.sourceOut;
      const sourceIn = clamp(nextIn, 0, Math.max(0, maxOut - minLen));
      const sourceOut = clamp(nextOut, sourceIn + minLen, maxOut);
      const len = Math.max(minLen, sourceOut - sourceIn);
      const startRaw = patch.start != null ? patch.start : c.start;
      const start = clamp(Number.isFinite(startRaw) ? startRaw : 0, 0, Math.max(0, projectDuration - len));
      const volumeRaw = patch.volume != null ? patch.volume : c.volume ?? 1;
      const volume = clamp(Number.isFinite(volumeRaw) ? volumeRaw : 1, 0, 2);
      const muted = patch.muted != null ? Boolean(patch.muted) : Boolean(c.muted);
      const fadeInRaw = patch.fadeIn != null ? patch.fadeIn : c.fadeIn ?? 0;
      const fadeOutRaw = patch.fadeOut != null ? patch.fadeOut : c.fadeOut ?? 0;
      const fadeIn = clamp(Number.isFinite(fadeInRaw) ? fadeInRaw : 0, 0, Math.max(0, len / 2));
      const fadeOut = clamp(Number.isFinite(fadeOutRaw) ? fadeOutRaw : 0, 0, Math.max(0, len / 2));
      return { ...c, ...patch, sourceIn, sourceOut, start, volume, muted, fadeIn, fadeOut };
    });
    return { ...t, audioClips: next };
  }

  function updateLinkedClipAudioById(
    t: ProjectTimeline,
    clipId: string,
    patch: Partial<Pick<ProjectClip, "audioVolume" | "audioMuted" | "audioFadeIn" | "audioFadeOut">>
  ) {
    const clips = t.clips.map((c) => {
      if (c.id !== clipId) return c;
      const audioVolumeRaw = patch.audioVolume != null ? patch.audioVolume : c.audioVolume ?? 1;
      const audioVolume = clamp(Number.isFinite(audioVolumeRaw) ? audioVolumeRaw : 1, 0, 2);
      const audioMuted = patch.audioMuted != null ? Boolean(patch.audioMuted) : Boolean(c.audioMuted);
      const len = Math.max(0.2, c.sourceOut - c.sourceIn);
      const audioFadeInRaw = patch.audioFadeIn != null ? patch.audioFadeIn : c.audioFadeIn ?? 0;
      const audioFadeOutRaw = patch.audioFadeOut != null ? patch.audioFadeOut : c.audioFadeOut ?? 0;
      const audioFadeIn = clamp(Number.isFinite(audioFadeInRaw) ? audioFadeInRaw : 0, 0, Math.max(0, len / 2));
      const audioFadeOut = clamp(Number.isFinite(audioFadeOutRaw) ? audioFadeOutRaw : 0, 0, Math.max(0, len / 2));
      return { ...c, ...patch, audioVolume, audioMuted, audioFadeIn, audioFadeOut };
    });
    return { ...t, clips };
  }

  function onAudioTrimMove(clientX: number) {
    const d = audioDragRef.current;
    if (!d) return;
    if (timeline.audioLinked !== false || !Array.isArray(timeline.audioClips)) return;
    const clip = timeline.audioClips.find((c) => c.id === d.clipId);
    if (!clip) return;
    const asset = assetsById.get(clip.assetId);
    const maxOut = asset?.durationSeconds || Number.POSITIVE_INFINITY;
    const dx = clientX - d.startX;
    const delta = dx * d.secondsPerPx;
    const minLen = 0.2;

    let nextIn = clip.sourceIn;
    let nextOut = clip.sourceOut;
    const startOutBounded = Math.min(d.startOut, maxOut);
    if (d.handle === "in") {
      nextIn = clamp(d.startIn + delta, 0, startOutBounded - minLen);
    }
    if (d.handle === "out") {
      nextOut = clamp(d.startOut + delta, d.startIn + minLen, maxOut);
    }

    d.didMove = true;
    setTimeline((t) => updateAudioClipById(t, d.clipId, { sourceIn: nextIn, sourceOut: nextOut }));
  }

  function endAudioTrimDrag() {
    const d = audioDragRef.current;
    if (!d) return;
    audioDragRef.current = null;
    if (!d.didMove) return;
    setPast((p) => [...p, d.prevState].slice(-80));
    setFuture([]);
    setExportUrl(null);
    setExportError(null);
  }

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
      prevState: { timeline, selectedClipId, selectedAudioClipId },
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

  useEffect(() => {
    const onMove = (e: PointerEvent) => onAudioTrimMove(e.clientX);
    const onUp = () => endAudioTrimDrag();
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
          syncUnlinkedAudio(t, false);
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
        syncUnlinkedAudio(t, true);
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

              <button
                className="tool"
                onClick={splitSelectionAtPlayhead}
                disabled={!selectedClip && !(timeline.audioLinked === false && !!selectedUnlinkedAudioClip)}
              >
                Split
              </button>
              <button
                className="tool"
                onClick={deleteSelection}
                disabled={!selectedClip && !(timeline.audioLinked === false && !!selectedUnlinkedAudioClip)}
              >
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
              audioClips={audioClips}
              durationSeconds={duration}
              zoom={timelineZoom}
              snappingEnabled={snappingEnabled}
              altDown={altDown}
              getAsset={(assetId) => assetsById.get(assetId) ?? null}
              offsets={offsets}
              selectedClipId={selectedClipId}
              selectedAudioClipId={selectedAudioClipId}
              playheadSeconds={playheadProjectTime}
              onSelect={async (id) => {
                setSelectedClipId(id);
                setSelectedAudioClipId(null);
                const clip = timeline.clips.find((c) => c.id === id);
                if (!clip) return;
                const asset = assetsById.get(clip.assetId);
                if (!asset) return;
                await startClipPlayback(clip, timeline.clips.findIndex((c) => c.id === id), "sequence");
              }}
              onSelectAudio={(id) => {
                setSelectedAudioClipId(id);
                if (String(id).startsWith("linked-")) setSelectedClipId(String(id).slice("linked-".length));
                else setSelectedClipId(null);
              }}
              onToggleAudioLink={toggleAudioLink}
              onToggleTrackMute={() => {
                applyWithHistory({
                  timeline: { ...timeline, trackAudioMuted: !timeline.trackAudioMuted },
                  selectedClipId,
                  selectedAudioClipId
                });
              }}
              onPatchTrackAudioVolumeLive={(volume) => {
                setTimeline((t) => sanitizeTimelineIfNeeded({ ...t, trackAudioVolume: volume }));
              }}
              onPatchAudioFadeLive={(id, patch) => {
                if (String(id).startsWith("linked-")) {
                  const clipId = String(id).slice("linked-".length);
                  setTimeline((t) =>
                    updateLinkedClipAudioById(t, clipId, {
                      audioFadeIn: patch.fadeIn,
                      audioFadeOut: patch.fadeOut
                    })
                  );
                  return;
                }
                setTimeline((t) => updateAudioClipById(t, id, patch));
              }}
              onToggleAudioMute={(id) => {
                if (String(id).startsWith("linked-")) {
                  const clipId = String(id).slice("linked-".length);
                  const cur = timeline.clips.find((c) => c.id === clipId);
                  if (!cur) return;
                  const next = updateLinkedClipAudioById(timeline, clipId, { audioMuted: !Boolean(cur.audioMuted) });
                  applyWithHistory({ timeline: next, selectedClipId, selectedAudioClipId });
                  return;
                }
                if (timeline.audioLinked !== false || !Array.isArray(timeline.audioClips)) return;
                const cur = timeline.audioClips.find((c) => c.id === id);
                if (!cur) return;
                const next = updateAudioClipById(timeline, id, { muted: !Boolean(cur.muted) });
                applyWithHistory({ timeline: next, selectedClipId, selectedAudioClipId: id });
              }}
              getHistoryState={() => ({ timeline, selectedClipId, selectedAudioClipId })}
              onCommitHistory={(prev) => {
                setPast((p) => [...p, prev].slice(-80));
                setFuture([]);
                setExportUrl(null);
                setExportError(null);
              }}
              onPatchAudioVolumeLive={(id, patch) => {
                if (String(id).startsWith("linked-")) {
                  const clipId = String(id).slice("linked-".length);
                  setTimeline((t) => updateLinkedClipAudioById(t, clipId, { audioVolume: patch.volume ?? 1 }));
                  return;
                }
                setTimeline((t) => updateAudioClipById(t, id, patch));
              }}
              onScrub={(t, play) => scrubToProjectTime(t, play)}
              onBeginDrag={(clipId, handle, startX) => beginTrimDrag(clipId, handle, startX)}
              onBeginAudioDrag={(clipId, handle, startX) => beginAudioTrimDrag(clipId, handle, startX)}
              onDropVideoPayload={async (payload, t) => {
                if (payload.kind === "asset") await insertAssetAtTime(payload.assetId, t);
                if (payload.kind === "clip") await reorderClipToTime(payload.clipId, t);
              }}
              onDropAudioPayload={async (payload, t) => {
                if (payload.kind === "asset") await insertAssetAudioAtTime(payload.assetId, t);
                if (payload.kind === "audio_clip") await reorderAudioClipToTime(payload.clipId, t);
              }}
              getGhostLenSeconds={(payload) => {
                if (payload.kind === "asset") return assetsById.get(payload.assetId)?.durationSeconds ?? null;
                if (payload.kind === "clip") {
                  const c = timeline.clips.find((x) => x.id === payload.clipId);
                  if (!c) return null;
                  return Math.max(0.2, c.sourceOut - c.sourceIn);
                }
                const c = (timeline.audioClips || []).find((x) => x.id === payload.clipId);
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
  audioClips,
  durationSeconds,
  zoom,
  snappingEnabled,
  altDown,
  getAsset,
  offsets,
  selectedClipId,
  selectedAudioClipId,
  playheadSeconds,
  onSelect,
  onSelectAudio,
  onToggleAudioLink,
  onToggleTrackMute,
  onPatchTrackAudioVolumeLive,
  onPatchAudioFadeLive,
  onToggleAudioMute,
  getHistoryState,
  onCommitHistory,
  onPatchAudioVolumeLive,
  onScrub,
  onBeginDrag,
  onBeginAudioDrag,
  onDropVideoPayload,
  onDropAudioPayload,
  getGhostLenSeconds,
  getDragData,
  getCurrentDrag,
  onAnyDragStart,
  onAnyDragEnd
}: {
  refEl: MutableRefObject<HTMLDivElement | null>;
  timeline: ProjectTimeline;
  audioClips: AudioClip[];
  durationSeconds: number;
  zoom: number;
  snappingEnabled: boolean;
  altDown: boolean;
  getAsset: (assetId: string) => Asset | null;
  offsets: Map<string, number>;
  selectedClipId: string | null;
  selectedAudioClipId: string | null;
  playheadSeconds: number;
  onSelect: (id: string) => void;
  onSelectAudio: (id: string) => void;
  onToggleAudioLink: () => void;
  onToggleTrackMute: () => void;
  onPatchTrackAudioVolumeLive: (volume: number) => void;
  onPatchAudioFadeLive: (id: string, patch: Partial<Pick<AudioClip, "fadeIn" | "fadeOut">>) => void;
  onToggleAudioMute: (id: string) => void;
  getHistoryState: () => HistoryState;
  onCommitHistory: (prev: HistoryState) => void;
  onPatchAudioVolumeLive: (id: string, patch: Partial<Pick<AudioClip, "volume">>) => void;
  onScrub: (t: number, play: boolean) => void;
  onBeginDrag: (clipId: string, handle: "in" | "out", startX: number) => void;
  onBeginAudioDrag: (clipId: string, handle: "in" | "out", startX: number) => void;
  onDropVideoPayload: (payload: DragPayload, projectTime: number) => void;
  onDropAudioPayload: (payload: DragPayload, projectTime: number) => void;
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
  const [dropLane, setDropLane] = useState<"video" | "audio">("video");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragDepthRef = useRef(0);
  const [snapFlashAt, setSnapFlashAt] = useState<number | null>(null);
  const laneVideoRef = useRef<HTMLDivElement | null>(null);
  const laneAudioRef = useRef<HTMLDivElement | null>(null);
  const audioVolDragRef = useRef<null | { clipId: string; pointerId: number; prev: HistoryState }>(null);
  const trackVolDragRef = useRef<null | { pointerId: number; prev: HistoryState }>(null);
  const audioFadeDragRef = useRef<null | { clipId: string; side: "in" | "out"; pointerId: number; prev: HistoryState; startFade: number; clipLen: number }>(null);

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

  function waveformStyle(asset: Asset | null, clip: { sourceIn: number; sourceOut: number }) {
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

  function isOverLane(ref: MutableRefObject<HTMLDivElement | null>, clientY: number) {
    const el = ref.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return clientY >= r.top && clientY <= r.bottom;
  }

  function resolveDropLane(payload: DragPayload, clientY: number): "video" | "audio" {
    if (payload.kind === "clip") return "video";
    if (payload.kind === "audio_clip") return "audio";
    const overAudio = isOverLane(laneAudioRef, clientY);
    if (!overAudio) return "video";
    if (timeline.audioLinked !== false) return "video";
    const a = getAsset(payload.assetId);
    if (!a?.hasAudio) return "video";
    return "audio";
  }

  function volumeToYPercent(volume: number | undefined) {
    const v = clamp(Number.isFinite(volume as any) ? (volume as any) : 1, 0, 2);
    const y = (1 - v / 2) * 100;
    return clamp(y, 8, 92);
  }

  function yClientToVolume(clientY: number, rect: DOMRect) {
    const y = clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1);
    // Top = 200%, bottom = 0%
    const v = (1 - y) * 2;
    return clamp(v, 0, 2);
  }

  function secsToXPercent(secs: number, clipLen: number) {
    if (!Number.isFinite(secs) || secs <= 0) return 0;
    const len = Math.max(0.001, clipLen);
    return clamp((secs / len) * 100, 0, 48);
  }

  return (
    <div className="timelineStripWrap">
      <div className="timelineStripGrid">
        <div className="trackRail" aria-label="Tracks">
          <div className="trackRailRow">
            <div className="trackLabel" aria-hidden="true">V1</div>
          </div>
          <div className="trackRailRow">
            <div className="trackLabel" aria-hidden="true">A1</div>
            <div
              className="trackVolControl"
              role="slider"
              tabIndex={0}
              aria-label="Track volume"
              aria-valuemin={0}
              aria-valuemax={200}
              aria-valuenow={Math.round(clamp((timeline.trackAudioVolume ?? 1) * 100, 0, 200))}
              aria-valuetext={`${Math.round(clamp((timeline.trackAudioVolume ?? 1) * 100, 0, 200))}% track volume`}
              style={{ ["--volY" as any]: `${volumeToYPercent(timeline.trackAudioVolume).toFixed(2)}%` } as any}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const prev = getHistoryState();
                trackVolDragRef.current = { pointerId: e.pointerId, prev };
                (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                onPatchTrackAudioVolumeLive(yClientToVolume(e.clientY, rect));
              }}
              onPointerMove={(e) => {
                const d = trackVolDragRef.current;
                if (!d || d.pointerId !== e.pointerId) return;
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                onPatchTrackAudioVolumeLive(yClientToVolume(e.clientY, rect));
              }}
              onPointerUp={(e) => {
                const d = trackVolDragRef.current;
                if (!d || d.pointerId !== e.pointerId) return;
                trackVolDragRef.current = null;
                try {
                  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
                } catch {}
                onCommitHistory(d.prev);
              }}
              onPointerCancel={(e) => {
                const d = trackVolDragRef.current;
                if (!d || d.pointerId !== e.pointerId) return;
                trackVolDragRef.current = null;
                try {
                  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
                } catch {}
                onCommitHistory(d.prev);
              }}
              onKeyDown={(e) => {
                if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                e.preventDefault();
                const dir = e.key === "ArrowUp" ? 1 : -1;
                const cur = clamp(Number.isFinite(timeline.trackAudioVolume as any) ? (timeline.trackAudioVolume as any) : 1, 0, 2);
                const next = clamp(cur + dir * 0.05, 0, 2);
                const prev = getHistoryState();
                onPatchTrackAudioVolumeLive(next);
                onCommitHistory(prev);
              }}
            >
              <div className="trackVolLine" aria-hidden="true" />
            </div>
            <button
              type="button"
              className={`trackBtn ${timeline.trackAudioMuted ? "on" : ""}`}
              onClick={onToggleTrackMute}
              aria-pressed={Boolean(timeline.trackAudioMuted)}
              title={timeline.trackAudioMuted ? "Unmute track" : "Mute track"}
            >
              {timeline.trackAudioMuted ? "Muted" : "Audio"}
            </button>
            <button
              type="button"
              className={`trackBtn ${timeline.audioLinked === false ? "on" : ""}`}
              onClick={onToggleAudioLink}
              aria-pressed={timeline.audioLinked === false}
              title={timeline.audioLinked === false ? "Relink audio to video" : "Unlink audio to edit separately"}
            >
              {timeline.audioLinked === false ? "Unlinked" : "Linked"}
            </button>
          </div>
        </div>

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
            setDropLane(resolveDropLane(payload, e.clientY));
            setDropAt(snapProjectTime(clientXToProjectTime(e.clientX)));
            setDropPayload(payload);
          }}
          onDragLeave={() => {
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) {
              setDropAt(null);
              setDropPayload(null);
              setDropLane("video");
            }
          }}
          onDrop={(e) => {
            const payload = getCurrentDrag() || getDragData(e);
            if (!payload) return;
            e.preventDefault();
            const t = snapProjectTime(clientXToProjectTime(e.clientX));
            const lane = resolveDropLane(payload, e.clientY);
            setDropAt(null);
            setDropPayload(null);
            setDropLane("video");
            setDraggingId(null);
            dragDepthRef.current = 0;
            if (lane === "audio") onDropAudioPayload(payload, t);
            else onDropVideoPayload(payload, t);
            onAnyDragEnd();
          }}
        >
          <div className="timelineStripInner" style={{ width: pct(zoom) } as any}>
            {timeline.clips.length === 0 ? (
              <div className="timelineEmptyDrop" aria-hidden="true">
                Drop clips here
              </div>
            ) : null}

            <div className="lane laneVideo" aria-label="Video track" role="list" ref={laneVideoRef}>
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

              {dropAt != null && dropPayload && dropLane === "video"
                ? (() => {
                    const len = getGhostLenSeconds(dropPayload);
                    if (!len || !Number.isFinite(len) || len <= 0) return null;
                    const idx = computeDropIndex(dropAt);
                    const leftSeconds = indexToLeftSeconds(idx);
                    const left = clamp(leftSeconds / duration, 0, 1);
                    // When the timeline is empty, treat the ghost as a medium-size block.
                    const width = timeline.clips.length === 0 ? 0.35 : clamp(len / duration, 0.01, 0.9);
                    return <div className="ghostClip" style={{ left: pct(left), width: pct(width) } as any} aria-hidden="true" />;
                  })()
                : null}
            </div>

            <div className={`lane laneAudio ${timeline.audioLinked === false ? "isEditable" : ""}`} aria-label="Audio track" role="list" ref={laneAudioRef}>
              {audioClips.map((c) => {
                const len = Math.max(0.001, c.sourceOut - c.sourceIn);
                const left = clamp((c.start ?? 0) / duration, 0, 1);
                const width = clamp(len / duration, 0.002, 1);
                const asset = getAsset(c.assetId);
                const ws = waveformStyle(asset, c);
                const has = Boolean(asset?.hasAudio);
                const movable = timeline.audioLinked === false && !String(c.id).startsWith("linked-");
                const isSelected = c.id === selectedAudioClipId;
                const yPct = volumeToYPercent(c.volume);
                const fadeIn = clamp(Number.isFinite(c.fadeIn as any) ? (c.fadeIn as any) : 0, 0, len / 2);
                const fadeOut = clamp(Number.isFinite(c.fadeOut as any) ? (c.fadeOut as any) : 0, 0, len / 2);
                const fadeInPct = secsToXPercent(fadeIn, len);
                const fadeOutPct = secsToXPercent(fadeOut, len);
                return (
                  <div
                    key={c.id}
                    className={`audioClip ${has ? "has" : "none"} ${c.muted ? "isMuted" : ""} ${isSelected ? "isSelected" : ""} ${draggingId === c.id ? "isDragging" : ""}`}
                    style={{
                      left: pct(left),
                      width: pct(width),
                      ...(ws ?? {}),
                      ["--volY" as any]: `${yPct.toFixed(2)}%`,
                      ["--fadeInW" as any]: `${fadeInPct.toFixed(2)}%`,
                      ["--fadeOutW" as any]: `${fadeOutPct.toFixed(2)}%`
                    } as any}
                    role="listitem"
                    title={`${c.label} (${fmt(len)})`}
                    draggable={movable}
                    onDragStart={(e) => {
                      if (!movable) return;
                      onAnyDragStart({ kind: "audio_clip", clipId: c.id });
                      setDraggingId(c.id);
                      try {
                        const raw = JSON.stringify({ kind: "audio_clip", clipId: c.id });
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
                      onSelectAudio(c.id);
                    }}
                  >
                    {movable ? (
                      <>
                        <div
                          className="tlHandle left audioHandle"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            e.preventDefault(); // prevent native drag start
                            onSelectAudio(c.id);
                            onBeginAudioDrag(c.id, "in", e.clientX);
                          }}
                          aria-label="Trim audio in"
                          draggable={false}
                        />
                        <div className="tlLabel audioLabel">{c.label}</div>
                        <div
                          className="tlHandle right audioHandle"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            e.preventDefault(); // prevent native drag start
                            onSelectAudio(c.id);
                            onBeginAudioDrag(c.id, "out", e.clientX);
                          }}
                          aria-label="Trim audio out"
                          draggable={false}
                        />
                      </>
                    ) : null}
                    {/* Fade handles (both linked+unlinked) */}
                    <div
                      className="fadeHandle left"
                      role="slider"
                      tabIndex={0}
                      aria-label="Fade in"
                      aria-valuemin={0}
                      aria-valuemax={Math.round((len / 2) * 1000) / 1000}
                      aria-valuenow={Math.round(fadeIn * 1000) / 1000}
                      title="Fade in (drag)"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        const prev = getHistoryState();
                        audioFadeDragRef.current = { clipId: c.id, side: "in", pointerId: e.pointerId, prev, startFade: fadeIn, clipLen: len };
                        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                      }}
                      onPointerMove={(e) => {
                        const d = audioFadeDragRef.current;
                        if (!d || d.clipId !== c.id || d.pointerId !== e.pointerId) return;
                        const parent = (e.currentTarget.parentElement as HTMLElement | null);
                        if (!parent) return;
                        const rect = parent.getBoundingClientRect();
                        const x = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
                        const next = clamp(x * d.clipLen, 0, d.clipLen / 2);
                        // route patch to linked/unlinked
                        onPatchAudioFadeLive(c.id, { fadeIn: next });
                      }}
                      onPointerUp={(e) => {
                        const d = audioFadeDragRef.current;
                        if (!d || d.clipId !== c.id || d.pointerId !== e.pointerId) return;
                        audioFadeDragRef.current = null;
                        try { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); } catch {}
                        onCommitHistory(d.prev);
                      }}
                      onPointerCancel={(e) => {
                        const d = audioFadeDragRef.current;
                        if (!d || d.clipId !== c.id || d.pointerId !== e.pointerId) return;
                        audioFadeDragRef.current = null;
                        try { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); } catch {}
                        onCommitHistory(d.prev);
                      }}
                    />
                    <div
                      className="fadeHandle right"
                      role="slider"
                      tabIndex={0}
                      aria-label="Fade out"
                      aria-valuemin={0}
                      aria-valuemax={Math.round((len / 2) * 1000) / 1000}
                      aria-valuenow={Math.round(fadeOut * 1000) / 1000}
                      title="Fade out (drag)"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        const prev = getHistoryState();
                        audioFadeDragRef.current = { clipId: c.id, side: "out", pointerId: e.pointerId, prev, startFade: fadeOut, clipLen: len };
                        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                      }}
                      onPointerMove={(e) => {
                        const d = audioFadeDragRef.current;
                        if (!d || d.clipId !== c.id || d.pointerId !== e.pointerId) return;
                        const parent = (e.currentTarget.parentElement as HTMLElement | null);
                        if (!parent) return;
                        const rect = parent.getBoundingClientRect();
                        const x = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
                        const secs = clamp((1 - x) * d.clipLen, 0, d.clipLen / 2);
                        onPatchAudioFadeLive(c.id, { fadeOut: secs });
                      }}
                      onPointerUp={(e) => {
                        const d = audioFadeDragRef.current;
                        if (!d || d.clipId !== c.id || d.pointerId !== e.pointerId) return;
                        audioFadeDragRef.current = null;
                        try { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); } catch {}
                        onCommitHistory(d.prev);
                      }}
                      onPointerCancel={(e) => {
                        const d = audioFadeDragRef.current;
                        if (!d || d.clipId !== c.id || d.pointerId !== e.pointerId) return;
                        audioFadeDragRef.current = null;
                        try { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); } catch {}
                        onCommitHistory(d.prev);
                      }}
                    />
                    <div className="audioVolLine" aria-hidden="true" />
                    <div
                      className="audioVolHit"
                      role="slider"
                      aria-label="Clip volume"
                      aria-valuemin={0}
                      aria-valuemax={200}
                      aria-valuenow={Math.round(clamp((c.volume ?? 1) * 100, 0, 200))}
                      aria-valuetext={`${Math.round(clamp((c.volume ?? 1) * 100, 0, 200))}%${c.muted ? " (muted)" : ""}. Double-click to toggle mute.`}
                      tabIndex={0}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        onToggleAudioMute(c.id);
                      }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        const rect = (e.currentTarget.parentElement as HTMLElement | null)?.getBoundingClientRect();
                        if (!rect) return;
                        const prev = getHistoryState();
                        audioVolDragRef.current = { clipId: c.id, pointerId: e.pointerId, prev };
                        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                        const v = yClientToVolume(e.clientY, rect);
                        onPatchAudioVolumeLive(c.id, { volume: v });
                      }}
                      onPointerMove={(e) => {
                        const d = audioVolDragRef.current;
                        if (!d || d.clipId !== c.id || d.pointerId !== e.pointerId) return;
                        const rect = (e.currentTarget.parentElement as HTMLElement | null)?.getBoundingClientRect();
                        if (!rect) return;
                        const v = yClientToVolume(e.clientY, rect);
                        onPatchAudioVolumeLive(c.id, { volume: v });
                      }}
                      onPointerUp={(e) => {
                        const d = audioVolDragRef.current;
                        if (!d || d.clipId !== c.id || d.pointerId !== e.pointerId) return;
                        audioVolDragRef.current = null;
                        try {
                          (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
                        } catch {}
                        onCommitHistory(d.prev);
                      }}
                      onPointerCancel={(e) => {
                        const d = audioVolDragRef.current;
                        if (!d || d.clipId !== c.id || d.pointerId !== e.pointerId) return;
                        audioVolDragRef.current = null;
                        try {
                          (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
                        } catch {}
                        onCommitHistory(d.prev);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onToggleAudioMute(c.id);
                          return;
                        }
                        // basic keyboard volume steps
                        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                        e.preventDefault();
                        const dir = e.key === "ArrowUp" ? 1 : -1;
                        const cur = clamp(Number.isFinite(c.volume as any) ? (c.volume as any) : 1, 0, 2);
                        const next = clamp(cur + dir * 0.05, 0, 2);
                        const prev = getHistoryState();
                        onPatchAudioVolumeLive(c.id, { volume: next });
                        onCommitHistory(prev);
                      }}
                    />
                  </div>
                );
              })}

              {dropAt != null && dropPayload && dropLane === "audio"
                ? (() => {
                    const len = getGhostLenSeconds(dropPayload);
                    if (!len || !Number.isFinite(len) || len <= 0) return null;
                    const left = clamp(dropAt / duration, 0, 1);
                    const width = clamp(len / duration, 0.01, 0.9);
                    return <div className="ghostClip" style={{ left: pct(left), width: pct(width) } as any} aria-hidden="true" />;
                  })()
                : null}
            </div>

            <div className="playhead" style={{ left: pct(playheadX) } as any} aria-hidden="true" />
            {dropAt != null ? (
              <div className="dropMarker" style={{ left: pct(clamp(dropAt / duration, 0, 1)) } as any} aria-hidden="true" />
            ) : null}
            {snapFlashAt != null ? (
              <div className="snapFlash" style={{ left: pct(clamp(snapFlashAt / duration, 0, 1)) } as any} aria-hidden="true" />
            ) : null}
          </div>
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
