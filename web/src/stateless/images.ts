import { sha256 } from "@noble/hashes/sha2.js";
import { FRAME_BATCH_LIMITS } from "../../../shared/frame-batch-contracts";
export const hex = (bytes: Uint8Array) => [...bytes].map((n) => n.toString(16).padStart(2, "0")).join("");
export const hashBytes = (bytes: Uint8Array) => hex(sha256(bytes));
export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const raw = atob(value), bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
export function verifyImage(image: { image_base64: string; sha256: string }): Uint8Array<ArrayBuffer> {
  const bytes = fromBase64(image.image_base64);
  if (hashBytes(bytes) !== image.sha256) throw new Error("Evidence image hash mismatch.");
  return bytes;
}
export function processingSize(width: number, height: number): [number, number] {
  const scale = Math.min(1, 1280 / width, 720 / height);
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}
/** Select actual decoded timestamps on a fixed grid without inventing frame timing. */
export class FrameSampler {
  private nextT = 0;
  constructor(private readonly hz = FRAME_BATCH_LIMITS.sample_hz) {}
  select(t: number): boolean {
    if (t < 0 || t + 1e-7 < this.nextT) return false;
    this.nextT = (Math.floor((t + 1e-7) * this.hz) + 1) / this.hz;
    return true;
  }
}
