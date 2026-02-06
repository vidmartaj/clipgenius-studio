export type TimelineClipKind = "source" | "highlight" | "broll";

export type TimelineClip = {
  id: string;
  label: string;
  kind: TimelineClipKind;
  start: number;
  end: number;
};

export type Timeline = {
  projectId: string;
  durationSeconds: number;
  clips: TimelineClip[];
};

export type AssistantOperation =
  | {
      op: "trim_to_target_seconds";
      targetSeconds: number;
    };

export type AssistantReply = {
  reply: string;
  operations?: AssistantOperation[];
};

