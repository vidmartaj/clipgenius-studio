import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AnalysisTimeline, AnalysisClip } from "../../../lib/types";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return new NextResponse("Missing file", { status: 400 });
  }

  const assetId = crypto.randomUUID();
  const ext = guessExt(file.type) ?? "mp4";
  const filename = `${assetId}.${ext}`;

  // MVP ONLY: write into /public so Next can serve it in dev.
  // Production: store in S3/R2 and return a signed URL.
  const publicDir = path.join(process.cwd(), "public", "uploads");
  await mkdir(publicDir, { recursive: true });
  const dst = path.join(publicDir, filename);
  const bytes = new Uint8Array(await file.arrayBuffer());
  await writeFile(dst, bytes);

  // Normalize iPhone/QuickTime rotation metadata for browser preview.
  // Many .mov files store portrait footage as landscape pixels + a rotation tag.
  // Browsers can render that inconsistently; we bake the rotation into frames.
  let normalizedPath: string | null = null;
  let normalizedUrl: string | null = null;
  let hasAudio = false;
  let waveformUrl: string | null = null;
  try {
    const info = await getVideoStreamInfo(dst);
    hasAudio = info.hasAudio;
    if (info.rotationDegrees !== 0) {
      const normName = `${assetId}_norm.mp4`;
      normalizedPath = path.join(publicDir, normName);
      await normalizeRotation(dst, normalizedPath, info.rotationDegrees);
      normalizedUrl = `/uploads/${normName}`;
    }
  } catch {
    // Non-fatal; fall back to original file.
  }

  const videoUrl = normalizedUrl ?? `/uploads/${filename}`;

  // Auto timeline generation (scene cuts) using ffprobe/ffmpeg.
  // If ffmpeg isn't available or fails, we still return the uploaded URL.
  try {
    // Use the normalized file (if generated) for analysis, so duration/scene cuts match preview.
    const analyzePath = normalizedPath ?? dst;
    const durationSeconds = await getDurationSeconds(analyzePath);
    let sceneTimes: number[] = [];
    try {
      sceneTimes = await detectSceneCuts(analyzePath, { threshold: 0.25, maxCuts: 24 });
    } catch {
      // Keep going — we can still build a usable fallback timeline.
      sceneTimes = [];
    }
    let clips = buildClipsFromCuts(durationSeconds, sceneTimes, { minClipSeconds: 2, maxClips: 12 });

    // If we have audio, detect non-silent regions and mark those clips as "highlight".
    // This makes "Focus on action scenes" / "highlights only" drafts much more reliable
    // even when visual scene-cut detection is noisy.
    if (hasAudio) {
      try {
        const silences = await detectSilences(analyzePath, { thresholdDb: -35, minSilenceSeconds: 0.35, timeoutMs: 120_000 });
        const nonSilent = invertIntervals({ start: 0, end: durationSeconds }, silences).filter((s) => s.end - s.start >= 0.6);
        clips = clips.map((c, idx) => {
          // Keep intro/outro as source for story structure.
          if (idx === 0 || idx === clips.length - 1) return { ...c, kind: "source" };
          const len = Math.max(0.001, c.end - c.start);
          const nonSilentOverlap = overlapSeconds({ start: c.start, end: c.end }, nonSilent);
          const frac = nonSilentOverlap / len;
          return { ...c, kind: frac >= 0.6 ? ("highlight" as const) : ("source" as const) };
        });
      } catch {
        // Non-fatal.
      }
    }
    const analysis: AnalysisTimeline = { assetId, durationSeconds, clips };

    // Generate a waveform image for the audio lane (optional).
    if (hasAudio) {
      try {
        const waveName = `${assetId}_wave.png`;
        const wavePath = path.join(publicDir, waveName);
        await generateWaveform(analyzePath, wavePath);
        waveformUrl = `/uploads/${waveName}`;
      } catch {
        waveformUrl = null;
      }
    }

    return NextResponse.json({
      assetId,
      videoUrl,
      hasAudio,
      waveformUrl,
      analysis
    });
  } catch {
    // Total failure: return upload without analysis.
  }

  return NextResponse.json({
    assetId,
    videoUrl,
    hasAudio,
    waveformUrl,
    analysis: null
  });
}

function guessExt(mime: string) {
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("quicktime")) return "mov";
  if (mime.includes("webm")) return "webm";
  return null;
}

function run(cmd: string, args: string[], opts?: { timeoutMs?: number }) {
  const timeoutMs = opts?.timeoutMs ?? 60_000;

  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunksOut: Buffer[] = [];
    const chunksErr: Buffer[] = [];

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out: ${cmd}`));
    }, timeoutMs);

    child.stdout.on("data", (d) => chunksOut.push(Buffer.from(d)));
    child.stderr.on("data", (d) => chunksErr.push(Buffer.from(d)));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunksOut).toString("utf8");
      const stderr = Buffer.concat(chunksErr).toString("utf8");
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `Command failed: ${cmd} (${code})`));
    });
  });
}

async function getDurationSeconds(filePath: string) {
  const { stdout } = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath],
    { timeoutMs: 30_000 }
  );

  const n = Number(String(stdout).trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error("Could not determine duration");
  return n;
}

async function getVideoStreamInfo(filePath: string) {
  const { stdout } = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_streams",
      "-of",
      "json",
      filePath
    ],
    { timeoutMs: 30_000 }
  );

  const json = JSON.parse(stdout || "{}") as any;
  const streams = Array.isArray(json?.streams) ? json.streams : [];
  const stream = streams.find((s: any) => s?.codec_type === "video") ?? null;
  const width = Number(stream?.width ?? 0);
  const height = Number(stream?.height ?? 0);

  let rot = 0;
  const tagRot = stream?.tags?.rotate;
  if (tagRot != null) rot = Number(tagRot) || 0;

  // Some builds of ffprobe expose rotation in side_data_list.
  if (!rot && Array.isArray(stream?.side_data_list)) {
    for (const sd of stream.side_data_list) {
      if (sd && sd.rotation != null) {
        rot = Number(sd.rotation) || 0;
        break;
      }
    }
  }

  // Normalize to {0,90,180,270}.
  rot = ((rot % 360) + 360) % 360;
  if (rot > 315 || rot < 45) rot = 0;
  else if (rot >= 45 && rot < 135) rot = 90;
  else if (rot >= 135 && rot < 225) rot = 180;
  else rot = 270;

  // Detect if an audio stream exists.
  const hasAudio = streams.some((s: any) => s?.codec_type === "audio");

  return { width, height, rotationDegrees: rot, hasAudio };
}

async function normalizeRotation(src: string, dst: string, rotationDegrees: number) {
  let vf = "";
  if (rotationDegrees === 90) vf = "transpose=1";
  else if (rotationDegrees === 270) vf = "transpose=2";
  else if (rotationDegrees === 180) vf = "transpose=2,transpose=2";
  else return;

  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      "-i",
      src,
      "-vf",
      vf,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-metadata:s:v:0",
      "rotate=0",
      "-movflags",
      "+faststart",
      dst
    ],
    { timeoutMs: 10 * 60_000 }
  );
}

async function generateWaveform(src: string, dst: string) {
  // A lightweight, editor-like waveform thumbnail for the whole asset audio track.
  // We keep it intentionally small; the UI stretches it.
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      "-i",
      src,
      "-filter_complex",
      // mono waveform, bright line on transparent-ish background feel (we'll blend in CSS)
      "aformat=channel_layouts=mono,showwavespic=s=1400x180:colors=#5dd6ff",
      "-frames:v",
      "1",
      dst
    ],
    { timeoutMs: 5 * 60_000 }
  );
}

async function detectSceneCuts(
  filePath: string,
  opts: { threshold: number; maxCuts: number }
): Promise<number[]> {
  // NOTE: showinfo prints to stderr.
  const vf = `select='gt(scene,${opts.threshold})',showinfo`;
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", filePath, "-vf", vf, "-f", "null", "-"], {
    timeoutMs: 120_000
  });

  const times: number[] = [];
  const re = /pts_time:([0-9.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr))) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) times.push(t);
    if (times.length >= opts.maxCuts) break;
  }

  // De-dupe + sort + remove very-close cuts.
  times.sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of times) {
    if (out.length === 0 || t - out[out.length - 1] > 0.6) out.push(t);
  }
  return out;
}

function buildClipsFromCuts(
  durationSeconds: number,
  cuts: number[],
  opts: { minClipSeconds: number; maxClips: number }
): AnalysisClip[] {
  const times = [0, ...cuts.filter((t) => t > 0.3 && t < durationSeconds - 0.3), durationSeconds];
  times.sort((a, b) => a - b);

  let clips: AnalysisClip[] = [];
  for (let i = 0; i < times.length - 1; i++) {
    const start = times[i];
    const end = times[i + 1];
    if (end - start < 0.25) continue;
    clips.push({
      id: crypto.randomUUID(),
      label: `Scene ${i + 1}`,
      // We refine this later using audio non-silence detection (if available),
      // but defaulting mid scenes to highlights makes the editor feel "smart"
      // even when silence detection isn't available.
      kind: "highlight",
      start,
      end
    });
  }

  // Merge tiny clips into the next clip to keep the UI clean.
  const minLen = Math.max(0.5, opts.minClipSeconds);
  const merged: AnalysisClip[] = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const len = c.end - c.start;
    if (len >= minLen || merged.length === 0) {
      merged.push(c);
      continue;
    }
    // Merge into previous clip.
    const prev = merged[merged.length - 1];
    merged[merged.length - 1] = { ...prev, end: c.end };
  }
  clips = merged;

  // Cap the number of clips by merging the shortest until we fit.
  while (clips.length > opts.maxClips) {
    let smallestIdx = -1;
    let smallestLen = Number.POSITIVE_INFINITY;
    for (let i = 0; i < clips.length; i++) {
      const len = clips[i].end - clips[i].start;
      if (len < smallestLen) {
        smallestLen = len;
        smallestIdx = i;
      }
    }
    if (smallestIdx <= 0) {
      // Merge first into second
      const a = clips[0];
      const b = clips[1];
      clips.splice(0, 2, { ...b, start: a.start });
    } else {
      const a = clips[smallestIdx - 1];
      const b = clips[smallestIdx];
      clips.splice(smallestIdx - 1, 2, { ...a, end: b.end });
    }
  }

  // Friendlier labels for the first/last clip.
  if (clips.length >= 2) {
    clips[0] = { ...clips[0], label: "Intro", kind: "source" };
    clips[clips.length - 1] = { ...clips[clips.length - 1], label: "Outro", kind: "source" };
  }

  // If scene detection didn't find useful cuts (common for some MOVs),
  // fall back to a clean, "concept-like" 5-part timeline so the UI is still usable.
  if (clips.length <= 1 && durationSeconds > 6) {
    const parts = [
      { label: "Intro", kind: "source" as const },
      { label: "Action Peak", kind: "highlight" as const },
      { label: "Highlight", kind: "highlight" as const },
      { label: "Climax", kind: "highlight" as const },
      { label: "Outro", kind: "source" as const }
    ];
    const seg = durationSeconds / parts.length;
    clips = parts.map((p, i) => {
      const start = i * seg;
      const end = i === parts.length - 1 ? durationSeconds : (i + 1) * seg;
      return {
        id: crypto.randomUUID(),
        label: p.label,
        kind: p.kind,
        start,
        end
      };
    });
  }

  return clips;
}

type Interval = { start: number; end: number };

async function detectSilences(
  filePath: string,
  opts: { thresholdDb: number; minSilenceSeconds: number; timeoutMs: number }
): Promise<Interval[]> {
  const thr = Number(opts.thresholdDb);
  const d = Number(opts.minSilenceSeconds);
  const { stderr } = await run(
    "ffmpeg",
    ["-hide_banner", "-i", filePath, "-af", `silencedetect=n=${thr}dB:d=${d}`, "-f", "null", "-"],
    { timeoutMs: opts.timeoutMs }
  );

  const silences: Interval[] = [];
  const reStart = /silence_start:\s*([0-9.]+)/g;
  const reEnd = /silence_end:\s*([0-9.]+)/g;

  const starts: number[] = [];
  const ends: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = reStart.exec(stderr))) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) starts.push(t);
  }
  while ((m = reEnd.exec(stderr))) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) ends.push(t);
  }

  // Pair starts/ends in order. If an end is missing (silence runs to EOF), we drop it here;
  // the caller can clamp with the known duration by complementing intervals.
  const n = Math.min(starts.length, ends.length);
  for (let i = 0; i < n; i++) {
    const s = starts[i];
    const e = ends[i];
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (!(e > s)) continue;
    silences.push({ start: s, end: e });
  }

  silences.sort((a, b) => a.start - b.start);
  return mergeIntervals(silences, 0.05);
}

function mergeIntervals(list: Interval[], pad: number) {
  const out: Interval[] = [];
  for (const it of list) {
    const s = it.start - pad;
    const e = it.end + pad;
    if (out.length === 0) {
      out.push({ start: s, end: e });
      continue;
    }
    const prev = out[out.length - 1];
    if (s <= prev.end) prev.end = Math.max(prev.end, e);
    else out.push({ start: s, end: e });
  }
  return out;
}

function invertIntervals(domain: Interval, silences: Interval[]): Interval[] {
  const out: Interval[] = [];
  const a = domain.start;
  const b = domain.end;
  let cur = a;
  for (const s of silences) {
    const ss = clamp(s.start, a, b);
    const ee = clamp(s.end, a, b);
    if (ss > cur) out.push({ start: cur, end: ss });
    cur = Math.max(cur, ee);
  }
  if (cur < b) out.push({ start: cur, end: b });
  return out.filter((x) => x.end > x.start);
}

function overlapSeconds(interval: Interval, list: Interval[]) {
  let sum = 0;
  for (const it of list) {
    const s = Math.max(interval.start, it.start);
    const e = Math.min(interval.end, it.end);
    if (e > s) sum += e - s;
  }
  return sum;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}
