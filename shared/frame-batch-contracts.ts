import type { AssessmentRequest, Detection, FrameCapture, ObjectBaseline, Observation, SurfaceAssessment, Table } from "./contracts";
import limits from "./frame-batch-limits.json" with { type: "json" };

export const FRAME_BATCH_LIMITS = Object.freeze(limits);
export type FrameOperation = "propose-tables" | "propose-reference" | "observe-batch" | "assess-batch";
export interface FrameInput extends FrameCapture { image_base64: string }
export interface EncodedImage { image_base64: string; sha256: string; width: number; height: number }
export interface FrameSource { sha256: string; width: number; height: number; fps: number; duration_s: number }
/** Checkpoints are opaque to the browser; only the fixed Python codec restores them. */
export type FrameCheckpoint = Record<string, unknown>;
export interface FrameBatchRequest {
  request_id: string;
  run_id: string;
  revision: number;
  model_sha256: string;
  config_sha256: string;
  build_id: string;
  source: FrameSource;
  tables: Table[];
  frames: FrameInput[];
  checkpoint?: FrameCheckpoint | null;
  requests?: AssessmentRequest[];
  references?: Record<string, EncodedImage>;
}
export interface FrameReplyIdentity {
  request_id: string;
  run_id: string;
  revision: number;
  model_sha256: string;
  config_sha256: string;
  build_id: string;
}
export interface FrameCapabilities {
  available: boolean;
  model_sha256: string | null;
  config_sha256: string;
  build_id: string;
  limits: typeof limits;
  reason?: string;
}
export interface ProposeTablesReply extends FrameReplyIdentity { tables: Table[] }
export interface ProposeReferenceReply extends FrameReplyIdentity {
  reference: EncodedImage;
  baseline: ObjectBaseline;
  detections: Detection[];
  geometry_sha256: string;
}
export interface ObserveBatchReply extends FrameReplyIdentity {
  observations: Observation[];
  checkpoint: FrameCheckpoint;
}
export interface EncodedAssessment extends SurfaceAssessment {
  crop_base64: string;
  width: number;
  height: number;
}
export interface AssessBatchReply extends FrameReplyIdentity { assessments: EncodedAssessment[] }
