"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AssistantReply, Timeline, TimelineClip } from "../../lib/types";
import { splitClipAt, trimTimelineToTargetSeconds } from "../../lib/timeline";

type ExportSettings = {
  resolution: "720p" | "1080p" | "4K";
  format: "MP4";
};

type PreviewMode = "original" | "edited";

const DEFAULT_EXPORT: ExportSettings = { resolution: "720p", format: "MP4" };

export default function StudioPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewStateRef = useRef<{
    enabled: boolean;
    mode: "sequence" | "single";
    idx: number;
    singleEnd: number | null;
  }>({ enabled: false, mode: "sequence", idx: 0, singleEnd: null });

  const [projectId, setProjectId] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [editedPreviewOn, setEditedPreviewOn] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("original");

  const [exportSettings, setExportSettings] = useState<ExportSettings>(DEFAULT_EXPORT);
  const [isExporting, setIsExporting] = useState(false);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

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

      setProjectId(data.projectId);
      setVideoUrl(data.videoUrl);
      setPreviewMode("original");
      stopEditedPreview();

      if (data.timeline && data.timeline.clips?.length) {
        setTimeline(data.timeline);
        setSelectedClipId(data.timeline.clips[0].id);
      } else {
        // Fallback timeline: one clip spanning the full duration (updated again after video metadata loads).
        const initialTimeline: Timeline = {
          projectId: data.projectId,
          durationSeconds: 0,
          clips: [
            {
              id: crypto.randomUUID(),
              label: "Full Clip",
              start: 0,
              end: 1,
              kind: "source"
            }
          ]
        };
        setTimeline(initialTimeline);
        setSelectedClipId(initialTimeline.clips[0].id);
      }

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
    if (!v || !timeline) return;
    const durationSeconds = Number.isFinite(v.duration) ? v.duration : timeline.durationSeconds;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return;

    setTimeline((t) => {
      if (!t) return t;
      const prevDuration = t.durationSeconds;
      if (Math.abs(prevDuration - durationSeconds) < 0.01) return t;
      // If we only have a single "full clip" placeholder, expand it to the true duration.
      const clips =
        t.clips.length === 1
          ? t.clips.map((c) => ({ ...c, start: 0, end: durationSeconds, label: c.label === "Full Clip" ? "Full Clip" : c.label }))
          : t.clips;
      return { ...t, durationSeconds, clips };
    });
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

  function setPreview(mode: PreviewMode) {
    setPreviewMode(mode);
    stopEditedPreview();
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
    setTimeline(next.timeline);
    setSelectedClipId(next.newSelectedId);
  }

  function onDeleteClip() {
    if (!timeline || !selectedClip) return;
    const remaining = timeline.clips.filter((c) => c.id !== selectedClip.id);
    if (remaining.length === 0) return;
    setTimeline({ ...timeline, clips: remaining });
    setSelectedClipId(remaining[0].id);
  }

  function updateSelectedClip(patch: Partial<Pick<TimelineClip, "start" | "end" | "label">>) {
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
    setTimeline({ ...timeline, clips: nextClips });
  }

  function setInToPlayhead() {
    const v = videoRef.current;
    if (!v || !selectedClip) return;
    updateSelectedClip({ start: clamp(v.currentTime, 0, selectedClip.end - 0.2) });
  }

  function setOutToPlayhead() {
    const v = videoRef.current;
    if (!v || !selectedClip) return;
    updateSelectedClip({ end: clamp(v.currentTime, selectedClip.start + 0.2, totalDuration) });
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
      setTimeline(t);
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
      <header className="studioTop">
        <div className="filePill">
          <span className={`statusDot ${videoUrl ? "on" : ""}`} aria-hidden="true" />
          <div>
            <div className="fileTitle">{videoUrl ? "File loaded" : "No file loaded"}</div>
            <div className="fileSub">{videoUrl ? "Ready to edit" : "Upload a clip to start"}</div>
          </div>
        </div>

        <div className="topActions">
          <button className="btn ghost" onClick={() => fileInputRef.current?.click()} disabled={isUploading}>
            {isUploading ? "Uploading…" : "Upload"}
          </button>
          <button
            className="btn ghost"
            onClick={() => {
              setProjectId(null);
              setVideoUrl(null);
              setTimeline(null);
              setSelectedClipId(null);
              setPreviewMode("original");
              stopEditedPreview();
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
        <section className="left">
          <section className="playerCard">
            <div className="player">
              <div className="playerViewport">
                {videoUrl ? (
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    controls={previewMode === "original"}
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
              <div className="seg" role="tablist" aria-label="Preview mode">
                <button
                  type="button"
                  className={`segBtn ${previewMode === "original" ? "isOn" : ""}`}
                  onClick={() => setPreview("original")}
                  role="tab"
                  aria-selected={previewMode === "original"}
                >
                  Original
                </button>
                <button
                  type="button"
                  className={`segBtn ${previewMode === "edited" ? "isOn" : ""}`}
                  onClick={() => setPreview("edited")}
                  role="tab"
                  aria-selected={previewMode === "edited"}
                >
                  Edited
                </button>
              </div>

              {previewMode === "edited" ? (
                <>
                  <button
                    className="tool"
                    onClick={playEditedSequence}
                    disabled={!timeline || (timeline?.clips.length ?? 0) === 0}
                  >
                    Play
                  </button>
                  <button className="tool" onClick={stopEditedPreview} disabled={!editedPreviewOn}>
                    Stop
                  </button>
                </>
              ) : null}

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
                Tip: switch to “Edited”, then hit Play. Set In/Out trims the selected clip.
              </div>
            </div>

            {selectedClip ? (
              <div className="trimRow" aria-label="Trim values">
                <div className="trimField">
                  <label htmlFor="clipStart">In</label>
                  <input
                    id="clipStart"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={Math.max(0, totalDuration)}
                    step={0.1}
                    value={Number.isFinite(selectedClip.start) ? Number(selectedClip.start.toFixed(1)) : 0}
                    onChange={(e) => updateSelectedClip({ start: Number(e.target.value) })}
                  />
                  <span className="trimHint">{fmt(selectedClip.start)}</span>
                </div>
                <div className="trimField">
                  <label htmlFor="clipEnd">Out</label>
                  <input
                    id="clipEnd"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={Math.max(0, totalDuration)}
                    step={0.1}
                    value={Number.isFinite(selectedClip.end) ? Number(selectedClip.end.toFixed(1)) : 0}
                    onChange={(e) => updateSelectedClip({ end: Number(e.target.value) })}
                  />
                  <span className="trimHint">{fmt(selectedClip.end)}</span>
                </div>
                <div className="trimField grow">
                  <div className="trimMeta">
                    <span className="mono">Clip length: {fmt(Math.max(0, selectedClip.end - selectedClip.start))}</span>
                  </div>
                </div>
              </div>
            ) : null}
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

            <div className="timelineTrack" role="list">
              {(timeline?.clips ?? []).map((clip) => (
                <button
                  key={clip.id}
                  type="button"
                  className={`clip ${clip.id === selectedClipId ? "isSelected" : ""}`}
                  onClick={() => {
                    setSelectedClipId(clip.id);
                    if (previewMode === "edited") playClipPreview(clip);
                    else seekTo(clip.start);
                  }}
                  role="listitem"
                  title={`${clip.label} (${fmt(clip.start)}–${fmt(clip.end)})`}
                >
                  <div className="clipLabel">{clip.label}</div>
                  <div className="clipSub">{fmt(clip.start)}–{fmt(clip.end)}</div>
                </button>
              ))}

              {!timeline ? <div className="timelineEmpty">Upload a video to generate a timeline.</div> : null}
            </div>

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
