import { FRAME_BATCH_LIMITS as limits } from "../../../shared/frame-batch-contracts";
const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env;
export const isStatelessMode = env?.VITE_PROCESSING_MODE === "stateless";
export const statelessApiUrl = env?.VITE_STATELESS_API_URL ?? "";
export const MAX_BODY_BYTES = limits.body_bytes;
export const MAX_BATCH_FRAMES = limits.frames;
export const MAX_FILE_BYTES = limits.upload_bytes;
export const MAX_DURATION_S = limits.duration_s;
export const SAMPLE_HZ = limits.sample_hz;
