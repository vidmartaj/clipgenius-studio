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

export default function StudioPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bgVideoRef = useRef<HTMLVideoElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const pendingSeekRef = useRef<PendingSeek | null>(null);

  const [assets, setAssets] = useState<Asset[]>([]);
  const assetsById = useMemo(() => new Map(assets.map((a) => [a.assetId, a])), [assets]);

  const [timeline, setTimeline] = useState<ProjectTimeline>({ projectId: "local", clips: [] });
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  const [playerSrc, setPlayerSrc] = useState<string | null>(null);
  const [timelineZoom, setTimelineZoom] = useState(1.6);
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

  // Keep the preview synced to the selected timeline clip (when we're not actively previewing playback).
  useEffect(() => {
    if (!selectedClip || !selectedAsset) return;
    if (previewRef.current.enabled) return;
    void ensurePlayerOnAsset(selectedAsset, selectedClip.sourceIn, false);
  }, [selectedClipId, selectedAsset?.assetId]);

  // ---- Undo / redo ----
  function applyWithHistory(next: { timeline: ProjectTimeline; selectedClipId: string | null }) {
    setPast((p) => [...p, { timeline, selectedClipId }].slice(-80));
    setFuture([]);
    setTimeline(next.timeline);
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
      v.currentTime = clamp(seekTo, 0, Number.isFinite(v.duration) ? v.duration : seekTo);
      if (play) v.play().catch(() => {});
      if (bg) {
        bg.currentTime = clamp(seekTo, 0, Number.isFinite(bg.duration) ? bg.duration : seekTo);
        if (play) bg.play().catch(() => {});
        else bg.pause();
      }
      pendingSeekRef.current = null;
    }
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
      analysis?: AnalysisTimeline | null;
    };

    const analysis = data.analysis ?? null;
    const durationSeconds = analysis?.durationSeconds ?? 0;

    const asset: Asset = {
      assetId: data.assetId,
      name: file.name || "Untitled",
      videoUrl: data.videoUrl,
      durationSeconds,
      analysis
    };
    setAssets((prev) => [...prev, asset]);

    // Auto-add to project timeline like CapCut: import -> clip appears ready to edit.
    if (durationSeconds > 0) {
      const clip: ProjectClip = {
        id: crypto.randomUUID(),
        assetId: asset.assetId,
        label: cleanName(asset.name),
        sourceIn: 0,
        sourceOut: durationSeconds
      };
      setTimeline((t) => ({ ...t, clips: [...t.clips, clip] }));
      setSelectedClipId(clip.id);
      await ensurePlayerOnAsset(asset, 0, false);
    } else {
      // If duration wasn't known (rare), still select player source.
      setSelectedClipId(null);
      await ensurePlayerOnAsset(asset, 0, false);
    }

    setChat((prev) => [
      ...prev,
      { role: "ai", text: "Imported. Tell me what you’re making (Reels/TikTok/YouTube) and the vibe (hype/cinematic/clean)." }
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
    const t = clamp(v.currentTime || 0, 0, selectedClip.sourceOut - 0.2);
    const next = updateClipById(timeline, selectedClip.id, { sourceIn: t });
    applyWithHistory({ timeline: next, selectedClipId: selectedClip.id });
  }

  function setOutToPlayhead() {
    const v = videoRef.current;
    if (!v || !selectedClip) return;
    const t = clamp(v.currentTime || 0, selectedClip.sourceIn + 0.2, selectedClip.sourceOut + 10_000);
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
    previewRef.current = {
      enabled: true,
      mode,
      idx: clipIndex,
      clipId: clip.id,
      clipOffset,
      stopAtSourceOut: clip.sourceOut
    };
    setIsPreviewing(true);
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
  }

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const epsilon = 0.05;

    const onTimeUpdate = async () => {
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
        const nextIdx = state.idx + 1;
        const next = timeline.clips[nextIdx];
        if (!next) {
          stopPreview();
          return;
        }
        await startClipPlayback(next, nextIdx, "sequence");
      }
    };

    v.addEventListener("timeupdate", () => void onTimeUpdate());
    v.addEventListener("ended", stopPreview);
    return () => {
      v.removeEventListener("ended", stopPreview);
      // timeupdate listener uses inline wrapper; acceptable for MVP.
    };
  }, [timeline, duration, offsets, assetsById]);

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
    const dx = clientX - d.startX;
    const delta = dx * d.secondsPerPx;
    const minLen = 0.2;

    let nextIn = clip.sourceIn;
    let nextOut = clip.sourceOut;
    if (d.handle === "in") nextIn = clamp(d.startIn + delta, 0, d.startOut - minLen);
    if (d.handle === "out") nextOut = Math.max(d.startIn + minLen, d.startOut + delta);

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
          await ensurePlayerOnAsset(asset, c.sourceIn + within, false);
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
                      const clip: ProjectClip = {
                        id: crypto.randomUUID(),
                        assetId: a.assetId,
                        label: cleanName(a.name),
                        sourceIn: 0,
                        sourceOut: a.durationSeconds
                      };
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
                      onPlay={() => bgVideoRef.current?.play().catch(() => {})}
                      onPause={() => bgVideoRef.current?.pause()}
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
  offsets,
  selectedClipId,
  playheadSeconds,
  onSelect,
  onScrub,
  onBeginDrag
}: {
  refEl: MutableRefObject<HTMLDivElement | null>;
  timeline: ProjectTimeline;
  durationSeconds: number;
  zoom: number;
  offsets: Map<string, number>;
  selectedClipId: string | null;
  playheadSeconds: number;
  onSelect: (id: string) => void;
  onScrub: (t: number, play: boolean) => void;
  onBeginDrag: (clipId: string, handle: "in" | "out", startX: number) => void;
}) {
  const duration = Math.max(0.001, durationSeconds || 0.001);
  const playheadX = clamp(playheadSeconds / duration, 0, 1);
  const scrubRef = useRef<null | { startX: number; moved: boolean }>(null);

  function clientXToProjectTime(clientX: number) {
    const el = refEl.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const xPx = (clientX - rect.left) + (el.scrollLeft || 0);
    const x = clamp(xPx / Math.max(1, el.scrollWidth || rect.width), 0, 1);
    return x * duration;
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
      >
        <div className="timelineStripInner" style={{ width: pct(zoom) } as any}>
          {timeline.clips.map((c) => {
            const clipOffset = offsets.get(c.id) ?? 0;
            const len = Math.max(0.001, c.sourceOut - c.sourceIn);
            const left = clamp(clipOffset / duration, 0, 1);
            const width = clamp(len / duration, 0.002, 1);
            const isSelected = c.id === selectedClipId;
            return (
              <div
                key={c.id}
                className={`tlClip ${isSelected ? "isSelected" : ""}`}
                style={{ left: pct(left), width: pct(width) } as any}
                role="listitem"
                title={`${c.label} (${fmt(len)})`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onSelect(c.id);
                }}
              >
                <div
                  className="tlHandle left"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onSelect(c.id);
                    onBeginDrag(c.id, "in", e.clientX);
                  }}
                  aria-label="Trim in"
                />
                <div className="tlLabel">{c.label}</div>
                <div
                  className="tlHandle right"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onSelect(c.id);
                    onBeginDrag(c.id, "out", e.clientX);
                  }}
                  aria-label="Trim out"
                />
              </div>
            );
          })}

          <div className="playhead" style={{ left: pct(playheadX) } as any} aria-hidden="true" />
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
