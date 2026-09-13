import type {
  ImageAsset,
  Observation,
  Rules,
  Snapshot,
  StaffEvent,
  SurfaceAssessment,
  SurfaceIdentity,
  Table,
  TableState,
} from "./contracts";

/** Live evidence has session identity, never a fabricated finished-video hash. */
export interface LiveConfig {
  protocol_version: 1;
  session_id: string;
  epoch: number;
  calibration_id: string;
  width: number;
  height: number;
  sample_hz: number;
  tables: Table[];
  rules: Rules;
  detection_only: boolean;
  evidence_max_age_s: number;
}
export interface LiveObservation extends Observation {
  session_id: string;
  epoch: number;
  calibration_id: string;
  frame_sha256: string;
}
export interface LiveAssessmentRequest extends SurfaceIdentity {
  id: string;
  session_id: string;
  epoch: number;
  calibration_id: string;
  table_id: string;
  t: number;
  frame_index: number;
  frame_sha256: string;
  generation: number;
  geometry_sha256: string;
  reference_sha256: string;
}
export interface LiveSurfaceAssessment
  extends Omit<SurfaceAssessment, "video_sha256" | "crop_file"> {
  /** Ephemeral evidence image; live sessions never persist this crop. */
  crop_base64?: string;
  session_id: string;
  epoch: number;
  calibration_id: string;
  frame_sha256: string;
  available_t: number;
}
export interface LiveSnapshot extends Omit<Snapshot, "tables"> {
  tables: Record<
    string,
    Omit<TableState, "last_assessment"> & {
      last_assessment?: LiveSurfaceAssessment | null;
    }
  >;
  stopped: boolean;
}
export type LiveCommand =
  | { op: "init"; config: LiveConfig }
  | { op: "observation"; observation: LiveObservation; now: number }
  | { op: "tick"; t: number }
  | { op: "assessment"; result: LiveSurfaceAssessment; now: number }
  | { op: "staff"; event: StaffEvent }
  | { op: "monitoring"; table_id: string; enabled: boolean; t: number }
  | { op: "rename"; table_id: string; label: string; t: number }
  | { op: "stop"; t: number };
export interface LiveReply {
  snapshot: LiveSnapshot;
  requests: LiveAssessmentRequest[];
}

export type JobStatus =
  | "uploading"
  | "preparing"
  | "needs_setup"
  | "analyzing"
  | "completed"
  | "cancelled"
  | "failed";
export interface CalibrationTable extends Table {
  reference_source?: "uploaded_image" | "video_frame";
  reference_image_sha256?: string;
  alignment_confirmed?: boolean;
  reference_t?: number | null;
  reference_approved?: boolean;
}
export interface SourceInfo {
  setup_assets?: { clean_reference?: ImageAsset; floor_plan?: ImageAsset };
  setup_reference?: {
    reference_source: "video_frame" | "uploaded_image";
    reference_t: number | null;
    reference_image_sha256?: string;
    alignment_confirmed: boolean;
  };
  setup_mode?: "guided_v1";
  floor_plan_mode?: "uploaded" | "schematic";
  id: string;
  kind: "video" | "camera";
  label: string;
  status: JobStatus;
  progress: number;
  phase: string;
  error?: string;
  revision: number;
  calibration_confirmed: boolean;
  width: number;
  height: number;
  fps: number;
  duration_s: number;
  tables: CalibrationTable[];
  media_url?: string;
  frame_url?: string;
  frame_base64?: string;
  manifest_url?: string;
  detection_only?: boolean;
  device_key?: string;
}
