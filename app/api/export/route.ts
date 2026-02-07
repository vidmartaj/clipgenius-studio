import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectTimeline } from "../../../lib/types";

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

  // Re-encode for reliable cuts across keyframes + consistent output.
  const args = [
    "-hide_banner",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-vf",
    scale,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    outPath
  ];

  await run("ffmpeg", args, { timeoutMs: 10 * 60_000 });

  return NextResponse.json({
    exportUrl: `/exports/${outName}`
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
