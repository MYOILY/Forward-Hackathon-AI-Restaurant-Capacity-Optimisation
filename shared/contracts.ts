export interface ImageAsset {
  file: string;
  sha256: string;
  width: number;
  height: number;
}
export type Point = [number, number];
export type Box = [number, number, number, number];
export type Presence = "present" | "absent" | "uncertain";
export type Status = "unknown" | "occupied" | "needs_cleaning" | "ready";
export interface Detection {
  class_id: number;
  score: number;
  box: Box;
}
export type PeopleState =
  | "vacant"
  | "pending_arrival"
  | "occupied"
  | "pending_departure"
  | "uncertain";
export type SurfaceState = "cleared_reset" | "needs_reset" | "unverified";
export type SurfaceMethod = "objects_reference_v1";
export type DemoTimingProfile = "demo_fast_3x";
export interface ExpectedObject {
  class_id: number;
  count: number;
}
export interface ObjectBaseline {
  version: 1;
  approved: boolean;
  expected: ExpectedObject[];
  reference_sha256: string;
  geometry_sha256: string;
  detector_sha256: string;
  config_sha256: string;
  baseline_sha256: string;
  reviewed_by: string;
}
export interface ObjectReferenceAlignment {
  method: "translation_ecc_v1";
  applied: boolean;
  dx: number;
  dy: number;
  correlation: number | null;
}
export interface ObjectReferenceMeasurements {
  observable: boolean;
  reason?: string;
  brightness_offset: number | null;
  changed_fraction: number | null;
  largest_change_fraction: number | null;
  edge_mismatch: number | null;
  alignment?: ObjectReferenceAlignment;
}
export interface ObjectSurfaceEvidence {
  detections: Detection[];
  reference: ObjectReferenceMeasurements;
}
export interface SurfaceIdentity {
  timing_profile?: DemoTimingProfile;
  surface_method?: SurfaceMethod;
  baseline_sha256?: string;
  config_sha256?: string;
}
export interface Table extends SurfaceIdentity {
  expected_objects_draft?: ExpectedObject[];
  setup_review?: { tabletop: boolean; occupancy: boolean; map: boolean };
  object_baseline?: ObjectBaseline;
  id: string;
  label: string;
  monitoring_enabled?: boolean;
  capacity?: number;
  video_region: Box;
  crop: Box;
  seat_regions?: Point[][];
  map: {
    x: number;
    y: number;
    w: number;
    h: number;
    shape: "rect" | "round";
    rotation?: number;
  };
  chairs?: Point[];
  tabletop_polygon?: Point[];
  occupancy_regions?: Point[][];
  geometry_sha256?: string;
  reference: {
    file: string;
    source_t: number;
    confirmed_clean: boolean;
    sha256?: string;
    reviewed_by?: string;
    source_kind?: "uploaded_image" | "video_frame";
    source_image?: ImageAsset;
    alignment_confirmed?: boolean;
  } | null;
}
export interface TrackEvidence {
  track_id: string;
  box: Box;
  score: number;
  observed: boolean;
  table_id: string | null;
  candidate_table_ids: string[];
}
export interface SurfaceObservation {
  visible: boolean | null;
  changed: boolean;
  camera_moved?: boolean;
}
export interface Observation {
  t: number;
  frame_index: number;
  valid: boolean;
  detections: Detection[];
  tables: Record<string, Presence>;
  tracks?: TrackEvidence[];
  surface?: Record<string, SurfaceObservation>;
  scene_cut?: boolean;
  error?: string;
}
export interface StaffEvent {
  id: string;
  t: number;
  table_id: string;
  action:
    | "confirm_cleaned"
    | "force_cleaned"
    | "needs_cleaning"
    | "force_status"
    | "clear_status_override";
  status?: Status;
  source: "setup" | "staff";
  seq: number;
}
export interface Rules {
  demo_timing_scale?: 3;
  entry_s: number;
  exit_s: number;
  gap_s: number;
  assessment_separation_s?: number;
  assessment_retry_s?: number;
  track_grace_s?: number;
}
export interface AssessmentRequest extends SurfaceIdentity {
  id: string;
  table_id: string;
  t: number;
  frame_index: number;
  generation: number;
  video_sha256: string;
  geometry_sha256: string;
  reference_sha256: string;
}
export interface SurfaceAssessment extends SurfaceIdentity {
  object_evidence?: ObjectSurfaceEvidence;
  id: string;
  request_id: string;
  table_id: string;
  t: number;
  frame_index: number;
  generation: number;
  video_sha256: string;
  geometry_sha256: string;
  reference_sha256: string;
  crop_sha256: string;
  crop_file: string;
  outcome: "cleared_reset" | "not_reset" | "unobservable";
  valid: boolean;
  reason: string;
  model: string;
  prompt_version?: string;
  error?: string;
}
export interface Bundle {
  schema_version: 2;
  policy: "automatic_v2";
  provenance: "real_video" | "synthetic_fixture" | "ai_generated_video";
  video: {
    file: string;
    sha256: string;
    width: number;
    height: number;
    fps: number;
    duration_s: number;
  };
  original_scene: string | null;
  floor_plan?: ImageAsset;
  tables: Table[];
  observations: Observation[];
  staff_events: StaffEvent[];
  assessment_requests?: AssessmentRequest[];
  assessments?: SurfaceAssessment[];
  snapshots?: Omit<Snapshot, "events">[];
  replay_events?: LogEvent[];
  rules: Rules;
  analysis: Record<string, unknown>;
}
export interface TableState {
  table_id: string;
  status: Status;
  automatic_status?: Status;
  manual_override?: { status: Status; t: number; event_id: string } | null;
  monitoring_enabled?: boolean;
  presence: Presence;
  can_confirm_cleaned: boolean;
  can_force_cleaned?: boolean;
  needs_cleaning: boolean;
  reason: string;
  occupied_since: number | null;
  people_state?: PeopleState;
  surface_state?: SurfaceState;
  people_reason?: string;
  surface_reason?: string;
  people_evidence_t?: number | null;
  surface_evidence_t?: number | null;
  generation?: number;
  last_assessment?: SurfaceAssessment | null;
  readiness_source?: "automatic" | "staff" | "staff_override" | null;
}
export interface LogEvent {
  t: number;
  table_id: string;
  kind:
    | "transition"
    | "staff_accepted"
    | "staff_rejected"
    | "assessment_accepted"
    | "assessment_rejected";
  status: Status;
  reason: string;
  event_id?: string;
}
export interface Snapshot {
  t: number;
  tables: Record<string, TableState>;
  events: LogEvent[];
}
export interface ReplaySession {
  advanceTo(t: number): Snapshot;
  getAssessmentRequests(): AssessmentRequest[];
  submitAssessment(assessment: SurfaceAssessment): void;
  reset(staffEvents?: StaffEvent[]): void;
}
