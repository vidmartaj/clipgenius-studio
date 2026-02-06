import { NextResponse } from "next/server";
import type { AssistantReply, Timeline } from "../../../lib/types";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json()) as { projectId?: string; message?: string; timeline?: Timeline };
  const message = (body.message ?? "").toLowerCase();

  const reply: AssistantReply = {
    reply:
      "Got it. I can tighten pacing, pick stronger moments, and smooth transitions. Tell me: do you want this to feel fast, cinematic, or story-driven?",
    operations: []
  };

  // MVP “real” behavior: apply a meaningful timeline change for common requests.
  if (message.includes("shorter") || message.includes("cut it down") || message.includes("make it shorter")) {
    reply.reply =
      "Done — I trimmed the draft to a tighter cut. Want it even shorter, or should I keep more context at the start?";
    reply.operations = reply.operations ?? [];
    reply.operations.push({ op: "trim_to_target_seconds", targetSeconds: 60 });
  } else if (message.includes("fast") || message.includes("fast-paced") || message.includes("faster")) {
    reply.reply =
      "Nice — I’ll prioritize higher-energy moments and reduce downtime. Should the target be ~60s, ~90s, or ~3 minutes?";
  } else if (message.includes("transition")) {
    reply.reply =
      "Got it — I’ll use smoother transitions and fewer hard cuts. Do you prefer subtle dissolves or punchy cuts on beat?";
  } else if (message.includes("caption") || message.includes("subtitles")) {
    reply.reply =
      "Perfect — I’ll add clean captions. Do you want burned-in captions, or toggleable subtitles?";
  }

  return NextResponse.json(reply);
}
