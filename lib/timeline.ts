import type { ProjectClip, ProjectTimeline } from "./types";

export function splitProjectClipAt(timeline: ProjectTimeline, clipId: string, sourceSeconds: number) {
  const idx = timeline.clips.findIndex((c) => c.id === clipId);
  if (idx === -1) return null;
  const clip = timeline.clips[idx];

  const t = clamp(sourceSeconds, clip.sourceIn + 0.2, clip.sourceOut - 0.2);
  if (!(t > clip.sourceIn && t < clip.sourceOut)) return null;

  const left: ProjectClip = {
    ...clip,
    id: crypto.randomUUID(),
    sourceOut: t
  };
  const right: ProjectClip = {
    ...clip,
    id: crypto.randomUUID(),
    sourceIn: t
  };

  const clips = [...timeline.clips.slice(0, idx), left, right, ...timeline.clips.slice(idx + 1)];
  return { timeline: { ...timeline, clips }, newSelectedId: right.id };
}

export function trimProjectTimelineToTargetSeconds(timeline: ProjectTimeline, targetSeconds: number): ProjectTimeline {
  const target = Math.max(5, targetSeconds);
  if (timeline.clips.length === 0) return timeline;

  let remaining = target;
  const out: ProjectClip[] = [];

  for (const clip of timeline.clips) {
    const len = clip.sourceOut - clip.sourceIn;
    if (remaining <= 0) break;
    if (len <= remaining) {
      out.push(clip);
      remaining -= len;
      continue;
    }
    out.push({ ...clip, sourceOut: clip.sourceIn + remaining });
    remaining = 0;
  }

  return { ...timeline, clips: out };
}

export function projectDurationSeconds(timeline: ProjectTimeline) {
  return timeline.clips.reduce((sum, c) => sum + Math.max(0, c.sourceOut - c.sourceIn), 0);
}

export function projectClipOffsets(timeline: ProjectTimeline) {
  const offsets = new Map<string, number>();
  let t = 0;
  for (const c of timeline.clips) {
    offsets.set(c.id, t);
    t += Math.max(0, c.sourceOut - c.sourceIn);
  }
  return offsets;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

