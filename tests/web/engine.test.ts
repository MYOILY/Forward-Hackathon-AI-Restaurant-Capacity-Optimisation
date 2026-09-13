import { objectBundle } from "./object-fixtures";
import { assessment } from "./replay-fixtures";
import { describe, expect, it } from "vitest";
import { replay, createReplaySession } from "../../web/src/engine";
import { validateBundle } from "../../web/src/validation";
import { clean, fixture, legacyFixture } from "./fixtures";

describe("submitted recording contract", () => {
  it("uses one recording format with explicit media provenance", () => {
    const bundle = fixture();
    expect(bundle).not.toHaveProperty("schema_version");
    expect(bundle.policy).toBe("automatic");
    expect(bundle.video.source_kind).toBe("processed_file");
    expect(() => validateBundle(bundle)).not.toThrow();
  });
  it.each([1, 2, 3, undefined])("rejects numbered recording metadata: %s", (schema_version) => {
    const bundle = { ...fixture(), schema_version };
    expect(() => validateBundle(bundle)).toThrow(/unsupported analysis format/);
  });
  it.each([undefined, "automatic_v2", "legacy_v1"])("rejects unsupported recording policies: %s", (policy) => {
    expect(() => validateBundle({ ...fixture(), policy })).toThrow(/unsupported analysis format/);
  });
  it.each([undefined, "unknown"])("requires a current video source kind: %s", (source_kind) => {
    const bundle = fixture();
    expect(() => validateBundle({ ...bundle, video: { ...bundle.video, source_kind } }))
      .toThrow(/video source kind/);
  });
  it("rejects a legacy recording without mutating the input or an existing session", () => {
    const current = createReplaySession(fixture());
    const before = current.advanceTo(6);
    const legacy = legacyFixture();
    const input = JSON.stringify(legacy);
    expect(() => replay(legacy, 6)).toThrow(/Reprocess the original video/);
    expect(JSON.stringify(legacy)).toBe(input);
    expect(current.advanceTo(6)).toEqual(before);
  });
  it("detection-only input starts unverified and allows explicit staff confirmation after vacancy", () => {
    const bundle = fixture();
    bundle.tables[0].reference = null;
    expect(replay(bundle, 4.9).tables.T1.can_confirm_cleaned).toBe(false);
    expect(replay(bundle, 6).tables.T1.status).toBe("unknown");
    expect(replay(bundle, 6, [clean(6)]).tables.T1.status).toBe("ready");
  });
  it.each([
    "../video.mp4",
    "/video.mp4",
    "https://example.com/video.mp4",
    "a/%2e%2e/video.mp4",
  ])("rejects unsafe video path %s", (file) => {
    const bundle = fixture();
    bundle.video.file = file;
    expect(() => validateBundle(bundle)).toThrow();
  });
  it("rejects duplicate sample times, bad hashes, unknown IDs and failed-but-empty samples", () => {
    let bundle = fixture();
    bundle.observations[1].t = 0;
    expect(() => validateBundle(bundle)).toThrow();
    bundle = fixture();
    bundle.video.sha256 = "incorrect";
    expect(() => validateBundle(bundle)).toThrow();
    bundle = fixture();
    bundle.observations[0].tables = { T99: "present" };
    expect(() => validateBundle(bundle)).toThrow();
    bundle = fixture();
    bundle.observations[0].valid = false;
    expect(() => validateBundle(bundle)).toThrow();
  });
});

describe("current surface evidence import boundary", () => {
  function analyzed() {
    const bundle = objectBundle(10);
    const table = bundle.tables[0];
    const request = {
      id: "independently-authored-capture",
      table_id: table.id,
      t: 5,
      frame_index: 50,
      generation: 0,
      video_sha256: bundle.video.sha256,
      geometry_sha256: table.geometry_sha256!,
      reference_sha256: table.reference!.sha256!,
      surface_method: table.surface_method,
      baseline_sha256: table.object_baseline!.baseline_sha256,
      config_sha256: table.object_baseline!.config_sha256,
    };
    bundle.assessment_requests = [request];
    bundle.assessments = [assessment(request)];
    return bundle;
  }
  it("accepts current raw evidence without using cached snapshots as authority", () => {
    const bundle = analyzed();
    expect(() => validateBundle(bundle)).not.toThrow();
    expect(createReplaySession(bundle).advanceTo(5).tables.T1.status).toBe(
      "unknown",
    );
  });
  it.each([
    "retired-result",
    "retired-request",
    "missing-raw-evidence",
    "unapproved-baseline",
    "changed-baseline",
    "detached-result",
    "invented-capture",
  ])("rejects %s before replay", (mode) => {
    const bundle = analyzed();
    if (mode === "retired-result")
      Object.assign(bundle.assessments![0], {
        surface_method: undefined,
        object_evidence: undefined,
        baseline_sha256: undefined,
        config_sha256: undefined,
        prompt_version: "retired-scalar",
      });
    if (mode === "retired-request")
      Object.assign(bundle.assessment_requests![0], {
        surface_method: undefined,
        baseline_sha256: undefined,
        config_sha256: undefined,
      });
    if (mode === "missing-raw-evidence")
      delete bundle.assessments![0].object_evidence;
    if (mode === "unapproved-baseline")
      bundle.tables[0].object_baseline!.approved = false;
    if (mode === "changed-baseline")
      bundle.assessment_requests![0].baseline_sha256 = "f".repeat(64);
    if (mode === "detached-result")
      bundle.assessments![0].request_id = "missing";
    if (mode === "invented-capture")
      bundle.assessment_requests![0].frame_index = 999;
    expect(() => createReplaySession(bundle)).toThrow();
  });
});
