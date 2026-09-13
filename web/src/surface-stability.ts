import type { Rules, SurfaceAssessment, Table } from "../../shared/contracts";
import {
  approvedObjectBaseline,
  isUncorroboratedBackgroundGuess,
  OBJECT_SURFACE_CONFIG,
  REFERENCE_CLEANING_THRESHOLD,
  SURFACE_DECISION_POLICY,
} from "./object-surface";

type Evidence = Pick<
  SurfaceAssessment,
  "t" | "outcome" | "valid" | "reason" | "error"
> &
  Partial<Pick<SurfaceAssessment, "object_evidence">>;
export interface SurfaceStabilityMemory {
  alignmentMode: boolean | null;
  pendingAlignment: { mode: boolean; t: number } | null;
  pendingObjects: { key: string; t: number } | null;
}
export const createSurfaceStabilityMemory = (): SurfaceStabilityMemory => ({
  alignmentMode: null,
  pendingAlignment: null,
  pendingObjects: null,
});
export function resetSurfaceStability(
  memory: SurfaceStabilityMemory,
  forgetAlignment = false,
) {
  memory.pendingAlignment = null;
  memory.pendingObjects = null;
  if (forgetAlignment) memory.alignmentMode = null;
}
export function surfaceStabilityTiming(rules: Rules) {
  const policy = SURFACE_DECISION_POLICY.stability,
    scale = rules.demo_timing_scale ?? 1;
  return {
    ...(Object.fromEntries(
      Object.entries(policy).map(([key, value]) => [
        key,
        key.endsWith("_s") ? value / scale : value,
      ]),
    ) as typeof policy),
    evidence_ttl_s: OBJECT_SURFACE_CONFIG.clearance_ttl_s / scale,
  };
}

function mismatchKey(table: Table, result: Evidence): string {
  const expected = new Map(
    approvedObjectBaseline(table)!.expected.map((item) => [
      item.class_id,
      item.count,
    ]),
  );
  const detections = result.object_evidence!.detections.filter(
    (item) =>
      item.score >= OBJECT_SURFACE_CONFIG.score_floor &&
      !OBJECT_SURFACE_CONFIG.ignored_classes.includes(item.class_id),
  );
  const ids = [
    ...new Set([
      ...expected.keys(),
      ...detections.map((item) => item.class_id),
    ]),
  ].sort((a, b) => a - b);
  return ids
    .flatMap((id) => {
      const strong = detections.filter(
        (item) =>
          item.class_id === id &&
          item.score >= OBJECT_SURFACE_CONFIG.confident_score &&
          !isUncorroboratedBackgroundGuess(
            table,
            result.object_evidence!,
            item,
          ),
      ).length;
      const all = detections.filter((item) => item.class_id === id).length;
      const amount = expected.get(id) ?? 0;
      return strong > amount
        ? [`extra:${id}:${strong - amount}`]
        : all < amount
          ? [`missing:${id}:${amount - all}`]
          : [];
    })
    .join("|");
}

/** Called only after normalization, identity/freshness checks and source-capture deduplication. */
export function stabilizeSurfaceAssessment<A extends Evidence>(
  memory: SurfaceStabilityMemory,
  table: Table,
  result: A,
  timing: ReturnType<typeof surfaceStabilityTiming>,
): A {
  const wait = (reason: string): A => ({
    ...result,
    outcome: "unobservable",
    reason,
  });
  // A delayed fresh result cannot confirm an old, unanswered candidate.
  if (
    memory.pendingAlignment &&
    result.t - memory.pendingAlignment.t + 1e-7 >= timing.evidence_ttl_s
  )
    memory.pendingAlignment = null;
  if (
    memory.pendingObjects &&
    result.t - memory.pendingObjects.t + 1e-7 >= timing.evidence_ttl_s
  )
    memory.pendingObjects = null;
  if (
    !result.valid ||
    result.outcome === "unobservable" ||
    !result.object_evidence
  ) {
    resetSurfaceStability(memory);
    return result;
  }
  const mode = result.object_evidence.reference.alignment?.applied;
  if (mode !== undefined) {
    if (memory.alignmentMode === null) memory.alignmentMode = mode;
    if (mode !== memory.alignmentMode) {
      memory.pendingObjects = null;
      if (memory.pendingAlignment?.mode !== mode)
        memory.pendingAlignment = { mode, t: result.t };
      if (
        result.t - memory.pendingAlignment.t + 1e-7 <
        timing.alignment_mode_confirmation_s
      )
        return wait(
          "Photo alignment changed; awaiting a consistent follow-up comparison.",
        );
      memory.alignmentMode = mode;
    }
    memory.pendingAlignment = null;
  } else memory.pendingAlignment = null;
  const difference = result.object_evidence.reference.changed_fraction;
  if (
    result.outcome === "not_reset" &&
    difference !== null &&
    difference <= REFERENCE_CLEANING_THRESHOLD &&
    approvedObjectBaseline(table)
  ) {
    const key = mismatchKey(table, result);
    if (key) {
      if (memory.pendingObjects?.key !== key)
        memory.pendingObjects = { key, t: result.t };
      if (
        result.t - memory.pendingObjects.t + 1e-7 <
        timing.object_confirmation_s
      )
        return wait(
          "An object mismatch needs a second capture because the photo difference is below the cleaning threshold.",
        );
      return result;
    }
  }
  memory.pendingObjects = null;
  return result;
}
