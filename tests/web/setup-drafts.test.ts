import { describe, expect, it } from "vitest";
import { createReplaySession } from "../../web/src/engine";
import { compareObjectSurface } from "../../web/src/object-surface";
import {
  validateBundle,
  validateExpectedObjectsDraft,
  verifyBundleGeometry,
} from "../../web/src/validation";
import { objectBundle, objectEvidence } from "./object-fixtures";

describe("expected-object drafts preserve edits without approval authority", () => {
  it.each(
    [
      [],
      [{ class_id: 41, count: 0 }],
      [
        { class_id: 39, count: 100 },
        { class_id: 45, count: 2 },
      ],
    ].map((expected) => ({ expected })),
  )(
    "accepts valid partial inventory editing progress: $expected",
    ({ expected }) => {
      const bundle = objectBundle();
      bundle.tables[0].expected_objects_draft = expected;
      expect(() => validateBundle(bundle)).not.toThrow();
    },
  );
  it.each(
    [
      null,
      {},
      [{ class_id: 0, count: 1 }],
      [{ class_id: 56, count: 1 }],
      [{ class_id: 60, count: 1 }],
      [{ class_id: 80, count: 1 }],
      [{ class_id: 41, count: -1 }],
      [{ class_id: 41, count: 101 }],
      [{ class_id: 41, count: 1.5 }],
      [{ class_id: 41, count: true }],
      [{ class_id: 41, count: 1, approved: true }],
      [
        { class_id: 41, count: 1 },
        { class_id: 41, count: 2 },
      ],
    ].map((expected) => ({ expected })),
  )("rejects malformed draft inventory: $expected", ({ expected }) => {
    expect(() => validateExpectedObjectsDraft(expected)).toThrow();
    const bundle = objectBundle();
    Object.assign(bundle.tables[0], { expected_objects_draft: expected });
    expect(() => validateBundle(bundle)).toThrow();
  });
  it("keeps approved baseline and geometry hashes unchanged when draft counts differ", async () => {
    const bundle = objectBundle(),
      table = bundle.tables[0];
    const baseline = structuredClone(table.object_baseline),
      geometry = table.geometry_sha256;
    table.expected_objects_draft = [{ class_id: 45, count: 7 }];
    validateBundle(bundle);
    await verifyBundleGeometry(bundle);
    expect(table.object_baseline).toEqual(baseline);
    expect(table.geometry_sha256).toBe(geometry);
    expect(compareObjectSurface(table, objectEvidence()).outcome).toBe(
      "cleared_reset",
    );
    expect(compareObjectSurface(table, objectEvidence([])).outcome).toBe(
      "not_reset",
    );
  });
  it("never schedules automatic readiness from draft quantities alone", () => {
    const bundle = objectBundle();
    delete bundle.tables[0].object_baseline;
    bundle.tables[0].expected_objects_draft = [{ class_id: 41, count: 1 }];
    validateBundle(bundle);
    const session = createReplaySession(bundle);
    expect(session.advanceTo(7).tables.T1.status).toBe("unknown");
    expect(session.getAssessmentRequests()).toEqual([]);
    expect(
      compareObjectSurface(bundle.tables[0], objectEvidence()).outcome,
    ).toBe("unobservable");
  });
});
