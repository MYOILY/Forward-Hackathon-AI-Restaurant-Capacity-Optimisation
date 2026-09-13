import type { FrameBatchRequest, FrameCapabilities, FrameOperation, FrameReplyIdentity } from "../../../shared/frame-batch-contracts";
import { FRAME_BATCH_LIMITS } from "../../../shared/frame-batch-contracts";
import { MAX_BODY_BYTES } from "./config";

export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export class PausableRequestError extends Error {}
export class StaleReplyError extends Error {}
export class PayloadSizeError extends Error {}
export function abortError(): DOMException { return new DOMException("Recording cancelled.", "AbortError"); }
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const aborted = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(); }, ms);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}
export class FrameApi {
  private inFlight = false;
  capabilities?: FrameCapabilities;
  constructor(readonly baseUrl: string, private fetcher: typeof fetch = (...args) => globalThis.fetch(...args),
    private sleep = wait, private random = Math.random, private timeoutMs = 75_000) {
    if (!baseUrl) throw new Error("The frame processing endpoint is not configured.");
  }
  private async exchange(path: string, init: RequestInit, signal?: AbortSignal): Promise<{ response: Response; text: string }> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) throw abortError();
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}${path}`, { ...init, signal: controller.signal, cache: "no-store" });
      const reader = response.body?.getReader();
      if (!reader) return { response, text: "" };
      const decoder = new TextDecoder(); let text = "", bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_BODY_BYTES) {
            await reader.cancel().catch(() => {});
            throw new PayloadSizeError("Processing response exceeds the 4 MiB processing limit.");
          }
          text += decoder.decode(next.value, { stream: true });
        }
        text += decoder.decode();
        return { response, text };
      } finally { reader.releaseLock(); }
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  }
  async connect(signal?: AbortSignal): Promise<FrameCapabilities> {
    const { response, text } = await this.exchange("/frames/capabilities", {}, signal);
    if (!response.ok) throw new Error(`Frame processing service unavailable (${response.status}).`);
    const data = JSON.parse(text) as FrameCapabilities;
    if ("protocol_version" in data || !data.available || !/^[a-f0-9]{64}$/.test(data.model_sha256 ?? "") ||
      !data.limits || Object.entries(FRAME_BATCH_LIMITS).some(([key, value]) => data.limits[key as keyof typeof data.limits] !== value))
      throw new Error(data.reason ?? "The processing model or protocol is unavailable.");
    this.capabilities = data;
    return data;
  }
  async request<T extends FrameReplyIdentity>(operation: FrameOperation, request: FrameBatchRequest,
    signal?: AbortSignal): Promise<T> {
    if (this.inFlight) throw new Error("Another request is already running for this recording.");
    const body = JSON.stringify(request);
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) throw new PayloadSizeError("Frame batch exceeds the 4 MiB processing limit.");
    if (!this.capabilities) throw new Error("Connect to the processing service before analysis.");
    this.inFlight = true;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        if (signal?.aborted) throw abortError();
        let response: Response, text: string;
        try {
          ({ response, text } = await this.exchange(`/frames/${operation}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body,
          }, signal));
        } catch (error) {
          if (signal?.aborted) throw abortError();
          if (error instanceof PayloadSizeError) throw error;
          if (attempt === 4) throw new PausableRequestError("The processing connection was interrupted. Retry to continue from this frame.");
          await this.sleep(Math.min(8000, 500 * 2 ** attempt) * (0.5 + this.random()), signal);
          continue;
        }
        if (response.status === 429 || response.status >= 500) {
          if (attempt === 4) throw new PausableRequestError("The processor is busy. Retry to continue from this frame.");
          await this.sleep(Math.min(8000, 500 * 2 ** attempt) * (0.5 + this.random()), signal);
          continue;
        }
        if (response.status === 413) throw new PayloadSizeError("Frame processing payload exceeds the 4 MiB processing limit.");
        const data = JSON.parse(text);
        if (!response.ok) throw new Error((typeof data.error === "string" ? data.error : data.error?.message) ?? data.detail ?? data.message ?? `Processing failed (${response.status}).`);
        if ("protocol_version" in data || data.request_id !== request.request_id || data.run_id !== request.run_id ||
          data.revision !== request.revision || data.model_sha256 !== this.capabilities.model_sha256 ||
          data.config_sha256 !== this.capabilities.config_sha256 || data.build_id !== this.capabilities.build_id)
          throw new StaleReplyError("Processing identity changed. Reopen setup to start a fresh analysis.");
        return data as T;
      }
      throw new PausableRequestError("Retry to continue analysis.");
    } finally { this.inFlight = false; }
  }
}
