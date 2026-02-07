"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { AssistantReply, Timeline, TimelineClip } from "../../lib/types";
import { splitClipAt, trimTimelineToTargetSeconds } from "../../lib/timeline";

type ExportSettings = {
  resolution: "720p" | "1080p" | "4K";
  format: "MP4";
};

const DEFAULT_EXPORT: ExportSettings = { resolution: "720p", format: "MP4" };

type Asset = {
  id: string;
  name: string;
  videoUrl: string;
  timeline: Timeline | null;
};

type HistoryState = {
  timeline: Timeline | null;
  selectedClipId: string | null;
};

export default function StudioPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const previewStateRef = useRef<{
    enabled: boolean;
    mode: "sequence" | "single";
    idx: number;
    singleEnd: number | null;
  }>({ enabled: false, mode: "sequence", idx: 0, singleEnd: null });

  const [assets, setAssets] = useState<Asset[]>([]);
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [editedPreviewOn, setEditedPreviewOn] = useState(false);

  const [past, setPast] = useState<HistoryState[]>([]);
  const [future, setFuture] = useState<HistoryState[]>([]);
  const dragRef = useRef<null | {
    clipId: string;
    handle: "in" | "out";
    startX: number;
    start: number;
    end: number;
    prevState: HistoryState;
    didMove: boolean;
  }>(null);

  const [exportSettings, setExportSettings] = useState<ExportSettings>(DEFAULT_EXPORT);
  const [isExporting, setIsExporting] = useState(false);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const activeAsset = useMemo(() => {
    if (!activeAssetId) return null;
    return assets.find((a) => a.id === activeAssetId) ?? null;
  }, [assets, activeAssetId]);

  const projectId = activeAsset?.id ?? null;
  const videoUrl = activeAsset?.videoUrl ?? null;
  const timeline = activeAsset?.timeline ?? null;

  const [chatInput, setChatInput] = useState("");
  const [chat, setChat] = useState<Array<{ role: "ai" | "user"; text: string }>>([
    {
      role: "ai",
      text: "Upload a clip and I’ll draft a highlight timeline. Then tell me how to improve it."
    }
  ]);

  const selectedClip = useMemo(() => {
    if (!timeline || !selectedClipId) return null;
    return timeline.clips.find((c) => c.id === selectedClipId) ?? null;
  }, [timeline, selectedClipId]);

  const totalDuration = timeline?.durationSeconds ?? 0;

  useEffect(() => {
    // Keep selection valid.
    if (timeline && selectedClipId) {
      const exists = timeline.clips.some((c) => c.id === selectedClipId);
      if (!exists) setSelectedClipId(timeline.clips[0]?.id ?? null);
    }
  }, [timeline, selectedClipId]);

  function setActiveTimeline(nextTimeline: Timeline | null) {
    if (!activeAssetId) return;
    setAssets((prev) => prev.map((a) => (a.id === activeAssetId ? { ...a, timeline: nextTimeline } : a)));
  }

  function undo() {
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      setFuture((f) => [{ timeline, selectedClipId }, ...f].slice(0, 50));
      setActiveTimeline(prev.timeline);
      setSelectedClipId(prev.selectedClipId);
      stopEditedPreview();
      setExportUrl(null);
      setExportError(null);
      return p.slice(0, -1);
    });
  }

  function redo() {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      setPast((p) => [...p, { timeline, selectedClipId }].slice(-50));
      setActiveTimeline(next.timeline);
      setSelectedClipId(next.selectedClipId);
      stopEditedPreview();
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

  function applyWithHistory(next: HistoryState) {
    setPast((p) => [...p, { timeline, selectedClipId }].slice(-50));
    setFuture([]);
    setActiveTimeline(next.timeline);
    setSelectedClipId(next.selectedClipId);
    stopEditedPreview();
    setExportUrl(null);
    setExportError(null);
  }

  async function onPickFile(file?: File) {
    if (!file) return;
    setIsUploading(true);
    setUploadError(null);
    setExportUrl(null);
    setExportError(null);

    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as {
        projectId: string;
        videoUrl: string;
        timeline?: Timeline | null;
      };

      const asset: Asset = {
        id: data.projectId,
        name: file.name || "Untitled",
        videoUrl: data.videoUrl,
        timeline: data.timeline && data.timeline.clips?.length ? data.timeline : null
      };
      setAssets((prev) => [...prev, asset]);
      setActiveAssetId(asset.id);
      setSelectedClipId(asset.timeline?.clips?.[0]?.id ?? null);
      setPast([]);
      setFuture([]);
      stopEditedPreview();

      // If upload returned no timeline, we'll build a simple placeholder after metadata loads.

      setChat((prev) => [
        ...prev,
        { role: "ai", text: "Nice — file loaded. How do you want the first edit to feel (fast-paced, cinematic, vlog)?" }
      ]);
    } catch (e: any) {
      setUploadError(e?.message ?? "Upload failed");
    } finally {
      setIsUploading(false);
    }
  }

  function onLoadedMetadata() {
    const v = videoRef.current;
    if (!v || !activeAssetId) return;
    const durationSeconds = Number.isFinite(v.duration) ? v.duration : 0;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return;

    setAssets((prev) =>
      prev.map((a) => {
        if (a.id !== activeAssetId) return a;
        const t = a.timeline;
        if (!t || !t.clips?.length) {
          const placeholder: Timeline = {
            projectId: a.id,
            durationSeconds,
            clips: [
              { id: crypto.randomUUID(), label: "Full Clip", kind: "source", start: 0, end: durationSeconds }
            ]
          };
          return { ...a, timeline: placeholder };
        }
        const prevDuration = t.durationSeconds;
        if (Math.abs(prevDuration - durationSeconds) < 0.01) return a;
        return { ...a, timeline: { ...t, durationSeconds } };
      })
    );
  }

  function seekTo(seconds: number) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(seconds, v.duration || seconds));
    v.play().catch(() => {});
  }

  function stopEditedPreview() {
    previewStateRef.current = { enabled: false, mode: "sequence", idx: 0, singleEnd: null };
    setEditedPreviewOn(false);
  }

  function playEditedSequence() {
    const v = videoRef.current;
    if (!v || !timeline || timeline.clips.length === 0) return;
    previewStateRef.current = { enabled: true, mode: "sequence", idx: 0, singleEnd: null };
    setEditedPreviewOn(true);
    v.currentTime = Math.max(0, timeline.clips[0].start);
    v.play().catch(() => {});
  }

  function playClipPreview(clip: TimelineClip) {
    const v = videoRef.current;
    if (!v) return;
    previewStateRef.current = { enabled: true, mode: "single", idx: 0, singleEnd: clip.end };
    setEditedPreviewOn(true);
    v.currentTime = Math.max(0, clip.start);
    v.play().catch(() => {});
  }

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const onTimeUpdate = () => {
      const state = previewStateRef.current;
      if (!state.enabled || !timeline) return;

      const epsilon = 0.05;

      if (state.mode === "single") {
        const end = state.singleEnd;
        if (end != null && v.currentTime >= end - epsilon) {
          v.pause();
          stopEditedPreview();
        }
        return;
      }

      const clip = timeline.clips[state.idx];
      if (!clip) {
        v.pause();
        stopEditedPreview();
        return;
      }

      if (v.currentTime >= clip.end - epsilon) {
        const nextIdx = state.idx + 1;
        const next = timeline.clips[nextIdx];
        if (!next) {
          v.pause();
          stopEditedPreview();
          return;
        }
        previewStateRef.current = { ...state, idx: nextIdx };
        v.currentTime = Math.max(0, next.start);
        v.play().catch(() => {});
      }
    };

    v.addEventListener("timeupdate", onTimeUpdate);
    v.addEventListener("ended", stopEditedPreview);
    v.addEventListener("pause", () => {
      // If the user manually pauses, keep preview mode state but don't fight them.
    });

    return () => {
      v.removeEventListener("timeupdate", onTimeUpdate);
      v.removeEventListener("ended", stopEditedPreview);
    };
  }, [timeline]);

  function onSplit() {
    const v = videoRef.current;
    if (!v || !timeline || !selectedClip) return;
    const t = v.currentTime || 0;
    const next = splitClipAt(timeline, selectedClip.id, t);
    if (!next) return;
    applyWithHistory({ timeline: next.timeline, selectedClipId: next.newSelectedId });
  }

  function onDeleteClip() {
    if (!timeline || !selectedClip) return;
    const remaining = timeline.clips.filter((c) => c.id !== selectedClip.id);
    if (remaining.length === 0) return;
    applyWithHistory({ timeline: { ...timeline, clips: remaining }, selectedClipId: remaining[0].id });
  }

  function updateSelectedClip(patch: Partial<Pick<TimelineClip, "start" | "end" | "label">>, opts?: { history?: boolean }) {
    if (!timeline || !selectedClip) return;
    const minLen = 0.2;
    let start = patch.start ?? selectedClip.start;
    let end = patch.end ?? selectedClip.end;

    // Clamp to [0, duration] and enforce min length.
    start = clamp(start, 0, Math.max(0, totalDuration));
    end = clamp(end, 0, Math.max(0, totalDuration));
    if (end - start < minLen) {
      if (patch.start != null && patch.end == null) end = start + minLen;
      else if (patch.end != null && patch.start == null) start = end - minLen;
      else end = start + minLen;
    }

    const nextClips = timeline.clips.map((c) =>
      c.id === selectedClip.id ? { ...c, ...patch, start, end } : c
    );
    const nextTimeline = { ...timeline, clips: nextClips };
    if (opts?.history === false) {
      setActiveTimeline(nextTimeline);
    } else {
      applyWithHistory({ timeline: nextTimeline, selectedClipId });
    }
  }

  function setInToPlayhead() {
    const v = videoRef.current;
    if (!v || !selectedClip) return;
    updateSelectedClip({ start: clamp(v.currentTime, 0, selectedClip.end - 0.2) }, { history: true });
  }

  function setOutToPlayhead() {
    const v = videoRef.current;
    if (!v || !selectedClip) return;
    updateSelectedClip({ end: clamp(v.currentTime, selectedClip.start + 0.2, totalDuration) }, { history: true });
  }

  async function sendToAssistant(text: string) {
    if (!timeline) return;
    const userText = text.trim();
    if (!userText) return;

    setChat((prev) => [...prev, { role: "user", text: userText }]);
    setChatInput("");

    const res = await fetch("/api/assistant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId,
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
          t = trimTimelineToTargetSeconds(t, op.targetSeconds);
        }
      }
      applyWithHistory({ timeline: t, selectedClipId: t.clips[0]?.id ?? null });
    }
  }

  async function onExport() {
    if (!timeline || !videoUrl) return;
    setIsExporting(true);
    setExportError(null);
    setExportUrl(null);
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          videoUrl,
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

  return (
    <main className="studio">
      <header className="studioTop" role="banner">
        <div className="filePill">
          <span className={`statusDot ${videoUrl ? "on" : ""}`} aria-hidden="true" />
          <div>
            <div className="fileTitle">
              {activeAsset ? activeAsset.name : (videoUrl ? "File loaded" : "No file loaded")}
            </div>
            <div className="fileSub">
              {videoUrl ? "Ready to edit" : "Upload clips to start"}
            </div>
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
            {isUploading ? "Uploading…" : "Upload"}
          </button>
          <button
            className="btn ghost"
            onClick={() => {
              if (!activeAssetId) return;
              const remaining = assets.filter((a) => a.id !== activeAssetId);
              setAssets(remaining);
              const nextActive = remaining[0]?.id ?? null;
              setActiveAssetId(nextActive);
              setSelectedClipId(remaining[0]?.timeline?.clips?.[0]?.id ?? null);
              stopEditedPreview();
              setPast([]);
              setFuture([]);
              if (videoRef.current) videoRef.current.pause();
            }}
            disabled={!videoUrl || isUploading}
          >
            Remove
          </button>

          <input
            ref={fileInputRef}
            className="fileInput"
            type="file"
            accept="video/*"
            onChange={(e) => onPickFile(e.target.files?.[0])}
          />
        </div>
      </header>

      {uploadError ? <div className="alert" role="alert">{uploadError}</div> : null}

      <section className="shell">
        <aside className="sidebar" aria-label="Tools">
          <div className="sideTitle">Library</div>
          <div className="sideNav" role="list">
            <button className="sideItem isActive" type="button" role="listitem">Footage</button>
            <button className="sideItem" type="button" role="listitem" disabled>Audio</button>
            <button className="sideItem" type="button" role="listitem" disabled>Text</button>
            <button className="sideItem" type="button" role="listitem" disabled>Effects</button>
            <button className="sideItem" type="button" role="listitem" disabled>Transitions</button>
          </div>

          <div className="sideBin">
            <div className="sideBinHead">
              <div className="sideBinTitle">Clips</div>
              <div className="sideBinMeta">{assets.length ? `${assets.length}` : "—"}</div>
            </div>
            <div className="sideBinBody">
              {assets.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`binClip ${a.id === activeAssetId ? "isSelected" : ""}`}
                  onClick={() => {
                    setActiveAssetId(a.id);
                    setSelectedClipId(a.timeline?.clips?.[0]?.id ?? null);
                    setPast([]);
                    setFuture([]);
                    stopEditedPreview();
                    setExportUrl(null);
                    setExportError(null);
                  }}
                  title={a.name}
                >
                  <div className="binClipTitle">{a.name}</div>
                  <div className="binClipSub">{a.timeline ? `${fmt(a.timeline.durationSeconds)} · ${a.timeline.clips.length} clips` : "Processing…"}</div>
                </button>
              ))}
              {assets.length === 0 ? <div className="binEmpty">Upload clips to populate your library.</div> : null}
            </div>
          </div>
        </aside>

        <section className="center">
          <section className="playerCard">
            <div className="player">
              <div className="playerViewport">
                {videoUrl ? (
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    controls
                    onLoadedMetadata={onLoadedMetadata}
                  />
                ) : (
                  <div className="playerEmpty" aria-label="No video loaded">
                    <div className="bigPlay" aria-hidden="true" />
                  </div>
                )}
              </div>
            </div>

            <div className="toolbar" aria-label="Editing tools">
              <button
                className="tool"
                onClick={playEditedSequence}
                disabled={!timeline || (timeline?.clips.length ?? 0) === 0}
                aria-label="Play edited preview"
              >
                Preview
              </button>
              <button className="tool" onClick={stopEditedPreview} disabled={!editedPreviewOn} aria-label="Stop preview">
                Stop
              </button>

              <button className="tool" onClick={onSplit} disabled={!selectedClip}>
                Split
              </button>
              <button className="tool" onClick={onDeleteClip} disabled={!selectedClip || (timeline?.clips.length ?? 0) <= 1}>
                Delete
              </button>

              <button className="tool" onClick={setInToPlayhead} disabled={!selectedClip}>
                Set In
              </button>
              <button className="tool" onClick={setOutToPlayhead} disabled={!selectedClip}>
                Set Out
              </button>

              <button className="tool" disabled>
                Transitions
              </button>
              <button className="tool" disabled>
                Music
              </button>
              <button className="tool" disabled>
                Captions
              </button>
              <div className="toolHint">
                Tip: hit Preview. Drag the clip edges in the bottom timeline to trim.
              </div>
            </div>

          </section>

          <section className="timelineCard" aria-label="AI Timeline">
            <div className="timelineHead">
              <div className="timelineTitle">
                <span className="spark" aria-hidden="true">✦</span>
                <span>AI Timeline</span>
              </div>
              <div className="timelineMeta">
                {timeline ? `${timeline.clips.length} clips` : "—"}
              </div>
            </div>

            <TimelineStrip
              refEl={stripRef}
              timeline={timeline}
              selectedClipId={selectedClipId}
              onSelect={(id) => {
                setSelectedClipId(id);
                const clip = timeline?.clips.find((c) => c.id === id);
                if (clip) playClipPreview(clip);
              }}
              videoRef={videoRef}
              onBeginDrag={(clipId, handle, startX) => {
                const clip = timeline?.clips.find((c) => c.id === clipId);
                if (!clip) return;
                dragRef.current = {
                  clipId,
                  handle,
                  startX,
                  start: clip.start,
                  end: clip.end,
                  prevState: { timeline, selectedClipId },
                  didMove: false
                };
              }}
              onDrag={(clientX) => {
                const d = dragRef.current;
                const t = timeline;
                const el = stripRef.current;
                if (!d || !t || !el) return;
                const rect = el.getBoundingClientRect();
                const dx = clientX - d.startX;
                const deltaSeconds = (dx / Math.max(1, rect.width)) * t.durationSeconds;
                const clip = t.clips.find((c) => c.id === d.clipId);
                if (!clip) return;

                const minLen = 0.2;
                let start = clip.start;
                let end = clip.end;
                if (d.handle === "in") start = clamp(d.start + deltaSeconds, 0, end - minLen);
                if (d.handle === "out") end = clamp(d.end + deltaSeconds, start + minLen, t.durationSeconds);
                d.didMove = true;

                // Live update without adding undo history each tick.
                updateSelectedClip({ start, end }, { history: false });
              }}
              onEndDrag={() => {
                const d = dragRef.current;
                if (!d) return;
                dragRef.current = null;
                if (!d.didMove) return;
                // Push a single undo snapshot for the whole drag.
                setPast((p) => [...p, d.prevState].slice(-50));
                setFuture([]);
                stopEditedPreview();
                setExportUrl(null);
                setExportError(null);
              }}
            />

            <div className="timelineFooter">
              <div className="mono">Duration: {fmt(totalDuration)}</div>
              <div className="mono">Selected: {selectedClip ? selectedClip.label : "—"}</div>
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
                  placeholder="Tell the AI how to improve…"
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

              <button
                className="btn primary full"
                type="button"
                onClick={onExport}
                disabled={!timeline || !videoUrl || isExporting}
              >
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
      </section>
    </main>
  );
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

function TimelineStrip({
  refEl,
  timeline,
  selectedClipId,
  onSelect,
  videoRef,
  onBeginDrag,
  onDrag,
  onEndDrag
}: {
  refEl: MutableRefObject<HTMLDivElement | null>;
  timeline: Timeline | null;
  selectedClipId: string | null;
  onSelect: (id: string) => void;
  videoRef: MutableRefObject<HTMLVideoElement | null>;
  onBeginDrag: (clipId: string, handle: "in" | "out", startX: number) => void;
  onDrag: (clientX: number) => void;
  onEndDrag: () => void;
}) {
  const [playhead, setPlayhead] = useState(0);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTimeUpdate = () => setPlayhead(v.currentTime || 0);
    v.addEventListener("timeupdate", onTimeUpdate);
    return () => v.removeEventListener("timeupdate", onTimeUpdate);
  }, [videoRef]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => onDrag(e.clientX);
    const onUp = () => onEndDrag();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [onDrag, onEndDrag]);

  const duration = Math.max(0.001, timeline?.durationSeconds ?? 1);
  const playheadX = clamp(playhead / duration, 0, 1);

  return (
    <div className="timelineStripWrap">
      <div
        className="timelineStrip"
        ref={refEl}
        onPointerDown={(e) => {
          const el = refEl.current;
          const v = videoRef.current;
          if (!el || !v || !timeline) return;
          const rect = el.getBoundingClientRect();
          const x = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
          v.currentTime = x * timeline.durationSeconds;
          v.play().catch(() => {});
        }}
        role="list"
        aria-label="Timeline strip"
      >
        {timeline?.clips?.map((c) => {
          const left = clamp(c.start / duration, 0, 1);
          const width = clamp((c.end - c.start) / duration, 0.002, 1);
          const isSelected = c.id === selectedClipId;
          return (
            <div
              key={c.id}
              className={`tlClip ${isSelected ? "isSelected" : ""}`}
              style={{ left: pct(left), width: pct(width) } as any}
              role="listitem"
              title={`${c.label} (${fmt(c.start)}–${fmt(c.end)})`}
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

      {!timeline ? <div className="timelineEmpty">Upload a video to generate a timeline.</div> : null}
    </div>
  );
}
