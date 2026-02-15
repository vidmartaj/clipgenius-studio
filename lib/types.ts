// Analysis timeline (scene detection / AI suggestions on a single asset)
export type AnalysisClipKind = "source" | "highlight" | "broll";

export type AnalysisClip = {
  id: string;
  label: string;
  kind: AnalysisClipKind;
  start: number;
  end: number;
};

export type AnalysisTimeline = {
  assetId: string;
  durationSeconds: number;
  clips: AnalysisClip[];
};

// Project timeline (what the user actually exports)
export type ProjectClip = {
  id: string;
  assetId: string;
  label: string;
  sourceIn: number;
  sourceOut: number;
  // Audio controls for linked audio mode (gain multiplier; 1 = 100%).
  audioVolume?: number;
  audioMuted?: boolean;
  audioFadeIn?: number; // seconds
  audioFadeOut?: number; // seconds
};

export type AudioClip = {
  id: string;
  assetId: string;
  label: string;
  sourceIn: number;
  sourceOut: number;
  // Position on the project timeline (seconds).
  start: number;
  // Linear gain multiplier. 1 = 100%.
  volume?: number;
  muted?: boolean;
  fadeIn?: number; // seconds
  fadeOut?: number; // seconds
};

export type ProjectTimeline = {
  projectId: string;
  clips: ProjectClip[];
  // Optional, for when audio is unlinked from video and becomes its own editable lane.
  audioLinked?: boolean;
  audioClips?: AudioClip[];
  trackAudioMuted?: boolean;
  trackAudioVolume?: number; // 0..2
  trackVideoHidden?: boolean;
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
