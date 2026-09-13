import type {
  AssessmentRequest,
  Detection,
  ObjectSurfaceEvidence,
  SurfaceAssessment,
  Observation,
} from "../../shared/contracts";
import type {
  LiveAssessmentRequest,
  LiveSurfaceAssessment,
} from "../../shared/live-contracts";
import { replayFixture, assessment } from "./replay-fixtures";
import { liveConfig, livePositive } from "./live-fixtures";

import { approveObjects } from "./baseline-fixtures";
export { approveObjects } from "./baseline-fixtures";
export const detected = (class_id = 41, score = 0.9): Detection => ({
  class_id,
  score,
  box: [0.1, 0.1, 0.4, 0.4],
});
export const objectEvidence = (
  detections = [detected()],
): ObjectSurfaceEvidence => ({
  detections,
  reference: {
    observable: true,
    brightness_offset: 0,
    changed_fraction: 0,
    largest_change_fraction: 0,
    edge_mismatch: null,
  },
});
export function objectBundle(
  duration = 40,
  change?: (observation: Observation) => void,
  tableCount = 1,
) {
  const bundle = replayFixture(duration, change, tableCount);
  bundle.tables.forEach((table) => approveObjects(table));
  return bundle;
}
export function objectLiveConfig(count = 1) {
  const config = liveConfig(false, count);
  config.tables.forEach((table) => approveObjects(table));
  return config;
}
/** Placeholder outcome intentionally opposes matching evidence; only TS may decide it. */
export function objectAssessment(
  request: AssessmentRequest,
  evidence = objectEvidence(),
): SurfaceAssessment {
  return assessment(request, "unobservable", {
    surface_method: request.surface_method,
    baseline_sha256: request.baseline_sha256,
    config_sha256: request.config_sha256,
    object_evidence: evidence,
    reason: "Awaiting shared comparison",
    prompt_version: undefined,
  });
}
export function objectLiveAssessment(
  request: LiveAssessmentRequest,
  available_t = request.t,
  evidence = objectEvidence(),
): LiveSurfaceAssessment {
  return {
    ...livePositive(request, available_t),
    outcome: "unobservable",
    reason: "Awaiting shared comparison",
    object_evidence: evidence,
    prompt_version: undefined,
  };
}
