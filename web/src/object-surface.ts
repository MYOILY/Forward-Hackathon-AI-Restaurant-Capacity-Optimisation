import type {
  Detection,
  ObjectBaseline,
  ObjectSurfaceEvidence,
  Rules,
  SurfaceAssessment,
  Table,
} from "../../shared/contracts";
import configuration from "../../shared/object-surface-config.json" with { type: "json" };
import decisionPolicy from "../../shared/surface-decision-policy.json" with { type: "json" };
import alignmentConfiguration from "../../shared/reference-alignment-config.json" with { type: "json" };
import classNames from "../../shared/coco-classes.json" with { type: "json" };

export const OBJECT_SURFACE_DETECTOR_SHA256 =
  "427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7";
export const OBJECT_SURFACE_METHOD = "objects_reference_v1" as const;
export const OBJECT_SURFACE_CONFIG = configuration;
// Service interpretation is separate from approved detector/image measurement identity.
// The measurement configuration's legacy area/component/edge ceilings do not decide readiness.
export const SURFACE_DECISION_POLICY = decisionPolicy;
export const REFERENCE_CLEANING_THRESHOLD =
  decisionPolicy.cleaning_changed_fraction;
/** Explicit offline demo policy; image/object thresholds and baseline identity remain unchanged. */
export const objectSurfaceTiming = (rules: Rules) => ({
  recheck_s:
    decisionPolicy.stability.recheck_s / (rules.demo_timing_scale ?? 1),
  clearance_ttl_s:
    configuration.clearance_ttl_s / (rules.demo_timing_scale ?? 1),
});
// SHA-256 of recursively sorted compact JSON. Regenerate when configuration changes;
// the contract test detects drift before a browser can accept another configuration.
export const OBJECT_SURFACE_CONFIG_SHA256 =
  "3f71969710f1a0598b736500d5201d902a1e6dffab3fe1f4ba35a2cd872caa60";
export const OBJECT_CLASSES = classNames
  .map((label, class_id) => ({ class_id, label }))
  .filter(
    (item) =>
      item.class_id !== configuration.obstruction_class &&
      !configuration.ignored_classes.includes(item.class_id),
  );
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const unit = (value: unknown): value is number =>
  finite(value) && value >= 0 && value <= 1;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f\d]{64}$/i.test(value);
export const usesObjectSurface = (table: Table) =>
  table.surface_method === OBJECT_SURFACE_METHOD;

/** Structural checks are also used at the live boundary, which has no bundle loader. */
export function isObjectBaseline(value: unknown): value is ObjectBaseline {
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.approved !== "boolean" ||
    typeof value.reviewed_by !== "string" ||
    [...value.reviewed_by].length > 200 ||
    !value.reviewed_by.trim() ||
    Object.keys(value).some(
      (key) =>
        ![
          "version",
          "approved",
          "expected",
          "reference_sha256",
          "geometry_sha256",
          "detector_sha256",
          "config_sha256",
          "baseline_sha256",
          "reviewed_by",
        ].includes(key),
    ) ||
    ![
      "reference_sha256",
      "geometry_sha256",
      "detector_sha256",
      "config_sha256",
      "baseline_sha256",
    ].every(
      (key) =>
        hash(value[key]) && value[key] === (value[key] as string).toLowerCase(),
    ) ||
    !Array.isArray(value.expected) ||
    value.expected.length > OBJECT_CLASSES.length
  )
    return false;
  const seen = new Set<number>();
  return value.expected.every((item) => {
    if (
      !object(item) ||
      Object.keys(item).length !== 2 ||
      !Number.isSafeInteger(item.class_id) ||
      !OBJECT_CLASSES.some((entry) => entry.class_id === item.class_id) ||
      !Number.isSafeInteger(item.count) ||
      (item.count as number) < 0 ||
      (item.count as number) > 100 ||
      seen.has(item.class_id as number)
    )
      return false;
    seen.add(item.class_id as number);
    return true;
  });
}

export function approvedObjectBaseline(table: Table): ObjectBaseline | null {
  const baseline = table.object_baseline;
  return usesObjectSurface(table) &&
    isObjectBaseline(baseline) &&
    baseline.approved &&
    baseline.detector_sha256 === OBJECT_SURFACE_DETECTOR_SHA256 &&
    baseline.config_sha256 === OBJECT_SURFACE_CONFIG_SHA256 &&
    baseline.geometry_sha256 === table.geometry_sha256 &&
    baseline.reference_sha256 === table.reference?.sha256 &&
    table.reference.confirmed_clean
    ? baseline
    : null;
}

function validReferenceAlignment(value: unknown): boolean {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) => !["method", "applied", "dx", "dy", "correlation"].includes(key),
    ) ||
    value.method !== alignmentConfiguration.method ||
    typeof value.applied !== "boolean" ||
    !finite(value.dx) ||
    !finite(value.dy)
  )
    return false;
  const correlation = value.correlation;
  if (
    correlation !== null &&
    (!finite(correlation) || correlation < -1 || correlation > 1)
  )
    return false;
  return value.applied
    ? correlation !== null &&
        correlation >= alignmentConfiguration.min_correlation
    : value.dx === 0 && value.dy === 0;
}

/** Invalid detector/image data is uncertain evidence, never an empty clean inventory. */
export function isObjectSurfaceEvidence(
  value: unknown,
): value is ObjectSurfaceEvidence {
  if (
    !object(value) ||
    !Array.isArray(value.detections) ||
    !object(value.reference)
  )
    return false;
  if (
    !value.detections.every(
      (d) =>
        object(d) &&
        Number.isSafeInteger(d.class_id) &&
        (d.class_id as number) >= 0 &&
        (d.class_id as number) < classNames.length &&
        unit(d.score) &&
        Array.isArray(d.box) &&
        d.box.length === 4 &&
        d.box.every(unit) &&
        d.box[2] > d.box[0] &&
        d.box[3] > d.box[1],
    )
  )
    return false;
  const ref = value.reference;
  return (
    typeof ref.observable === "boolean" &&
    (ref.reason === undefined || typeof ref.reason === "string") &&
    (ref.brightness_offset === null || finite(ref.brightness_offset)) &&
    ["changed_fraction", "largest_change_fraction", "edge_mismatch"].every(
      (key) => ref[key] === null || unit(ref[key]),
    ) &&
    (ref.alignment === undefined || validReferenceAlignment(ref.alignment))
  );
}

export interface ObjectSurfaceDecision {
  outcome: SurfaceAssessment["outcome"];
  reason: string;
}
/** A broad unexpected label on an otherwise matching photo is not localized object evidence. */
export function isUncorroboratedBackgroundGuess(
  table: Table,
  evidence: ObjectSurfaceEvidence,
  item: Detection,
): boolean {
  const fraction = evidence.reference.changed_fraction;
  return (
    item.class_id !== configuration.obstruction_class &&
    !configuration.ignored_classes.includes(item.class_id) &&
    !table.object_baseline?.expected.some(
      (expected) => expected.class_id === item.class_id && expected.count > 0,
    ) &&
    evidence.reference.observable &&
    fraction !== null &&
    fraction <= REFERENCE_CLEANING_THRESHOLD &&
    (item.box[2] - item.box[0]) * (item.box[3] - item.box[1]) >=
      decisionPolicy.background_guess_min_box_fraction
  );
}
/** Sole semantic comparator for live, recorded analysis, and replay. Incoming outcomes are ignored. */
export function compareObjectSurface(
  table: Table,
  evidence: unknown,
  valid = true,
): ObjectSurfaceDecision {
  const uncertain = (reason: string): ObjectSurfaceDecision => ({
    outcome: "unobservable",
    reason,
  });
  const baseline = approvedObjectBaseline(table);
  if (!baseline)
    return uncertain("An approved expected-object baseline is required.");
  if (!valid || !isObjectSurfaceEvidence(evidence))
    return uncertain(
      "Surface assessment failed or returned malformed evidence.",
    );
  const ref = evidence.reference;
  if (!ref.observable)
    return uncertain(ref.reason || "Tabletop is not reliably observable.");
  if (
    ref.brightness_offset === null ||
    ref.changed_fraction === null ||
    ref.largest_change_fraction === null ||
    ref.largest_change_fraction > ref.changed_fraction
  )
    return uncertain("Reference measurements are missing or inconsistent.");
  if (Math.abs(ref.brightness_offset) > configuration.max_brightness_offset)
    return uncertain("Lighting differs too much from the approved setup.");
  const detections = evidence.detections.filter(
    (item) =>
      item.score >= configuration.score_floor &&
      !configuration.ignored_classes.includes(item.class_id),
  );
  if (
    detections.some((item) => item.class_id === configuration.obstruction_class)
  )
    return uncertain("A person is obstructing the tabletop.");
  const strong = detections.filter(
    (item) =>
      item.score >= configuration.confident_score &&
      !isUncorroboratedBackgroundGuess(table, evidence, item),
  );
  const weak = detections.filter(
    (item) =>
      item.score < configuration.confident_score ||
      isUncorroboratedBackgroundGuess(table, evidence, item),
  );
  const expected = new Map(
    baseline.expected.map((item) => [item.class_id, item.count]),
  );
  const count = (items: typeof detections, id: number) =>
    items.filter((item) => item.class_id === id).length;
  for (const id of new Set(strong.map((item) => item.class_id))) {
    if (count(strong, id) > (expected.get(id) ?? 0))
      return {
        outcome: "not_reset",
        reason: `Extra ${classNames[id]} detected (${count(strong, id)}; expected ${expected.get(id) ?? 0}).`,
      };
  }
  for (const [id, amount] of expected) {
    if (count(strong, id) + count(weak, id) < amount)
      return {
        outcome: "not_reset",
        reason: `Missing ${classNames[id]} (${count(strong, id)} detected; expected ${amount}).`,
      };
  }
  if (ref.changed_fraction > REFERENCE_CLEANING_THRESHOLD)
    return {
      outcome: "not_reset",
      reason: `Reference difference ${(ref.changed_fraction * 100).toFixed(2)}% exceeds the ${(REFERENCE_CLEANING_THRESHOLD * 100).toFixed(2)}% cleaning threshold. Check and clean or reset the table.`,
    };
  // Weak extras need corroborating appearance change; only ambiguous expected counts block a match.
  if ([...expected].some(([id, amount]) => count(strong, id) < amount))
    return uncertain(
      "Expected-object counts are uncertain; another capture is required.",
    );
  return {
    outcome: "cleared_reset",
    reason:
      "Expected objects and tabletop appearance match the approved setup.",
  };
}

export function normalizeObjectAssessment<
  A extends Pick<
    SurfaceAssessment,
    | "surface_method"
    | "baseline_sha256"
    | "config_sha256"
    | "valid"
    | "outcome"
    | "reason"
    | "object_evidence"
  >,
>(table: Table, result: A): A {
  return usesObjectSurface(table)
    ? {
        ...result,
        ...compareObjectSurface(table, result.object_evidence, result.valid),
      }
    : result;
}
