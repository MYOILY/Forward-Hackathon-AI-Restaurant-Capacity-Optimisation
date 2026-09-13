import { createHash } from "node:crypto";
import type { Table } from "../../shared/contracts";
import {
  OBJECT_SURFACE_CONFIG_SHA256,
  OBJECT_SURFACE_DETECTOR_SHA256,
  OBJECT_SURFACE_METHOD,
} from "../../web/src/object-surface";
import { canonicalObjectJson } from "../../web/src/validation";

export function approveObjects(
  table: Table,
  expected = [{ class_id: 41, count: 1 }],
) {
  table.surface_method = OBJECT_SURFACE_METHOD;
  const baseline = {
    version: 1 as const,
    approved: true,
    expected,
    reference_sha256: table.reference!.sha256!,
    geometry_sha256: table.geometry_sha256!,
    detector_sha256: OBJECT_SURFACE_DETECTOR_SHA256,
    config_sha256: OBJECT_SURFACE_CONFIG_SHA256,
    reviewed_by: "Independent rule test fixture",
  };
  table.object_baseline = {
    ...baseline,
    baseline_sha256: createHash("sha256")
      .update(canonicalObjectJson(baseline))
      .digest("hex"),
  };
  return table;
}
