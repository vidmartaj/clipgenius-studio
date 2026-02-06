"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AssistantReply, Timeline, TimelineClip } from "../../lib/types";
import { splitClipAt, trimTimelineToTargetSeconds } from "../../lib/timeline";

type ExportSettings = {
  resolution: "720p" | "1080p" | "4K";
  format: "MP4";
};

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

  const [exportSettings, setExportSettings] = useState<ExportSettings>(DEFAULT_EXPORT);

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
                    controls={!editedPreviewOn}
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
              <button className="tool" onClick={playEditedSequence} disabled={!timeline || (timeline?.clips.length ?? 0) === 0}>
                Play edited preview
              </button>
              <button className="tool" onClick={stopEditedPreview} disabled={!editedPreviewOn}>
                Stop preview
              </button>
              <button className="tool" onClick={onSplit} disabled={!selectedClip}>
                Split
              </button>
              <button className="tool" onClick={onDeleteClip} disabled={!selectedClip || (timeline?.clips.length ?? 0) <= 1}>
                Delete
              </button>
              <button className="tool" disabled>
                Trim
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
                Preview plays only timeline clips. Split/Delete affects the preview immediately.
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

            <div className="timelineTrack" role="list">
              {(timeline?.clips ?? []).map((clip) => (
                <button
                  key={clip.id}
                  type="button"
                  className={`clip ${clip.id === selectedClipId ? "isSelected" : ""}`}
                  onClick={() => {
                    setSelectedClipId(clip.id);
                    playClipPreview(clip);
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

              <button className="btn primary full" type="button" disabled>
                Export Video
              </button>

              <div className="hint">Export rendering comes next (FFmpeg backend).</div>
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
