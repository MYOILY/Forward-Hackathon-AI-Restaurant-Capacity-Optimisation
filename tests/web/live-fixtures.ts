import { approveObjects } from "./baseline-fixtures";
import type {
  LiveAssessmentRequest,
  LiveConfig,
  LiveObservation,
  LiveSurfaceAssessment,
} from "../../shared/live-contracts";
import { replayFixture, person } from "./replay-fixtures";

export function liveConfig(detectionOnly = false, tableCount = 1): LiveConfig {
  const base = replayFixture(1, undefined, tableCount);
  if (!detectionOnly) base.tables.forEach((table) => approveObjects(table));
  return {
    session_id: "independent-session",
    epoch: 1,
    calibration_id: "calibration-A",
    width: 640,
    height: 360,
    sample_hz: 10,
    tables: base.tables,
    rules: base.rules,
    detection_only: detectionOnly,
    evidence_max_age_s: 5,
  };
}
export function liveObservation(
  t: number,
  occupied = false,
  config = liveConfig(),
  frameIndex = Math.round(t * 10),
): LiveObservation {
  const observation: LiveObservation = {
    t,
    frame_index: frameIndex,
    session_id: config.session_id,
    epoch: config.epoch,
    calibration_id: config.calibration_id,
    frame_sha256: frameIndex.toString(16).padStart(64, "0"),
    valid: true,
    detections: [],
    tracks: [],
    tables: Object.fromEntries(
      config.tables.map((table) => [table.id, "absent"]),
    ),
    surface: Object.fromEntries(
      config.tables.map((table) => [
        table.id,
        { visible: true, changed: false },
      ]),
    ),
  };
  if (occupied) person(observation, "anonymous-person");
  return observation;
}
export function livePositive(
  request: LiveAssessmentRequest,
  available_t: number,
): LiveSurfaceAssessment {
  return {
    ...request,
    id: `result-${request.id}`,
    request_id: request.id,
    available_t,
    crop_sha256: "d".repeat(64),
    outcome: "cleared_reset",
    valid: true,
    reason: "Independent synthetic model outcome, not model validation",
    model: "test-double",
    object_evidence: {
      detections: [{ class_id: 41, score: 0.9, box: [0.1, 0.1, 0.4, 0.4] }],
      reference: {
        observable: true,
        brightness_offset: 0,
        changed_fraction: 0,
        largest_change_fraction: 0,
        edge_mismatch: null,
      },
    },
  };
}
