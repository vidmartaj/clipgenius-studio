import { NextResponse } from "next/server";
import type { AssistantReply, ProjectTimeline } from "../../../lib/types";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json()) as { projectId?: string; message?: string; timeline?: ProjectTimeline };
  const message = (body.message ?? "").toLowerCase();
  const timeline = body.timeline;

  const hasClips = Boolean(timeline && Array.isArray(timeline.clips) && timeline.clips.length > 0);

  const reply: AssistantReply = {
    reply:
      "Got it. I can tighten pacing, pick stronger moments, and smooth transitions. Tell me: do you want this to feel fast, cinematic, or story-driven?",
    operations: []
  };

  // Parse target duration from user text (e.g. "30s", "60 sec", "2 min", "1:30").
  const targetSeconds = parseTargetSeconds(message);
  const style = parseStyle(message);
  const highlightsOnly = message.includes("action") || message.includes("highlights only") || message.includes("best moments");

  if (message.includes("focus on action") || message.includes("action scenes")) {
    const sec = targetSeconds ?? 60;
    reply.reply = `Done — I rebuilt the cut to prioritize action moments and key highlights (~${fmt(sec)}).`;
    if (hasClips) {
      reply.operations = [
        { op: "auto_edit", targetSeconds: sec, style: style ?? "fast", highlightsOnly: true },
        { op: "set_clip_length_profile", minSeconds: 0.9, maxSeconds: 2.8, avgSeconds: 1.8 },
        { op: "set_audio_fades", fadeInSeconds: 0.1, fadeOutSeconds: 0.1 }
      ];
    }
    return NextResponse.json(reply);
  }

  // Audio linking / track controls.
  if (message.includes("unlink audio") || message.includes("separate audio") || message.includes("separate the audio")) {
    reply.reply = "Done — I unlinked audio so you can edit it as a separate track on the timeline.";
    reply.operations = [{ op: "set_audio_linked", linked: false }];
    return NextResponse.json(reply);
  }

  if (message.includes("link audio") || message.includes("relink audio") || message.includes("use original audio")) {
    reply.reply = "Done — I linked audio back to the video clips.";
    reply.operations = [{ op: "set_audio_linked", linked: true }];
    return NextResponse.json(reply);
  }

  if (message.includes("mute audio") || message.includes("mute track") || message.includes("mute the audio")) {
    reply.reply = "Muted — I turned off the main audio track (A1).";
    reply.operations = [{ op: "set_track_audio", muted: true }];
    return NextResponse.json(reply);
  }

  if (message.includes("unmute audio") || message.includes("unmute track") || message.includes("turn audio back on")) {
    reply.reply = "Unmuted — audio is back on.";
    reply.operations = [{ op: "set_track_audio", muted: false }];
    return NextResponse.json(reply);
  }

  // Auto-draft / build-from-scratch intent.
  if (
    message.includes("auto") ||
    message.includes("draft") ||
    message.includes("highlight") ||
    message.includes("make a reel") ||
    message.includes("make a short") ||
    message.includes("make a tiktok") ||
    message.includes("make a montage")
  ) {
    const sec = targetSeconds ?? (style === "cinematic" ? 90 : 60);
    reply.reply =
      `On it — I’ll auto-build a ${fmt(sec)} ${style ? `${style} ` : ""}draft from your imported clips. ` +
      "You can then tell me what to change (pacing, moments, captions, music, transitions).";
    reply.operations = [
      { op: "auto_edit", targetSeconds: sec, style: style ?? "fast", highlightsOnly },
      // Default fades help the cut feel less abrupt.
      { op: "set_audio_fades", fadeInSeconds: style === "cinematic" ? 0.25 : 0.12, fadeOutSeconds: style === "cinematic" ? 0.25 : 0.12 }
    ];
    return NextResponse.json(reply);
  }

  // MVP “real” behavior: apply a meaningful timeline change for common requests.
  if (message.includes("shorter") || message.includes("cut it down") || message.includes("make it shorter")) {
    reply.reply =
      "Done — I trimmed the draft to a tighter cut. Want it even shorter, or should I keep more context at the start?";
    reply.operations = reply.operations ?? [];
    reply.operations.push({ op: "trim_to_target_seconds", targetSeconds: targetSeconds ?? 60 });
  } else if (message.includes("fast") || message.includes("fast-paced") || message.includes("faster")) {
    reply.reply =
      "Nice — I’ll prioritize higher-energy moments and reduce downtime. Should the target be ~60s, ~90s, or ~3 minutes?";
    if (hasClips && (message.includes("do it") || message.includes("apply") || message.includes("make it"))) {
      reply.operations = [
        { op: "auto_edit", targetSeconds: targetSeconds ?? 60, style: "fast", highlightsOnly: true },
        { op: "set_clip_length_profile", minSeconds: 0.9, maxSeconds: 2.6, avgSeconds: 1.7 },
        { op: "set_audio_fades", fadeInSeconds: 0.1, fadeOutSeconds: 0.1 }
      ];
    }
  } else if (message.includes("transition")) {
    reply.reply =
      "Got it — I’ll use smoother transitions and fewer hard cuts. Do you prefer subtle dissolves or punchy cuts on beat?";
    if (hasClips) {
      reply.operations = [
        { op: "set_clip_length_profile", minSeconds: 1.5, maxSeconds: 5.5, avgSeconds: 3.4 },
        { op: "set_audio_fades", fadeInSeconds: 0.25, fadeOutSeconds: 0.25 }
      ];
    }
  } else if (message.includes("caption") || message.includes("subtitles")) {
    reply.reply =
      "Perfect — I’ll add clean captions. Do you want burned-in captions, or toggleable subtitles?";
  } else if (message.includes("cinematic")) {
    const sec = targetSeconds ?? 90;
    reply.reply = `Got it — switching to a more cinematic cut (longer shots, smoother pacing). I’ll aim for ~${fmt(sec)}.`;
    if (hasClips && (message.includes("do it") || message.includes("apply") || message.includes("make it"))) {
      reply.operations = [
        { op: "auto_edit", targetSeconds: sec, style: "cinematic", highlightsOnly },
        { op: "set_clip_length_profile", minSeconds: 2.2, maxSeconds: 6.0, avgSeconds: 4.2 },
        { op: "set_audio_fades", fadeInSeconds: 0.28, fadeOutSeconds: 0.28 }
      ];
    }
  } else if (message.includes("story") || message.includes("narrative")) {
    const sec = targetSeconds ?? 120;
    reply.reply = `Nice — I’ll make it more story-driven (clear intro, build, payoff). Target: ~${fmt(sec)}.`;
    if (hasClips && (message.includes("do it") || message.includes("apply") || message.includes("make it"))) {
      reply.operations = [
        { op: "auto_edit", targetSeconds: sec, style: "story", highlightsOnly },
        { op: "set_clip_length_profile", minSeconds: 1.6, maxSeconds: 5.0, avgSeconds: 3.1 },
        { op: "set_audio_fades", fadeInSeconds: 0.2, fadeOutSeconds: 0.22 }
      ];
    }
  }

  return NextResponse.json(reply);
}

function parseStyle(message: string): "fast" | "cinematic" | "story" | null {
  if (message.includes("cinematic") || message.includes("movie") || message.includes("dramatic")) return "cinematic";
  if (message.includes("story") || message.includes("story-driven") || message.includes("narrative")) return "story";
  if (message.includes("fast") || message.includes("hype") || message.includes("aggressive")) return "fast";
  return null;
}

function parseTargetSeconds(message: string): number | null {
  // 1:30
  const mmss = message.match(/\b(\d{1,2})\s*:\s*(\d{2})\b/);
  if (mmss) {
    const m = Number(mmss[1]);
    const s = Number(mmss[2]);
    const sec = m * 60 + s;
    if (Number.isFinite(sec) && sec > 0) return clamp(sec, 5, 20 * 60);
  }

  const secMatch = message.match(/\b(\d{1,4})\s*(s|sec|secs|second|seconds)\b/);
  if (secMatch) {
    const sec = Number(secMatch[1]);
    if (Number.isFinite(sec) && sec > 0) return clamp(sec, 5, 20 * 60);
  }

  const minMatch = message.match(/\b(\d{1,3})\s*(m|min|mins|minute|minutes)\b/);
  if (minMatch) {
    const m = Number(minMatch[1]);
    const sec = m * 60;
    if (Number.isFinite(sec) && sec > 0) return clamp(sec, 5, 20 * 60);
  }

  return null;
}

function fmt(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m <= 0) return `${r}s`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}
