import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AudioClip, ProjectTimeline } from "../../../lib/types";
import { projectDurationSeconds } from "../../../lib/timeline";

export const runtime = "nodejs";

type ExportResolution = "720p" | "1080p" | "4K";
type ExportFormat = "MP4";

export async function POST(req: Request) {
  const body = (await req.json()) as {
    assets?: Array<{ assetId: string; videoUrl: string }>;
    timeline?: ProjectTimeline;
    resolution?: ExportResolution;
    format?: ExportFormat;
  };

  const timeline = body.timeline;
  const assets = body.assets ?? [];
  const resolution = (body.resolution ?? "720p") as ExportResolution;
  const format = (body.format ?? "MP4") as ExportFormat;

  if (!timeline || !Array.isArray(timeline.clips) || timeline.clips.length === 0) {
    return new NextResponse("Missing timeline", { status: 400 });
  }
  if (!Array.isArray(assets) || assets.length === 0) {
    return new NextResponse("Missing assets", { status: 400 });
  }
  if (format !== "MP4") {
    return new NextResponse("Unsupported format", { status: 400 });
  }

  const assetMap = new Map<string, string>();
  for (const a of assets) {
    if (!a?.assetId || typeof a.assetId !== "string") continue;
    if (!a?.videoUrl || typeof a.videoUrl !== "string") continue;
    if (!a.videoUrl.startsWith("/uploads/")) continue;
    assetMap.set(a.assetId, a.videoUrl);
  }
  if (assetMap.size === 0) return new NextResponse("Invalid assets", { status: 400 });

  const clips = [...timeline.clips]
    .map((c) => {
      const url = assetMap.get(c.assetId);
      if (!url) return null;
      const src = path.join(process.cwd(), "public", url.replace(/^\/+/, ""));
      return {
        src,
        inpoint: Number(c.sourceIn),
        outpoint: Number(c.sourceOut)
      };
    })
    .filter((c): c is NonNullable<typeof c> => !!c)
    .filter((c) => Number.isFinite(c.inpoint) && Number.isFinite(c.outpoint) && c.outpoint > c.inpoint + 0.05);

  if (clips.length === 0) {
    return new NextResponse("Timeline has no usable clips", { status: 400 });
  }

  // Ensure all source files exist.
  for (const c of clips) await readFile(c.src);

  // Build concat list file. inpoint/outpoint is supported by ffmpeg concat demuxer.
  const concat = clips
    .map((c) => {
      return (
        `file '${escapeForConcat(c.src)}'\n` +
        `inpoint ${c.inpoint.toFixed(3)}\n` +
        `outpoint ${c.outpoint.toFixed(3)}\n`
      );
    })
    .join("");

  const tmpDir = os.tmpdir();
  const listPath = path.join(tmpDir, `clipgenius_${timeline.projectId}_${Date.now()}.txt`);
  await writeFile(listPath, concat, "utf8");

  const outName = `export_${timeline.projectId}_${Date.now()}.mp4`;
  const outDir = path.join(process.cwd(), "public", "exports");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, outName);

  const scale = resolutionToScale(resolution);
  const projectDuration = Math.max(0.001, projectDurationSeconds(timeline));

  const unlinkedAudio = timeline.audioLinked === false && Array.isArray(timeline.audioClips);
  const trackVol = clamp(Number.isFinite(timeline.trackAudioVolume as any) ? (timeline.trackAudioVolume as any) : 1, 0, 2);
  const exportMuted = Boolean(timeline.trackAudioMuted) || trackVol <= 0.0001;

  const linkedNeedsMix =
    !unlinkedAudio &&
    !exportMuted &&
    Array.isArray(timeline.clips) &&
    (Math.abs(trackVol - 1) > 0.001 ||
      timeline.clips.some((c) => Boolean(c.audioMuted) || Math.abs((c.audioVolume ?? 1) - 1) > 0.001));

  const audioPlan =
    !exportMuted && unlinkedAudio
      ? await buildUnlinkedAudioPlan(timeline.audioClips ?? [], assetMap, projectDuration, trackVol)
      : !exportMuted && linkedNeedsMix
        ? await buildLinkedAudioPlan(timeline.clips ?? [], assetMap, projectDuration, trackVol)
        : null;

  // Re-encode for reliable cuts across keyframes + consistent output.
  // Notes:
  // - In linked mode, we keep the concat demuxer audio (default mapping).
  // - In unlinked mode, we map video from concat input + an audio mix built from AudioClips.
  // - If the user mutes audio, we export video-only (no audio track).
  const args: string[] = ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", listPath];

  // Additional audio inputs + mix graph (unlinked audio only).
  if (audioPlan) {
    for (const p of audioPlan.inputPaths) args.push("-i", p);
    args.push("-filter_complex", audioPlan.filterComplex);
    args.push("-map", "0:v:0");
    args.push("-map", audioPlan.mapAudioLabel);
  } else if (exportMuted) {
    args.push("-an");
  }

  args.push(
    "-vf",
    scale,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p"
  );

  if (audioPlan) {
    args.push("-c:a", "aac", "-b:a", "160k");
  } else if (!exportMuted) {
    // Linked mode audio (or no audio stream). FFmpeg will ignore audio settings if there isn't an audio stream.
    args.push("-c:a", "aac", "-b:a", "160k");
  }

  args.push("-movflags", "+faststart", outPath);

  await run("ffmpeg", args, { timeoutMs: 10 * 60_000 });

  return NextResponse.json({
    exportUrl: `/exports/${outName}`
  });
}

async function buildLinkedAudioPlan(videoClips: ProjectTimeline["clips"], assetMap: Map<string, string>, projectDuration: number, trackVol: number) {
  // Build a derived audio lane from the video timeline so we can apply per-clip volume/mute.
  const derived: AudioClip[] = [];
  let acc = 0;
  for (const c of videoClips) {
    const inpoint = Number(c.sourceIn);
    const outpoint = Number(c.sourceOut);
    if (!Number.isFinite(inpoint) || !Number.isFinite(outpoint)) continue;
    if (outpoint <= inpoint + 0.05) continue;
    const len = Math.max(0.05, outpoint - inpoint);
    const start = clamp(acc, 0, Math.max(0, projectDuration - len));
    acc += len;
    derived.push({
      id: `linked-${c.id}`,
      assetId: c.assetId,
      label: c.label,
      sourceIn: inpoint,
      sourceOut: outpoint,
      start,
      volume: clamp(Number.isFinite(c.audioVolume as any) ? (c.audioVolume as any) : 1, 0, 2) * trackVol,
      muted: Boolean(c.audioMuted),
      fadeIn: clamp(Number.isFinite(c.audioFadeIn as any) ? (c.audioFadeIn as any) : 0, 0, len / 2),
      fadeOut: clamp(Number.isFinite(c.audioFadeOut as any) ? (c.audioFadeOut as any) : 0, 0, len / 2)
    });
  }
  return buildUnlinkedAudioPlan(derived, assetMap, projectDuration, 1);
}

async function buildUnlinkedAudioPlan(audioClips: AudioClip[], assetMap: Map<string, string>, projectDuration: number, trackVol: number) {
  // De-dupe inputs by source file path to avoid opening the same file repeatedly.
  // We'll reference them by input index in filter_complex.
  const inputs: string[] = [];
  const inputIndexBySrc = new Map<string, number>();

  const normalized: Array<{
    inputIndex: number;
    sourceIn: number;
    sourceOut: number;
    start: number;
    volume: number;
    fadeIn: number;
    fadeOut: number;
  }> = [];

  for (const c of audioClips) {
    if (!c?.assetId) continue;
    if (c.muted) continue;
    const url = assetMap.get(c.assetId);
    if (!url) continue;
    const src = path.join(process.cwd(), "public", url.replace(/^\/+/, ""));

    const inpoint = Number(c.sourceIn);
    const outpoint = Number(c.sourceOut);
    const start = Number(c.start);
    if (!Number.isFinite(inpoint) || !Number.isFinite(outpoint) || !Number.isFinite(start)) continue;
    if (outpoint <= inpoint + 0.05) continue;

    const volumeRaw = (c.volume ?? 1) as any;
    const volume = clamp(Number.isFinite(volumeRaw) ? volumeRaw : 1, 0, 2) * trackVol;
    if (volume <= 0) continue;

    const len = Math.max(0.05, outpoint - inpoint);
    const fadeInRaw = (c.fadeIn ?? 0) as any;
    const fadeOutRaw = (c.fadeOut ?? 0) as any;
    const fadeIn = clamp(Number.isFinite(fadeInRaw) ? fadeInRaw : 0, 0, len / 2);
    const fadeOut = clamp(Number.isFinite(fadeOutRaw) ? fadeOutRaw : 0, 0, len / 2);

    const hasAudio = await probeHasAudio(src);
    if (!hasAudio) continue;

    let inputIndex = inputIndexBySrc.get(src);
    if (inputIndex == null) {
      inputIndex = inputs.length;
      inputs.push(src);
      inputIndexBySrc.set(src, inputIndex);
    }

    const boundedStart = clamp(start, 0, Math.max(0, projectDuration - len));

    normalized.push({
      inputIndex,
      sourceIn: Math.max(0, inpoint),
      sourceOut: Math.max(0, outpoint),
      start: boundedStart,
      volume,
      fadeIn,
      fadeOut
    });
  }

  if (normalized.length === 0) return null;

  // Build filter graph.
  // Inputs:
  //  - 0: concat list (video)
  //  - 1..N: unique audio source files
  const chains: string[] = [];
  const labels: string[] = [];

  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    const input = 1 + c.inputIndex;
    const label = `ac${i}`;
    const delayMs = Math.max(0, Math.round(c.start * 1000));
    // adelay expects per-channel delays; provide the same delay for at least 2 channels.
    const delayArg = `${delayMs}|${delayMs}`;
    const clipLen = Math.max(0.05, c.sourceOut - c.sourceIn);
    const fadeBits: string[] = [];
    if (c.fadeIn > 0.001) fadeBits.push(`afade=t=in:st=0:d=${c.fadeIn.toFixed(3)}`);
    if (c.fadeOut > 0.001) {
      const st = Math.max(0, clipLen - c.fadeOut);
      fadeBits.push(`afade=t=out:st=${st.toFixed(3)}:d=${c.fadeOut.toFixed(3)}`);
    }
    chains.push(
      `[${input}:a]` +
        `atrim=start=${c.sourceIn.toFixed(3)}:end=${c.sourceOut.toFixed(3)},` +
        `asetpts=PTS-STARTPTS,` +
        `volume=${c.volume.toFixed(3)},` +
        (fadeBits.length ? `${fadeBits.join(",")},` : "") +
        `adelay=${delayArg}:all=1` +
        `[${label}]`
    );
    labels.push(`[${label}]`);
  }

  const mixLabel = "a_mix";
  if (labels.length === 1) {
    chains.push(`${labels[0]}aresample=async=1:first_pts=0,atrim=0:${projectDuration.toFixed(3)},asetpts=PTS-STARTPTS[${mixLabel}]`);
  } else {
    chains.push(
      `${labels.join("")}` +
        `amix=inputs=${labels.length}:normalize=0:dropout_transition=0,` +
        `aresample=async=1:first_pts=0,` +
        `atrim=0:${projectDuration.toFixed(3)},` +
        `asetpts=PTS-STARTPTS` +
        `[${mixLabel}]`
    );
  }

  const filterComplex = chains.join(";");

  return {
    inputPaths: inputs,
    filterComplex,
    mapAudioLabel: `[${mixLabel}]`
  };
}

function probeHasAudio(src: string) {
  // Returns true if ffprobe finds at least one audio stream.
  return new Promise<boolean>((resolve) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "csv=p=0",
      src
    ]);
    let out = "";
    child.stdout?.on("data", (d) => (out += String(d)));
    child.on("error", () => resolve(false));
    child.on("close", (code) => {
      if (code !== 0) return resolve(false);
      resolve(Boolean(out.trim()));
    });
  });
}

function resolutionToScale(res: ExportResolution) {
  if (res === "4K") return "scale=-2:2160";
  if (res === "1080p") return "scale=-2:1080";
  return "scale=-2:720";
}

function run(cmd: string, args: string[], opts?: { timeoutMs?: number }) {
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    const errChunks: Buffer[] = [];

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out: ${cmd}`));
    }, timeoutMs);

    child.stderr.on("data", (d) => errChunks.push(Buffer.from(d)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(Buffer.concat(errChunks).toString("utf8") || `Command failed: ${cmd} (${code})`));
    });
  });
}

function escapeForConcat(p: string) {
  // concat demuxer: single-quoted string; escape single quotes.
  return p.replaceAll("'", "'\\''");
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}
