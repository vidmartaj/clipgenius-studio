import type { Timeline, TimelineClip } from "./types";

export function splitClipAt(timeline: Timeline, clipId: string, seconds: number) {
  const idx = timeline.clips.findIndex((c) => c.id === clipId);
  if (idx === -1) return null;
  const clip = timeline.clips[idx];
  const t = clamp(seconds, clip.start + 0.2, clip.end - 0.2);
  if (!(t > clip.start && t < clip.end)) return null;

  const left: TimelineClip = { ...clip, id: crypto.randomUUID(), end: t, label: clip.label };
  const right: TimelineClip = { ...clip, id: crypto.randomUUID(), start: t, label: clip.label };

  const clips = [...timeline.clips.slice(0, idx), left, right, ...timeline.clips.slice(idx + 1)];
  return { timeline: { ...timeline, clips }, newSelectedId: right.id };
}

export function trimTimelineToTargetSeconds(timeline: Timeline, targetSeconds: number): Timeline {
  const target = Math.max(5, Math.min(targetSeconds, timeline.durationSeconds));
  if (timeline.clips.length === 0) return timeline;

  // MVP: truncate from the end across clips.
  let remaining = target;
  const out: TimelineClip[] = [];

  for (const clip of timeline.clips) {
    const len = clip.end - clip.start;
    if (remaining <= 0) break;
    if (len <= remaining) {
      out.push(clip);
      remaining -= len;
      continue;
    }
    out.push({ ...clip, end: clip.start + remaining });
    remaining = 0;
  }

  return { ...timeline, clips: out };
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

