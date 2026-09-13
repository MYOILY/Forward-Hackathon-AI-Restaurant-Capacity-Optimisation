import { describe, expect, it } from "vitest";
import type { AssessmentRequest } from "../../shared/contracts";
import { FRAME_BATCH_LIMITS, type AssessBatchReply, type EncodedAssessment, type EncodedImage, type FrameBatchRequest } from "../../shared/frame-batch-contracts";
import { assessmentBatch, fitAssessments, orderedAssessments, type AssessmentBatch } from "../../web/src/stateless/assessment-batches";
import { hashBytes } from "../../web/src/stateless/images";
import { PayloadSizeError } from "../../web/src/stateless/transport";
import { objectAssessment, objectBundle } from "./object-fixtures";

function fixture(count = 3) {
  const bundle = objectBundle(8, undefined, count);
  const image: EncodedImage = { image_base64: "AQID", sha256: hashBytes(new Uint8Array([1, 2, 3])), width: 12, height: 12 };
  const capture = { sample_index: 50, t: 5, width: 640, height: 360, sha256: image.sha256 };
  const requests: AssessmentRequest[] = bundle.tables.map((table) => ({
    id: `surface:${table.id}:0:50`, table_id: table.id, t: 5, frame_index: 50, generation: 0,
    video_sha256: bundle.video.sha256, geometry_sha256: table.geometry_sha256!, reference_sha256: table.reference!.sha256!,
    surface_method: table.surface_method, baseline_sha256: table.object_baseline!.baseline_sha256,
    config_sha256: table.object_baseline!.config_sha256, capture: { ...capture },
  }));
  const references = Object.fromEntries(bundle.tables.map((table) => [table.id, { ...image, sha256: table.reference!.sha256! }]));
  const base: FrameBatchRequest = {
    request_id: "http-request", run_id: "run", revision: 1,
    model_sha256: "b".repeat(64), config_sha256: "c".repeat(64), build_id: "fixture",
    source: { sha256: bundle.video.sha256, width: 640, height: 360, fps: 24, duration_s: 8 },
    tables: bundle.tables, frames: [{ ...capture, image_base64: image.image_base64 }],
  };
  return { base, requests, references, image };
}

function response(batch: AssessmentBatch): AssessBatchReply {
  return {
    request_id: batch.request_id, run_id: batch.run_id, revision: batch.revision,
    model_sha256: batch.model_sha256, config_sha256: batch.config_sha256, build_id: batch.build_id,
    assessments: batch.requests.map((request) => ({
      ...objectAssessment(request), capture: { ...request.capture! },
      ...(request.timing_profile ? { timing_profile: request.timing_profile } : {}),
      crop_file: "", crop_sha256: hashBytes(new Uint8Array([1, 2, 3])), crop_base64: "AQID", width: 12, height: 12,
    })),
  };
}

describe("assessment request grouping", () => {
  it("sends one shared frame with at most eight checks and only their references", () => {
    const { base, requests, references, image } = fixture(10);
    references.unused = image;
    const batch = fitAssessments(base, requests, references);
    expect(batch.requests).toEqual(requests.slice(0, 8));
    expect(Object.keys(batch.references)).toEqual(requests.slice(0, 8).map((request) => request.table_id));
    expect(batch.frames).toEqual(base.frames);
    expect(batch.frames).toHaveLength(1);
    expect(fitAssessments(base, requests, references, 3).requests).toEqual(requests.slice(0, 3));
    expect(fitAssessments(base, requests, references, 99).requests).toHaveLength(8);
    expect(assessmentBatch(base, requests.slice(8), references).references).toEqual({ T9: references.T9, T10: references.T10 });
  });

  it("accepts exactly 4 MiB and splits when UTF-8 metadata takes the next group over the limit", () => {
    const { base, requests, references } = fixture(2);
    base.tables[0].label = "โต๊ะ ☕";
    base.frames[0].image_base64 = "AAAA".repeat(250_000);
    for (const reference of Object.values(references)) reference.image_base64 = "AAAA".repeat(250_000);
    const initial = Buffer.byteLength(JSON.stringify(assessmentBatch(base, requests, references)), "utf8");
    const remaining = FRAME_BATCH_LIMITS.body_bytes - initial;
    base.frames[0].image_base64 += "AAAA".repeat(Math.floor(remaining / 4));
    base.build_id += "x".repeat(remaining % 4);
    const exact = fitAssessments(base, requests, references);
    expect(exact.requests).toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(FRAME_BATCH_LIMITS.body_bytes);
    expect(JSON.stringify(exact).length).toBeLessThan(FRAME_BATCH_LIMITS.body_bytes);

    base.build_id += "☕";
    const oversized = assessmentBatch(base, requests, references);
    expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBe(FRAME_BATCH_LIMITS.body_bytes + 3);
    expect(JSON.stringify(oversized).length).toBeLessThan(FRAME_BATCH_LIMITS.body_bytes);
    const fitted = fitAssessments(base, requests, references);
    expect(fitted.requests).toEqual(requests.slice(0, 1));
    expect(fitted.references).toEqual({ T1: references.T1 });
  });

  it("rejects a missing approved reference and a single check that cannot fit", () => {
    const { base, requests, references } = fixture(1);
    expect(() => fitAssessments(base, requests, {})).toThrow(/reference is missing/);
    references.T1.image_base64 = "AAAA".repeat(FRAME_BATCH_LIMITS.body_bytes / 4);
    expect(() => fitAssessments(base, requests, references)).toThrow(PayloadSizeError);
  });
});

describe("assessment response validation", () => {
  it("restores request order while preserving exact evidence and source identity", () => {
    const { base, requests, references } = fixture();
    requests[1].timing_profile = "demo_fast_3x";
    const batch = assessmentBatch(base, requests, references), reply = response(batch);
    reply.assessments.reverse();
    const before = structuredClone(reply), ordered = orderedAssessments(batch, reply);
    expect(ordered.map((assessment) => assessment.request_id)).toEqual(requests.map((request) => request.id));
    expect(ordered[1].timing_profile).toBe("demo_fast_3x");
    for (const assessment of ordered) {
      expect(assessment.crop_file).toMatch(/^evidence\/.+\.png$/);
      expect(assessment.crop_base64).toBe("AQID");
      expect(assessment.crop_sha256).toBe(hashBytes(new Uint8Array([1, 2, 3])));
      expect(assessment.capture).toEqual(requests[0].capture);
    }
    expect(reply).toEqual(before);
  });

  it.each(["request_id", "id"] as const)("rejects duplicated response %s values", (field) => {
    const { base, requests, references } = fixture();
    const batch = assessmentBatch(base, requests, references), reply = response(batch);
    reply.assessments[1][field] = reply.assessments[0][field];
    expect(() => orderedAssessments(batch, reply)).toThrow(/Duplicate/);
  });

  it.each(["missing", "extra", "unrequested"])("rejects %s assessments", (kind) => {
    const { base, requests, references } = fixture();
    const batch = assessmentBatch(base, requests, references), reply = response(batch);
    if (kind === "missing") reply.assessments.pop();
    else if (kind === "extra") reply.assessments.push({ ...reply.assessments[0], id: "extra", request_id: "extra" });
    else reply.assessments[1].request_id = "unrequested";
    expect(() => orderedAssessments(batch, reply)).toThrow(/Incomplete|does not match/);
  });

  it.each(["table_id", "t", "frame_index", "generation", "video_sha256", "geometry_sha256", "reference_sha256",
    "surface_method", "baseline_sha256", "config_sha256", "timing_profile"] as const)("rejects a later assessment with mismatched %s", (field) => {
    const { base, requests, references } = fixture();
    const batch = assessmentBatch(base, requests, references), reply = response(batch);
    const result = reply.assessments[1] as unknown as Record<string, unknown>;
    result[field] = typeof result[field] === "number" ? (result[field] as number) + 1 : "different";
    expect(() => orderedAssessments(batch, reply)).toThrow(/does not match/);
  });

  it.each(["sample_index", "t", "sha256", "width", "height"] as const)("rejects a changed capture %s", (field) => {
    const { base, requests, references } = fixture();
    const batch = assessmentBatch(base, requests, references), reply = response(batch);
    const capture = reply.assessments[1].capture! as unknown as Record<string, unknown>;
    capture[field] = typeof capture[field] === "number" ? (capture[field] as number) + 1 : "f".repeat(64);
    expect(() => orderedAssessments(batch, reply)).toThrow(/does not match/);
  });

  it("rejects the entire group when a later crop hash is invalid without changing input evidence", () => {
    const { base, requests, references } = fixture();
    const batch = assessmentBatch(base, requests, references), reply = response(batch);
    reply.assessments[1].crop_sha256 = "f".repeat(64);
    const before = structuredClone(reply);
    let accepted: EncodedAssessment[] = [];
    expect(() => { accepted = orderedAssessments(batch, reply); }).toThrow(/hash mismatch/);
    expect(accepted).toEqual([]);
    expect(reply).toEqual(before);
  });

  it.each([0, 513, 12.5, NaN])("rejects unsupported evidence dimensions (%s)", (width) => {
    const { base, requests, references } = fixture();
    const batch = assessmentBatch(base, requests, references), reply = response(batch);
    reply.assessments[1].width = width;
    expect(() => orderedAssessments(batch, reply)).toThrow(/dimensions or size/);
  });
});
