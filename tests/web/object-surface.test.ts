import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  compareObjectSurface,
  isObjectBaseline,
  isObjectSurfaceEvidence,
  OBJECT_SURFACE_CONFIG,
  OBJECT_SURFACE_CONFIG_SHA256,
  OBJECT_SURFACE_DETECTOR_SHA256,
  REFERENCE_CLEANING_THRESHOLD,
  SURFACE_DECISION_POLICY,
} from "../../web/src/object-surface";
import { ObjectEvidence } from "../../web/src/ObjectEvidence";
import {
  canonicalObjectJson,
  validateBundle,
  verifyBundleGeometry,
} from "../../web/src/validation";
import {
  approveObjects,
  detected,
  objectBundle,
  objectEvidence,
} from "./object-fixtures";

describe("deterministic object and reference comparison", () => {
  it("derives matches, extras and missing objects from an approved inventory", () => {
    const table = objectBundle().tables[0];
    expect(compareObjectSurface(table, objectEvidence()).outcome).toBe(
      "cleared_reset",
    );
    expect(
      compareObjectSurface(table, objectEvidence([detected(), detected(45)]))
        .reason,
    ).toMatch(/Extra bowl/);
    expect(compareObjectSurface(table, objectEvidence([])).reason).toMatch(
      /Missing cup/,
    );
  });
  it("supports explicitly approved empty baselines and ignores room furniture", () => {
    const table = approveObjects(objectBundle().tables[0], []);
    expect(compareObjectSurface(table, objectEvidence([])).outcome).toBe(
      "cleared_reset",
    );
    expect(
      compareObjectSurface(table, objectEvidence([detected(56), detected(60)]))
        .outcome,
    ).toBe("cleared_reset");
    expect(
      compareObjectSurface(table, objectEvidence([detected(45)])).outcome,
    ).toBe("not_reset");
  });
  it("keeps ambiguous expected counts uncertain while weak extras need reference-difference corroboration", () => {
    const table = objectBundle().tables[0];
    expect(
      compareObjectSurface(table, objectEvidence([detected(41, 0.49)])).outcome,
    ).toBe("unobservable");
    expect(
      compareObjectSurface(
        table,
        objectEvidence([detected(), detected(45, 0.15)]),
      ).outcome,
    ).toBe("cleared_reset");
    expect(
      compareObjectSurface(table, objectEvidence([detected(45, 0.4)])).outcome,
    ).toBe("not_reset");
    expect(
      compareObjectSurface(table, objectEvidence([detected(41, 0.5)])).outcome,
    ).toBe("cleared_reset");
    expect(
      compareObjectSurface(
        table,
        objectEvidence([detected(), detected(45, 0.149)]),
      ).outcome,
    ).toBe("cleared_reset");
  });
  it("does not mistake a weak full-table train guess for dirt on a matching empty reference", () => {
    const table = approveObjects(objectBundle().tables[0], []);
    const evidence = objectEvidence([
      { ...detected(6, 0.36), box: [0, 0, 1, 1] },
    ]);
    Object.assign(evidence.reference, {
      changed_fraction: 0.0188,
      largest_change_fraction: 0.01,
      edge_mismatch: 0.99,
    });
    expect(compareObjectSurface(table, evidence).outcome).toBe("cleared_reset");
    expect(
      compareObjectSurface(table, {
        ...evidence,
        reference: { ...evidence.reference, changed_fraction: 0.10001 },
      }).outcome,
    ).toBe("not_reset");
    expect(
      compareObjectSurface(table, {
        ...evidence,
        detections: [detected(6, 0.5)],
      }).outcome,
    ).toBe("not_reset");
  });
  it("requires confident coverage of every expected object, without counting weak extras as proof of a missing item", () => {
    const table = approveObjects(objectBundle().tables[0], [
      { class_id: 41, count: 2 },
    ]);
    expect(
      compareObjectSurface(
        table,
        objectEvidence([detected(), detected(41, 0.49)]),
      ).outcome,
    ).toBe("unobservable");
    expect(
      compareObjectSurface(
        table,
        objectEvidence([detected(), detected(6, 0.36)]),
      ).outcome,
    ).toBe("not_reset");
    expect(
      compareObjectSurface(
        table,
        objectEvidence([
          detected(),
          detected(),
          detected(6, 0.36),
          detected(41, 0.3),
        ]),
      ).outcome,
    ).toBe("cleared_reset");
  });
  it.each([6, 45])(
    "requires appearance corroboration for an unexpected label covering nearly the whole matching tabletop (class %s)",
    (classId) => {
      const table = approveObjects(objectBundle().tables[0], []);
      const broad = {
        ...detected(classId, 0.95),
        box: [0, 0, 1, 1] as [number, number, number, number],
      };
      const evidence = objectEvidence([broad]);
      evidence.reference.changed_fraction = 0.02;
      expect(compareObjectSurface(table, evidence).outcome).toBe(
        "cleared_reset",
      );
      expect(
        compareObjectSurface(table, {
          ...evidence,
          reference: { ...evidence.reference, changed_fraction: 0.10001 },
        }).outcome,
      ).toBe("not_reset");
      expect(
        compareObjectSurface(table, objectEvidence([detected(classId, 0.95)]))
          .outcome,
      ).toBe("not_reset");
      expect(
        compareObjectSurface(table, objectEvidence([{ ...broad, class_id: 0 }]))
          .outcome,
      ).toBe("unobservable");
      const html = renderToStaticMarkup(
        createElement(ObjectEvidence, {
          table,
          assessment: {
            t: 147.9,
            reason: "Compared with reference.",
            object_evidence: evidence,
          },
        }),
      );
      expect(html).toContain("<td>0</td><td>0</td><td>1</td>");
      expect(html).toContain("A broad object label is uncertain");
    },
  );
  it("continues counting broad objects that the operator explicitly expects", () => {
    const table = objectBundle().tables[0];
    const broad = {
      ...detected(41),
      box: [0, 0, 1, 1] as [number, number, number, number],
    };
    expect(compareObjectSurface(table, objectEvidence([broad])).outcome).toBe(
      "cleared_reset",
    );
    expect(compareObjectSurface(table, objectEvidence([])).outcome).toBe(
      "not_reset",
    );
  });
  it("rejects people, visibility failures and unusable lighting before object decisions", () => {
    const table = objectBundle().tables[0];
    expect(
      compareObjectSurface(
        table,
        objectEvidence([detected(0, 0.15), detected(45)]),
      ).outcome,
    ).toBe("unobservable");
    for (const reference of [
      { observable: false, reason: "Camera moved" },
      { brightness_offset: 24.001 },
      { brightness_offset: -24.001 },
      { changed_fraction: null },
      { changed_fraction: 0.01, largest_change_fraction: 0.02 },
    ]) {
      const evidence = objectEvidence([detected(45)]);
      Object.assign(evidence.reference, reference);
      expect(compareObjectSurface(table, evidence).outcome).toBe(
        "unobservable",
      );
    }
  });
  it("keeps the exact difference boundary clean while larger visible differences request cleaning", () => {
    const table = objectBundle().tables[0];
    const evidence = objectEvidence();
    Object.assign(evidence.reference, {
      brightness_offset: 24,
      changed_fraction: 0.1,
      largest_change_fraction: 0.06,
      edge_mismatch: 0.99,
    });
    expect(compareObjectSurface(table, evidence).outcome).toBe("cleared_reset");
    for (const changed_fraction of [0.10001, 0.2, 1]) {
      expect(
        compareObjectSurface(table, {
          ...evidence,
          reference: { ...evidence.reference, changed_fraction },
        }),
      ).toMatchObject({
        outcome: "not_reset",
        reason: expect.stringContaining("cleaning threshold"),
      });
    }
  });
  it("uses the chosen percentage policy without historical component or edge vetoes", () => {
    const table = objectBundle().tables[0];
    for (const changed_fraction of [0.029, 0.065, 0.1]) {
      const evidence = objectEvidence();
      Object.assign(evidence.reference, {
        changed_fraction,
        largest_change_fraction: changed_fraction,
        edge_mismatch: 0.99,
      });
      expect(compareObjectSurface(table, evidence).outcome).toBe(
        "cleared_reset",
      );
    }
  });
  it("does not let weak object detections suppress a measured large reference difference", () => {
    const table = objectBundle().tables[0];
    for (const detections of [
      [detected(41, 0.49)],
      [detected(), detected(45, 0.15)],
    ]) {
      const evidence = objectEvidence(detections);
      evidence.reference.changed_fraction = 0.2;
      expect(compareObjectSurface(table, evidence)).toEqual({
        outcome: "not_reset",
        reason:
          "Reference difference 20.00% exceeds the 10.00% cleaning threshold. Check and clean or reset the table.",
      });
    }
  });
  it("does not turn high difference from unreliable, invalid, unapproved or obstructed images into cleaning evidence", () => {
    const table = objectBundle().tables[0];
    const highDifference = objectEvidence();
    highDifference.reference.changed_fraction = 0.2;
    for (const reference of [
      { observable: false },
      { brightness_offset: 24.001 },
      { brightness_offset: -24.001 },
      { largest_change_fraction: null },
      { largest_change_fraction: 0.3 },
    ]) {
      expect(
        compareObjectSurface(table, {
          ...highDifference,
          reference: { ...highDifference.reference, ...reference },
        }).outcome,
      ).toBe("unobservable");
    }
    expect(
      compareObjectSurface(table, {
        ...highDifference,
        detections: [detected(), detected(0, 0.15)],
      }).outcome,
    ).toBe("unobservable");
    expect(compareObjectSurface(table, highDifference, false).outcome).toBe(
      "unobservable",
    );
    table.object_baseline!.approved = false;
    expect(compareObjectSurface(table, highDifference).outcome).toBe(
      "unobservable",
    );
  });
  it.each([
    null,
    {},
    { detections: [], reference: {} },
    { ...objectEvidence(), detections: [detected(80)] },
    { ...objectEvidence(), detections: [detected(41, NaN)] },
    { ...objectEvidence(), detections: [{ ...detected(), box: [0, 0, 2, 1] }] },
  ])(
    "cannot turn malformed inference into an empty matching inventory: %j",
    (evidence) => {
      const table = approveObjects(objectBundle().tables[0], []);
      expect(compareObjectSurface(table, evidence).outcome).toBe(
        "unobservable",
      );
    },
  );
  it("requires approval, reference/geometry identities and the installed comparison configuration", () => {
    for (const field of [
      "approved",
      "reference_sha256",
      "geometry_sha256",
      "config_sha256",
      "detector_sha256",
    ] as const) {
      const table = objectBundle().tables[0];
      if (field === "approved") table.object_baseline!.approved = false;
      else table.object_baseline![field] = "f".repeat(64);
      expect(compareObjectSurface(table, objectEvidence()).outcome).toBe(
        "unobservable",
      );
    }
    expect(
      compareObjectSurface(objectBundle().tables[0], objectEvidence(), false)
        .outcome,
    ).toBe("unobservable");
  });
});

describe("optional reference alignment diagnostics", () => {
  const accepted = {
    method: "translation_ecc_v1",
    applied: true,
    dx: -8,
    dy: 1.25,
    correlation: 0.85,
  };
  const fallback = {
    method: "translation_ecc_v1",
    applied: false,
    dx: 0,
    dy: 0,
    correlation: null,
  };
  const withAlignment = (alignment: unknown) => {
    const evidence = objectEvidence();
    return { ...evidence, reference: { ...evidence.reference, alignment } };
  };
  it("accepts legacy evidence with no alignment and well-formed corrections or raw fallbacks", () => {
    expect(isObjectSurfaceEvidence(objectEvidence())).toBe(true);
    for (const alignment of [
      accepted,
      { ...accepted, correlation: 1 },
      fallback,
      { ...fallback, correlation: -1 },
      { ...fallback, correlation: 1 },
    ]) {
      expect(isObjectSurfaceEvidence(withAlignment(alignment))).toBe(true);
      expect(
        compareObjectSurface(objectBundle().tables[0], withAlignment(alignment))
          .outcome,
      ).toBe("cleared_reset");
    }
  });
  it.each([
    null,
    [],
    {},
    { ...accepted, method: "unbounded_warp" },
    { ...accepted, applied: "true" },
    { ...accepted, dx: NaN },
    { ...accepted, dx: Infinity },
    { ...accepted, dy: -Infinity },
    { ...accepted, dy: "1" },
    { ...accepted, correlation: null },
    { ...accepted, correlation: 0.849999 },
    { ...accepted, correlation: NaN },
    { ...accepted, correlation: 1.00001 },
    { ...fallback, correlation: -1.00001 },
    { ...accepted, correlation: ".99" },
    { ...fallback, dx: 1 },
    { ...fallback, dy: -1 },
    { ...accepted, correlation: undefined },
    { ...accepted, extra: true },
  ])(
    "rejects malformed or internally inconsistent alignment metadata: %j",
    (alignment) => {
      const evidence = withAlignment(alignment);
      expect(isObjectSurfaceEvidence(evidence)).toBe(false);
      expect(
        compareObjectSurface(objectBundle().tables[0], evidence).outcome,
      ).toBe("unobservable");
    },
  );
  it("retains the 10% and person-obstruction decisions after an accepted correction", () => {
    const table = objectBundle().tables[0];
    const high = withAlignment(accepted);
    high.reference.changed_fraction = 0.2;
    expect(compareObjectSurface(table, high).outcome).toBe("not_reset");
    const blocked = withAlignment(accepted);
    blocked.detections.push(detected(0, 0.15));
    expect(compareObjectSurface(table, blocked).outcome).toBe("unobservable");
  });
});

describe("reference difference evidence display", () => {
  it("shows the measured percentage, strict cleaning trigger and assessment source time without presenting it as live", () => {
    const table = objectBundle().tables[0],
      evidence = objectEvidence();
    evidence.reference.changed_fraction = 0.2534;
    const text = renderToStaticMarkup(
      createElement(ObjectEvidence, {
        table,
        assessment: {
          t: 12.3,
          reason: "Check this table.",
          object_evidence: evidence,
        },
      }),
    ).replace(/<[^>]*>/g, "");
    expect(text).toContain("Last assessed reference difference: 25.34%");
    expect(text).toContain("Cleaning threshold: above 10.00%");
    expect(text).toContain("Assessment time: 12.30 s");
    expect(text).toContain(
      "Colour also depends on vacancy, visibility and follow-up checks.",
    );
    expect(text).toContain(
      "repeated matching captures confirm green; confirmed occupancy stays yellow.",
    );
  });
  it("keeps unavailable measurement distinct from zero percent difference", () => {
    const evidence = objectEvidence();
    evidence.reference.changed_fraction = null;
    const text = renderToStaticMarkup(
      createElement(ObjectEvidence, {
        table: objectBundle().tables[0],
        assessment: {
          t: 7,
          reason: "Not observable.",
          object_evidence: evidence,
        },
      }),
    ).replace(/<[^>]*>/g, "");
    expect(text).toContain("Last assessed reference difference: unavailable");
    expect(text).not.toContain("difference: 0.00%");
  });
  it("describes a small framing correction only when one was actually applied", () => {
    const evidence = objectEvidence();
    const render = () =>
      renderToStaticMarkup(
        createElement(ObjectEvidence, {
          table: objectBundle().tables[0],
          assessment: {
            t: 12,
            reason: "Compared with reference.",
            object_evidence: evidence,
          },
        }),
      );
    expect(render()).not.toContain("Small framing offset corrected");
    evidence.reference.alignment = {
      method: "translation_ecc_v1",
      applied: false,
      dx: 0,
      dy: 0,
      correlation: null,
    };
    expect(render()).not.toContain("Small framing offset corrected");
    evidence.reference.alignment = {
      method: "translation_ecc_v1",
      applied: true,
      dx: -8,
      dy: 1.25,
      correlation: 0.96,
    };
    expect(render()).toContain("Small framing offset corrected.");
    expect(render()).toContain("Cleaning threshold: above 10.00%");
    expect(render()).not.toContain("translation_ecc_v1");
  });
});

describe("baseline identity and configuration contract", () => {
  it("keeps the chosen cleaning policy separate from existing approved measurement identities", () => {
    expect(SURFACE_DECISION_POLICY).toEqual({
      version: "reference_difference_v3",
      cleaning_changed_fraction: 0.1,
      weak_extra_policy: "reference_difference",
      background_guess_min_box_fraction: 0.8,
      stability: {
        early_dirty_vacancy_s: 1,
        unobstructed_s: 1,
        recheck_s: 2,
        dirty_retry_s: 2,
        uncertain_retry_s: 1,
        clean_confirmation_s: 5,
        clean_confirmation_captures: 3,
        object_confirmation_s: 1,
        alignment_mode_confirmation_s: 1,
      },
    });
    expect(REFERENCE_CLEANING_THRESHOLD).toBe(0.1);
    expect(OBJECT_SURFACE_CONFIG.max_changed_fraction).toBe(0.01);
    expect(OBJECT_SURFACE_CONFIG_SHA256).toBe(
      "3f71969710f1a0598b736500d5201d902a1e6dffab3fe1f4ba35a2cd872caa60",
    );
    expect(
      compareObjectSurface(objectBundle().tables[0], objectEvidence()).outcome,
    ).toBe("cleared_reset");
  });
  it("the checked-in configuration hash matches canonical JavaScript and Python JSON", () => {
    expect(
      createHash("sha256")
        .update(canonicalObjectJson(OBJECT_SURFACE_CONFIG))
        .digest("hex"),
    ).toBe(OBJECT_SURFACE_CONFIG_SHA256);
    const python = execFileSync(
      "python3",
      [
        "-c",
        "import hashlib,json,pathlib; c=json.loads(pathlib.Path('shared/object-surface-config.json').read_text()); print(hashlib.sha256(json.dumps(c,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest())",
      ],
      { encoding: "utf8" },
    ).trim();
    expect(python).toBe(OBJECT_SURFACE_CONFIG_SHA256);
    expect(
      execFileSync(
        "python3",
        [
          "-c",
          "from processor.models import MODEL_HASHES; print(MODEL_HASHES['tiny'])",
        ],
        { encoding: "utf8" },
      ).trim(),
    ).toBe(OBJECT_SURFACE_DETECTOR_SHA256);
  });
  it("baseline hashing matches Python with Unicode reviewer names and reordered objects", () => {
    const baseline = objectBundle().tables[0].object_baseline!;
    const content = {
      ...baseline,
      reviewed_by: "José 李 🍽",
      expected: [
        { class_id: 39, count: 2 },
        { class_id: 41, count: 1 },
      ],
    };
    const { baseline_sha256: _hash, ...canonical } = content;
    const python = execFileSync(
      "python3",
      [
        "-c",
        "import sys,json; from processor.object_baseline import canonical_sha256; print(canonical_sha256(json.load(sys.stdin)))",
      ],
      { input: JSON.stringify(canonical), encoding: "utf8" },
    ).trim();
    expect(
      createHash("sha256").update(canonicalObjectJson(canonical)).digest("hex"),
    ).toBe(python);
  });
  it("accepts a complete baseline and verifies its content independently of display-only edits", async () => {
    const bundle = objectBundle();
    validateBundle(bundle);
    await verifyBundleGeometry(bundle);
    bundle.tables[0].label = "Renamed";
    bundle.tables[0].map.x = 0.1;
    await expect(verifyBundleGeometry(bundle)).resolves.toBeUndefined();
    bundle.tables[0].object_baseline!.expected[0].count = 2;
    await expect(verifyBundleGeometry(bundle)).rejects.toThrow(
      /baseline content hash mismatch/,
    );
  });
  it("allows migration with no baseline but rejects invalid classes and duplicate counts", () => {
    const bundle = objectBundle();
    delete bundle.tables[0].object_baseline;
    expect(() => validateBundle(bundle)).not.toThrow();
    for (const expected of [
      [{ class_id: 0, count: 1 }],
      [{ class_id: 56, count: 1 }],
      [{ class_id: 80, count: 1 }],
      [{ class_id: 41, count: -1 }],
      [{ class_id: 41, count: 101 }],
      [{ class_id: 41, count: 1.5 }],
      [
        { class_id: 41, count: 1 },
        { class_id: 41, count: 1 },
      ],
    ]) {
      expect(
        isObjectBaseline({
          ...objectBundle().tables[0].object_baseline,
          expected,
        }),
      ).toBe(false);
    }
  });
});
