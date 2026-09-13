import { describe, expect, it, vi } from "vitest";
import { FRAME_BATCH_LIMITS, type FrameBatchRequest, type FrameCapabilities, type FrameReplyIdentity } from "../../shared/frame-batch-contracts";
import { FrameApi, PayloadSizeError } from "../../web/src/stateless/transport";

const caps: FrameCapabilities = { available: true, model_sha256: "b".repeat(64), config_sha256: "c".repeat(64),
  build_id: "test-build", limits: FRAME_BATCH_LIMITS };
function payload(): FrameBatchRequest {
  return { request_id: "request", run_id: "run", revision: 1,
    model_sha256: caps.model_sha256!, config_sha256: caps.config_sha256, build_id: caps.build_id,
    source: { sha256: "a".repeat(64), width: 640, height: 360, fps: 24, duration_s: 10 }, tables: [], frames: [] };
}
const reply: FrameReplyIdentity = { request_id: "request", run_id: "run", revision: 1,
  model_sha256: caps.model_sha256!, config_sha256: caps.config_sha256, build_id: caps.build_id };

describe("stateless transport payload size failures", () => {
  it("rejects oversized request JSON without sending or retrying and permits a subsequent request", async () => {
    const fetcher = vi.fn(async () => Response.json(reply)), sleep = vi.fn(async () => {});
    const api = new FrameApi("https://example.test", fetcher, sleep); api.capabilities = caps;
    const oversized = { ...payload(), checkpoint: { content: "x".repeat(FRAME_BATCH_LIMITS.body_bytes) } };
    await expect(api.request("assess-batch", oversized)).rejects.toBeInstanceOf(PayloadSizeError);
    expect(fetcher).not.toHaveBeenCalled(); expect(sleep).not.toHaveBeenCalled();
    await expect(api.request("assess-batch", payload())).resolves.toEqual(reply);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    JSON.stringify({ error: { code: "payload_too_large", message: "Request is too large." } }),
    "Request Entity Too Large",
  ])("treats HTTP 413 as a size failure without retries, regardless of its body", async (body) => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(body, { status: 413 })).mockImplementation(async () => Response.json(reply));
    const sleep = vi.fn(async () => {});
    const api = new FrameApi("https://example.test", fetcher, sleep); api.capabilities = caps;
    await expect(api.request("assess-batch", payload())).rejects.toBeInstanceOf(PayloadSizeError);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
    await expect(api.request("assess-batch", payload())).resolves.toEqual(reply);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("cancels an oversized streamed response, releases its reader and permits a new request (cancel rejects: %s)", async (cancelRejects) => {
    const cancel = vi.fn(() => cancelRejects ? Promise.reject(new Error("Cancellation transport failure")) : undefined);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(FRAME_BATCH_LIMITS.body_bytes));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(stream)).mockImplementation(async () => Response.json(reply));
    const sleep = vi.fn(async () => {});
    const api = new FrameApi("https://example.test", fetcher, sleep); api.capabilities = caps;
    await expect(api.request("assess-batch", payload())).rejects.toBeInstanceOf(PayloadSizeError);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1); expect(stream.locked).toBe(false);
    await expect(api.request("assess-batch", payload())).resolves.toEqual(reply);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
