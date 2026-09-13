import { describe, expect, it } from "vitest";
import type { ObjectSurfaceEvidence } from "../../shared/contracts";
import { compareObjectSurface } from "../../web/src/object-surface";
import {
  createSurfaceStabilityMemory,
  resetSurfaceStability,
  stabilizeSurfaceAssessment,
  surfaceStabilityTiming,
} from "../../web/src/surface-stability";
import {
  approveObjects,
  detected,
  objectBundle,
  objectEvidence,
} from "./object-fixtures";

function harness() {
  const bundle = objectBundle(),
    table = approveObjects(bundle.tables[0], []),
    memory = createSurfaceStabilityMemory();
  const check = (
    t: number,
    difference = 0.02,
    detections = [] as ObjectSurfaceEvidence["detections"],
    aligned?: boolean,
  ) => {
    const evidence = objectEvidence(detections);
    evidence.reference.changed_fraction = difference;
    if (aligned !== undefined)
      evidence.reference.alignment = {
        method: "translation_ecc_v1",
        applied: aligned,
        dx: aligned ? 8 : 0,
        dy: aligned ? -5 : 0,
        correlation: aligned ? 0.91 : 0.84,
      };
    return stabilizeSurfaceAssessment(
      memory,
      table,
      {
        t,
        valid: true,
        ...compareObjectSurface(table, evidence),
        object_evidence: evidence,
      },
      surfaceStabilityTiming(bundle.rules),
    );
  };
  return { memory, check };
}
describe("temporal guards for object and alignment evidence", () => {
  it("alerts immediately on a reliable percentage mismatch without demanding object confirmation", () => {
    expect(harness().check(1, 0.10001).outcome).toBe("not_reset");
    expect(harness().check(1, 0.2, [detected(6, 0.55)]).outcome).toBe(
      "not_reset",
    );
  });
  it("prevents the recorded one-frame false train from creating a cleaning alert", () => {
    const h = harness();
    expect(h.check(125, 0.014, [], true).outcome).toBe("cleared_reset");
    expect(h.check(128.8, 0.0154, [detected(6, 0.549)], true)).toMatchObject({
      outcome: "unobservable",
      reason: expect.stringContaining("second capture"),
    });
    expect(h.check(129.8, 0.014, [], true).outcome).toBe("cleared_reset");
    expect(h.check(130.8, 0.015, [detected(6, 0.55)], true).outcome).toBe(
      "unobservable",
    );
  });
  it("requires a second matching object mismatch at least one source second later", () => {
    const h = harness();
    expect(h.check(1, 0.02, [detected(45)]).outcome).toBe("unobservable");
    expect(h.check(1.99, 0.02, [detected(45)]).outcome).toBe("unobservable");
    expect(h.check(2, 0.02, [detected(45)]).outcome).toBe("not_reset");
  });
  it("does not combine different object mismatches or obstruction-separated captures", () => {
    const h = harness();
    expect(h.check(1, 0.02, [detected(45)]).outcome).toBe("unobservable");
    expect(h.check(2, 0.02, [detected(41)]).outcome).toBe("unobservable");
    expect(h.check(3, 0.02, [detected(0)]).outcome).toBe("unobservable");
    expect(h.check(4, 0.02, [detected(41)]).outcome).toBe("unobservable");
    expect(h.check(5, 0.02, [detected(41)]).outcome).toBe("not_reset");
  });
  it("makes the recorded alignment cutoff flip uncertain and cancels it on a stable aligned follow-up", () => {
    const h = harness();
    expect(h.check(154.5, 0.0132, [], true).outcome).toBe("cleared_reset");
    expect(h.check(155.9, 0.100067, [], false)).toMatchObject({
      outcome: "unobservable",
      reason: expect.stringContaining("alignment changed"),
    });
    expect(h.check(156.9, 0.014, [], true).outcome).toBe("cleared_reset");
    expect(h.memory.pendingAlignment).toBeNull();
  });
  it("allows persistent changed appearance in a consistently confirmed comparison mode to alert", () => {
    const h = harness();
    h.check(1, 0.01, [], true);
    expect(h.check(3, 0.2, [], false).outcome).toBe("unobservable");
    expect(h.check(3.99, 0.2, [], false).outcome).toBe("unobservable");
    expect(h.check(4, 0.2, [], false).outcome).toBe("not_reset");
  });
  it("retains confirmed alignment across a brief obstruction but resets pending confirmations", () => {
    const h = harness();
    h.check(1, 0.02, [], true);
    h.check(3, 0.2, [], false);
    resetSurfaceStability(h.memory);
    expect(h.check(4, 0.2, [], false).outcome).toBe("unobservable");
    resetSurfaceStability(h.memory, true);
    expect(h.memory).toEqual(createSurfaceStabilityMemory());
  });
  it("expires unanswered object and alignment candidates before a much later matching result", () => {
    const objects = harness();
    expect(objects.check(1, 0.02, [detected(6, 0.55)]).outcome).toBe(
      "unobservable",
    );
    expect(objects.check(100, 0.02, [detected(6, 0.55)]).outcome).toBe(
      "unobservable",
    );
    expect(objects.check(101, 0.02, [detected(6, 0.55)]).outcome).toBe(
      "not_reset",
    );
    const alignment = harness();
    alignment.check(1, 0.02, [], true);
    expect(alignment.check(3, 0.2, [], false).outcome).toBe("unobservable");
    expect(alignment.check(13, 0.2, [], false).outcome).toBe("unobservable");
    expect(alignment.check(14, 0.2, [], false).outcome).toBe("not_reset");
  });
});
