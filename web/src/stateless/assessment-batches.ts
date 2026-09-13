import { FRAME_BATCH_LIMITS, type AssessBatchReply, type EncodedAssessment, type EncodedImage, type FrameBatchRequest } from "../../../shared/frame-batch-contracts";
import type { AssessmentRequest } from "../../../shared/contracts";
import { sameCapture, validateAssessment, validateFrameCapture } from "../validation";
import { OBJECT_SURFACE_CONFIG } from "../object-surface";
import { MAX_BODY_BYTES } from "./config";
import { verifyImage } from "./images";
import { jsonBytes, PayloadSizeError } from "./transport";

export type AssessmentBatch = FrameBatchRequest & {
  requests: AssessmentRequest[];
  references: Record<string, EncodedImage>;
};

/** Keep only the references needed by this group; the shared frame is sent once. */
export function assessmentBatch(base: FrameBatchRequest, requests: AssessmentRequest[], references: Record<string, EncodedImage>): AssessmentBatch {
  const selected: Record<string, EncodedImage> = {};
  for (const request of requests) {
    const reference = references[request.table_id];
    if (!reference) throw new Error("Approved reference is missing from this session.");
    selected[request.table_id] = reference;
  }
  return { ...base, requests, references: selected };
}

/** Measure the complete JSON, including setup, shared frame and references. */
export function fitAssessments(base: FrameBatchRequest, requests: AssessmentRequest[], references: Record<string, EncodedImage>, limit = FRAME_BATCH_LIMITS.frames): AssessmentBatch {
  let count = Math.min(requests.length, limit, FRAME_BATCH_LIMITS.frames);
  while (count > 0) {
    const batch = assessmentBatch(base, requests.slice(0, count), references);
    if (jsonBytes(batch) <= MAX_BODY_BYTES) return batch;
    count--;
  }
  throw new PayloadSizeError("A table check with its frame and reference exceeds the 4 MiB processing limit.");
}

/** Validate the entire group before storing or submitting any of its evidence. */
export function orderedAssessments(batch: AssessmentBatch, response: AssessBatchReply): EncodedAssessment[] {
  if (!Array.isArray(response.assessments) || response.assessments.length !== batch.requests.length)
    throw new Error("Incomplete surface assessment batch returned by the processor.");
  const byRequest = new Map<string, EncodedAssessment>(), ids = new Set<string>();
  for (const result of response.assessments) {
    if (!result || byRequest.has(result.request_id) || ids.has(result.id))
      throw new Error("Duplicate surface assessment returned by the processor.");
    byRequest.set(result.request_id, result); ids.add(result.id);
  }
  return batch.requests.map((request) => {
    const result = byRequest.get(request.id);
    if (!result || (["table_id", "t", "frame_index", "generation", "video_sha256", "geometry_sha256",
      "reference_sha256", "surface_method", "baseline_sha256", "config_sha256", "timing_profile"] as const)
      .some((key) => result[key] !== request[key]) || !sameCapture(result.capture, request.capture))
      throw new Error("Surface assessment does not match its requested capture.");
    const assessment = { ...result, crop_file: `evidence/${request.id.replace(/[^a-zA-Z0-9_-]/g, "_")}-${result.crop_sha256}.png` };
    validateAssessment(assessment);
    validateFrameCapture(assessment.capture);
    if (!Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) ||
      result.width < 2 || result.height < 2 || result.width > OBJECT_SURFACE_CONFIG.crop_longest_edge || result.height > OBJECT_SURFACE_CONFIG.crop_longest_edge ||
      typeof result.crop_base64 !== "string" || result.crop_base64.length > 4 * Math.ceil(FRAME_BATCH_LIMITS.image_bytes / 3))
      throw new Error("Invalid surface evidence image dimensions or size.");
    verifyImage({ image_base64: result.crop_base64, sha256: result.crop_sha256 });
    return assessment;
  });
}
