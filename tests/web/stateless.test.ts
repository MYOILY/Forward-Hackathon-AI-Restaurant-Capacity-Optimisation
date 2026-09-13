import { describe, expect, it, vi } from "vitest";
import { FRAME_BATCH_LIMITS, type FrameBatchRequest, type FrameCapabilities, type FrameOperation, type FrameReplyIdentity } from "../../shared/frame-batch-contracts";
import { FrameApi, PausableRequestError, PayloadSizeError, StaleReplyError, jsonBytes } from "../../web/src/stateless/transport";
import { FrameSampler, hashBytes, processingSize } from "../../web/src/stateless/images";
import { BrowserRecording } from "../../web/src/stateless/recording";
import { fitFrames, RecordingProcessor, type ProcessingProgress } from "../../web/src/stateless/processing";
import type { EncodedFrame, FrameDecoder } from "../../web/src/stateless/media-types";
import { approveObjects, objectAssessment, objectBundle } from "./object-fixtures";
import { verifyBundleGeometry } from "../../web/src/validation";
import { replay } from "../../web/src/engine";
const caps: FrameCapabilities = { available: true, model_sha256: "b".repeat(64), config_sha256: "c".repeat(64), build_id: "test-build", limits: FRAME_BATCH_LIMITS };
function payload(): FrameBatchRequest {
  return { request_id: "request", run_id: "run", revision: 1,
    model_sha256: caps.model_sha256!, config_sha256: caps.config_sha256, build_id: caps.build_id,
    source: { sha256: "a".repeat(64), width: 640, height: 360, fps: 24, duration_s: 10 }, tables: [], frames: [] };
}
const identity = (request: FrameBatchRequest): FrameReplyIdentity => ({ request_id: request.request_id,
  run_id: request.run_id, revision: request.revision, model_sha256: caps.model_sha256!, config_sha256: caps.config_sha256, build_id: caps.build_id });
describe("stateless frame transport", () => {
  it("uses the current unnumbered endpoints and rejects a numbered server contract", async () => {
    const fetcher = vi.fn(async (url, init) => String(url).endsWith("/capabilities")
      ? Response.json(caps)
      : Response.json(identity(JSON.parse(init!.body as string)))) as unknown as typeof fetch;
    const api = new FrameApi("https://example.test", fetcher);
    await api.connect();
    await api.request("observe-batch", payload());
    expect(fetcher).toHaveBeenNthCalledWith(1, "https://example.test/frames/capabilities", expect.anything());
    expect(fetcher).toHaveBeenNthCalledWith(2, "https://example.test/frames/observe-batch", expect.anything());
    expect(payload()).not.toHaveProperty("protocol_version");
    const old = new FrameApi("https://example.test", vi.fn(async () => Response.json({ ...caps, protocol_version: 1 })));
    await expect(old.connect()).rejects.toThrow(/protocol/);
  });
  it("retries throttling with the identical request identity and body", async () => {
    const bodies: string[] = [], delays: number[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      bodies.push(init!.body as string);
      return bodies.length < 3 ? new Response("busy", { status: 429 }) : Response.json(identity(JSON.parse(init!.body as string)));
    }) as unknown as typeof fetch;
    const api = new FrameApi("https://example.test", fetcher, async (delay) => { delays.push(delay); }, () => 0.5);
    api.capabilities = caps;
    await api.request("observe-batch", payload());
    expect(new Set(bodies).size).toBe(1); expect(bodies).toHaveLength(3); expect(delays).toEqual([500, 1000]);
  });
  it("pauses after bounded transient retries and rejects stale replies", async () => {
    const api = new FrameApi("https://example.test", vi.fn(async () => new Response("busy", { status: 503 })), async () => {});
    api.capabilities = caps;
    await expect(api.request("observe-batch", payload())).rejects.toBeInstanceOf(PausableRequestError);
    const stale = new FrameApi("https://example.test", vi.fn(async () => Response.json({ ...identity(payload()), revision: 99 })));
    stale.capabilities = caps;
    await expect(stale.request("observe-batch", payload())).rejects.toBeInstanceOf(StaleReplyError);
  });
  it("prevents concurrent requests and times out stalled network requests", async () => {
    const fetcher: typeof fetch = (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    const api = new FrameApi("https://example.test", fetcher, async () => {}, () => 0, 2);
    api.capabilities = caps;
    const running = api.request("observe-batch", payload());
    await expect(api.request("observe-batch", payload())).rejects.toThrow(/already running/);
    await expect(running).rejects.toBeInstanceOf(PausableRequestError);
  });
  it("counts UTF-8 JSON, base64 and checkpoints in the entire request limit", () => {
    const frame = { sample_index: 0, t: 0, width: 640, height: 360, sha256: "a".repeat(64), image_base64: "a".repeat(600_000) };
    const base = { ...payload(), checkpoint: { content: "x".repeat(900_000) } };
    expect(fitFrames(base, Array.from({ length: 8 }, (_, sample_index) => ({ ...frame, sample_index })))).toHaveLength(5);
    expect(() => fitFrames({ ...base, checkpoint: { content: "x".repeat(FRAME_BATCH_LIMITS.body_bytes) } }, [frame])).toThrow(/exceeds/);
  });
});

describe("presentation-time sampling", () => {
  it("preserves VFR and nonzero timestamps without synthesizing timestamps from fps", () => {
    const sampler = new FrameSampler(FRAME_BATCH_LIMITS.sample_hz), decoded = [-.02, 2.041, 2.073, 2.112, 2.145, 2.219, 2.238, 2.318];
    expect(decoded.filter((t) => sampler.select(t))).toEqual([2.041, 2.145, 2.318]);
  });
  it.each([24, 30, 60])("samples 640 original frames from 80 seconds of %i fps video", (fps) => {
    const sampler = new FrameSampler(FRAME_BATCH_LIMITS.sample_hz);
    const timestamps = Array.from({ length: 80 * fps }, (_, index) => index / fps);
    const selected = timestamps.filter((t) => sampler.select(t));
    expect(FRAME_BATCH_LIMITS.sample_hz).toBe(8);
    expect(selected).toHaveLength(640);
    expect(selected.every((t, index) => t >= index / 8 && t < index / 8 + 1 / fps + 1e-7)).toBe(true);
    expect(selected.every((t) => timestamps.includes(t))).toBe(true);
  });
  it("does not duplicate frames when a variable-rate source falls below the target cadence", () => {
    const sampler = new FrameSampler(FRAME_BATCH_LIMITS.sample_hz);
    const timestamps = [1.01, 1.06, 1.17, 1.5, 1.8, 2.04, 2.06, 2.13];
    expect(timestamps.filter((t) => sampler.select(t))).toEqual([1.01, 1.17, 1.5, 1.8, 2.04, 2.13]);
  });
  it("fits landscape and rotated portrait frames within processing dimensions", () => {
    expect(processingSize(1920, 1080)).toEqual([1280, 720]);
    expect(processingSize(1080, 1920)).toEqual([405, 720]);
    expect(processingSize(640, 360)).toEqual([640, 360]);
  });
});

function harness(change?: (op: string, request: FrameBatchRequest) => Promise<void>, tableCount = 1) {
  const fixture = objectBundle(8, undefined, tableCount), calls: { op: string; request: FrameBatchRequest }[] = [];
  fixture.observations = Array.from({ length: 8 * FRAME_BATCH_LIMITS.sample_hz + 1 }, (_, index) => ({
    ...structuredClone(fixture.observations[0]), t: index / FRAME_BATCH_LIMITS.sample_hz, frame_index: index,
  }));
  const frames: EncodedFrame[] = fixture.observations.map((obs) => ({ sample_index: obs.frame_index, t: obs.t, width: 640, height: 360,
    sha256: hashBytes(new TextEncoder().encode(String(obs.t))), image_base64: btoa(String(obs.t)) }));
  let cursor = 0, decodedCalls = 0;
  const decoder: FrameDecoder = { metadata: { sha256: fixture.video.sha256, width: 640, height: 360, processing_width: 640,
    processing_height: 360, fps: 24, duration_s: 8, first_timestamp: 0, rotation: 0 },
    frame: async (t) => frames.find((frame) => frame.t >= t)!,
    next: async (count = 8) => { decodedCalls++; const selected = frames.slice(cursor, cursor + count); cursor += selected.length;
      return { frames: selected, done: cursor >= frames.length }; }, reset: async () => { cursor = 0; }, close: () => {} };
  const api = new FrameApi("https://example.test"); api.capabilities = caps;
  api.request = vi.fn(async (op: FrameOperation, request: FrameBatchRequest) => {
    calls.push({ op, request: structuredClone(request) }); await change?.(op, request);
    if (op === "observe-batch") return { ...identity(request), checkpoint: { last: request.frames.at(-1)!.sample_index },
      observations: request.frames.map(({ image_base64: _raw, ...capture }) => ({ ...fixture.observations[capture.sample_index], capture })) };
    return { ...identity(request), assessments: request.requests!.map((request) => ({ ...objectAssessment(request), capture: request.capture,
      crop_sha256: hashBytes(new Uint8Array([1, 2, 3])), crop_base64: btoa("\x01\x02\x03"), width: 12, height: 12 })) };
  }) as typeof api.request;
  const record = new BrowserRecording(new File(["video"], "sample.mp4", { type: "video/mp4" }), decoder, api);
  record.source.tables = fixture.tables; record.source.calibration_confirmed = true;
  for (const table of fixture.tables) record.references[table.id] = { image_base64: "AQID", sha256: table.reference!.sha256!, width: 12, height: 12 };
  return { record, calls, decodedCalls: () => decodedCalls };
}
describe("browser-owned processing lifecycle", () => {
  it("checks three tables with one shared frame and preserves single-table processing results", async () => {
    const grouped = harness(undefined, 3);
    const single = harness(async (op, request) => {
      if (op === "assess-batch" && request.requests!.length > 1) throw new PayloadSizeError("Response too large");
    }, 3);
    try {
      const groupedBundle = await new RecordingProcessor(grouped.record, () => {}).run();
      const singleBundle = await new RecordingProcessor(single.record, () => {}).run();
      const batches = grouped.calls.filter(({ op }) => op === "assess-batch");
      expect(batches.length).toBeGreaterThan(0);
      expect(batches.every(({ request }) => request.frames.length === 1 && request.requests!.length === 3)).toBe(true);
      expect(groupedBundle.assessments).toEqual(singleBundle.assessments);
      expect(groupedBundle.assessment_requests).toEqual(singleBundle.assessment_requests);
      expect(groupedBundle.replay_events).toEqual(singleBundle.replay_events);
      expect(replay(groupedBundle, 8)).toEqual(replay(singleBundle, 8));
      const singles = single.calls.filter(({ op, request }) => op === "assess-batch" && request.requests!.length === 1);
      expect(singles).toHaveLength(batches.length * 3);
      expect(batches.reduce((sum, { request }) => sum + jsonBytes(request), 0))
        .toBeLessThan(singles.reduce((sum, { request }) => sum + jsonBytes(request), 0));
    } finally { grouped.record.dispose(); single.record.dispose(); }
  });
  it("splits ten same-frame checks into eight and two before advancing progress or decoding", async () => {
    let lastProgressTime = -1, callsAtTimestamp = 0, timestamp = -1, decodeCount = 0;
    const h = harness(async (op, request) => {
      if (op !== "assess-batch") return;
      const t = request.frames[0].t;
      if (timestamp !== t) { timestamp = t; callsAtTimestamp = 0; decodeCount = h.decodedCalls(); }
      callsAtTimestamp++;
      expect(h.decodedCalls()).toBe(decodeCount);
      expect(lastProgressTime).toBeLessThan(t);
      expect(request.requests).toHaveLength(callsAtTimestamp === 1 ? 8 : 2);
      expect(Object.keys(request.references!)).toEqual(request.requests!.map((r) => r.table_id));
      expect(request.requests!.every((r) => r.t === t && r.capture?.sha256 === request.frames[0].sha256)).toBe(true);
    }, 10);
    try {
      const bundle = await new RecordingProcessor(h.record, (value) => { if (value.snapshot) lastProgressTime = value.snapshot.t; }).run();
      expect(bundle.assessments!.length).toBeGreaterThanOrEqual(10);
      expect(bundle.replay_events!.filter((event) => event.kind === "assessment_rejected")).toEqual([]);
    } finally { h.record.dispose(); }
  });
  it("keeps the exact grouped request and frame through a manual retry", async () => {
    let failed = false, resume!: () => void, failedDecodeCount = 0;
    const h = harness(async (op) => {
      if (op === "assess-batch" && !failed) { failed = true; failedDecodeCount = h.decodedCalls(); throw new PausableRequestError("busy"); }
      if (op === "assess-batch" && h.calls.filter((call) => call.op === op).length === 2)
        expect(h.decodedCalls()).toBe(failedDecodeCount);
    }, 3);
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const processor = new RecordingProcessor(h.record, (value) => { if (value.error) resume(); });
    try {
      const running = processor.run(); await paused;
      const before = h.decodedCalls(), assets = new Map(h.record.assets);
      expect(h.calls.filter(({ op }) => op === "assess-batch")).toHaveLength(1);
      processor.resume(); const bundle = await running;
      const [first, second] = h.calls.filter(({ op }) => op === "assess-batch");
      expect(first.request.requests).toHaveLength(3); expect(second.request).toEqual(first.request);
      expect(before).toBe(failedDecodeCount); expect(assets.size).toBe(1);
      expect(bundle.replay_events!.filter((event) => event.kind === "assessment_rejected")).toEqual([]);
    } finally { h.record.dispose(); }
  });
  it("does not apply any grouped evidence when a later response item is malformed", async () => {
    const h = harness(undefined, 3), original = h.record.api.request.bind(h.record.api);
    let failedDecodeCount = 0;
    h.record.api.request = vi.fn(async (op, request, signal) => {
      const result = await original(op, request, signal);
      if (op === "assess-batch") {
        (result as any).assessments[1].crop_sha256 = "0".repeat(64);
        failedDecodeCount = h.decodedCalls();
      }
      return result;
    }) as typeof h.record.api.request;
    const store = vi.spyOn(h.record, "storeImage");
    try {
      await expect(new RecordingProcessor(h.record, () => {}).run()).rejects.toThrow(/hash mismatch/);
      expect(store).not.toHaveBeenCalled(); expect(h.record.bundle).toBeUndefined();
      expect(h.decodedCalls()).toBe(failedDecodeCount);
    } finally { h.record.dispose(); }
  });
  it("learns smaller groups after a size rejection without changing table request identities", async () => {
    const h = harness(async (op, request) => {
      if (op === "assess-batch" && request.requests!.length > 2) throw new PayloadSizeError("Response too large");
    }, 4);
    try {
      const bundle = await new RecordingProcessor(h.record, () => {}).run();
      const calls = h.calls.filter(({ op }) => op === "assess-batch"), parent = calls[0].request;
      expect(parent.requests).toHaveLength(4);
      expect(calls.slice(1).every(({ request }) => request.requests!.length <= 2)).toBe(true);
      expect(calls.slice(1, 3).flatMap(({ request }) => request.requests!)).toEqual(parent.requests);
      expect(new Set(calls.map(({ request }) => request.request_id)).size).toBe(calls.length);
      expect(bundle.assessments!.length).toBe(bundle.assessment_requests!.length);
      expect(bundle.replay_events!.filter((event) => event.kind === "assessment_rejected")).toEqual([]);
    } finally { h.record.dispose(); }
  });
  it("stops on an oversized single-table response without splitting or advancing", async () => {
    let failedDecodeCount = 0;
    const h = harness(async (op) => {
      if (op === "assess-batch") { failedDecodeCount = h.decodedCalls(); throw new PayloadSizeError("Response too large"); }
    });
    try {
      await expect(new RecordingProcessor(h.record, () => {}).run()).rejects.toBeInstanceOf(PayloadSizeError);
      expect(h.calls.filter(({ op }) => op === "assess-batch")).toHaveLength(1);
      expect(h.decodedCalls()).toBe(failedDecodeCount); expect(h.record.bundle).toBeUndefined();
    } finally { h.record.dispose(); }
  });
  it("deletes saved tables and their evidence without changing the remaining analysis setup", async () => {
    const { record } = harness();
    const image = { image_base64: "AQID", sha256: hashBytes(new Uint8Array([1, 2, 3])), width: 12, height: 12 };
    record.source.tables = objectBundle(8, undefined, 2).tables;
    for (const table of record.source.tables) {
      table.reference!.sha256 = image.sha256; approveObjects(table);
      table.reference_approved = true; table.setup_review = { tabletop: true, occupancy: true, map: true };
      record.references[table.id] = image; record.storeImage(table.reference!.file, image);
    }
    const [removed, kept] = structuredClone(record.source.tables);
    const removedUrl = record.asset(removed.reference!.file), keptUrl = record.asset(kept.reference!.file);
    const historyPath = `references/${removed.id}-previous.png`, historyUrl = record.storeImage(historyPath, image);
    const setupUrl = record.storeImage("setup/clean_reference.png", image), videoUrl = record.asset("video.mp4");
    record.bundle = objectBundle(8, undefined, 2);
    record.api.request = vi.fn(async (_op: FrameOperation, request: FrameBatchRequest) => ({ ...identity(request), reference: image,
      baseline: removed.object_baseline, detections: [], geometry_sha256: removed.geometry_sha256 })) as typeof record.api.request;
    await record.adapter.api(`/sources/${record.id}/baseline-proposal`, { method: "POST", body: JSON.stringify({ revision: 0,
      table_id: removed.id, tabletop_polygon: removed.tabletop_polygon, occupancy_regions: removed.occupancy_regions,
      reference_source: "video_frame", reference_t: 0 }) });
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    try {
      expect(record.adapter.canDeleteSavedTables).toBe(true);
      await record.adapter.api(`/sources/${record.id}/calibration`, { method: "PUT", body: JSON.stringify({ revision: 0,
        tables: [kept], confirmed: true, floor_plan_mode: "schematic", setup_reference: record.source.setup_reference }) });
      expect(record.source.tables.map((table) => table.id)).toEqual([kept.id]);
      expect(record.source.tables[0]).toMatchObject({ label: kept.label, map: kept.map,
        tabletop_polygon: kept.tabletop_polygon, occupancy_regions: kept.occupancy_regions, setup_review: kept.setup_review });
      expect(record.source.revision).toBe(1); expect(record.bundle).toBeUndefined();
      expect(record.references).toEqual({ [kept.id]: image });
      expect(() => record.asset(removed.reference!.file)).toThrow(/no longer available/);
      expect(() => record.asset(historyPath)).toThrow(/no longer available/);
      expect(revoke.mock.calls).toEqual([[removedUrl], [historyUrl]]);
      expect(record.asset(kept.reference!.file)).toBe(keptUrl);
      expect(record.asset("setup/clean_reference.png")).toBe(setupUrl); expect(record.asset("video.mp4")).toBe(videoUrl);
      expect(record.createBundle("after-deletion").tables.map((table) => table.id)).toEqual([kept.id]);
      expect(record.request([]).tables.map((table) => table.id)).toEqual([kept.id]);
      // Reusing the old ID must not silently reuse its removed proposal or reference.
      await expect(record.adapter.api(`/sources/${record.id}/calibration`, { method: "PUT", body: JSON.stringify({ revision: 1,
        tables: [removed, kept], confirmed: false, floor_plan_mode: "schematic", setup_reference: record.source.setup_reference }) })).rejects.toThrow(/reference or geometry changed/);
      expect(record.source.tables.map((table) => table.id)).toEqual([kept.id]);
    } finally { revoke.mockRestore(); record.dispose(); }
  });
  it("keeps a shared reference asset when a remaining table still uses it", async () => {
    const { record } = harness();
    record.source.tables = objectBundle(8, undefined, 2).tables;
    const [removed, kept] = record.source.tables;
    kept.reference!.file = removed.reference!.file;
    const image = { image_base64: "AQID", sha256: hashBytes(new Uint8Array([1, 2, 3])), width: 12, height: 12 };
    const sharedUrl = record.storeImage(kept.reference!.file, image);
    record.references[kept.id] = image;
    await record.adapter.api(`/sources/${record.id}/calibration`, { method: "PUT", body: JSON.stringify({ revision: 0,
      tables: [kept], confirmed: false, floor_plan_mode: "schematic", setup_reference: record.source.setup_reference }) });
    expect(record.asset(kept.reference!.file)).toBe(sharedUrl);
    expect(record.references[removed.id]).toBeUndefined(); expect(record.references[kept.id]).toBe(image);
    record.dispose();
  });
  it("allows deleting the last saved table as a draft, but rejects an empty completed setup without discarding it", async () => {
    const { record } = harness();
    const source = structuredClone(record.source), bundle = record.bundle = objectBundle(8);
    const reference = record.references.T1;
    const image = { ...reference, sha256: hashBytes(new Uint8Array([1, 2, 3])) };
    const referenceUrl = record.storeImage(source.tables[0].reference!.file, image);
    const body = { revision: 0, tables: [], floor_plan_mode: "schematic", setup_reference: source.setup_reference };
    await expect(record.adapter.api(`/sources/${record.id}/calibration`, { method: "PUT", body: JSON.stringify({ ...body, confirmed: true }) })).rejects.toThrow(/Add a table/);
    expect(record.source).toEqual(source); expect(record.bundle).toBe(bundle); expect(record.references.T1).toBe(reference);
    expect(record.asset(source.tables[0].reference!.file)).toBe(referenceUrl);
    await expect(record.adapter.api(`/sources/${record.id}/calibration`, { method: "PUT", body: JSON.stringify({ ...body, tables: [null] }) })).rejects.toThrow();
    expect(record.source).toEqual(source); expect(record.references.T1).toBe(reference);
    await record.adapter.api(`/sources/${record.id}/calibration`, { method: "PUT", body: JSON.stringify({ ...body, confirmed: false }) });
    const reopened = await record.adapter.api<typeof record.source>(`/sources/${record.id}`);
    expect(reopened.tables).toEqual([]); expect(reopened.calibration_confirmed).toBe(false); expect(reopened.revision).toBe(1);
    expect(record.references).toEqual({}); expect(record.bundle).toBeUndefined();
    expect(() => record.asset(source.tables[0].reference!.file)).toThrow(/no longer available/);
    record.dispose();
  });
  it("keeps all prior evidence when a save removing a table fails after reference validation", async () => {
    const { record } = harness();
    record.source.tables = objectBundle(8, undefined, 2).tables;
    const table = structuredClone(record.source.tables[1]);
    const reference = { image_base64: "BAUG", sha256: hashBytes(new Uint8Array([4, 5, 6])), width: 12, height: 12 };
    table.reference!.sha256 = reference.sha256; approveObjects(table); table.reference_approved = true;
    record.api.request = vi.fn(async (_op: FrameOperation, request: FrameBatchRequest) => ({ ...identity(request), reference,
      baseline: table.object_baseline, detections: [], geometry_sha256: table.geometry_sha256 })) as typeof record.api.request;
    await record.adapter.api(`/sources/${record.id}/baseline-proposal`, { method: "POST", body: JSON.stringify({ revision: 0,
      table_id: table.id, tabletop_polygon: table.tabletop_polygon, occupancy_regions: table.occupancy_regions,
      reference_source: "video_frame", reference_t: 0 }) });
    const source = structuredClone(record.source), references = { ...record.references }, assets = new Map(record.assets);
    const bundle = record.bundle = objectBundle(8, undefined, 2);
    await expect(record.adapter.api(`/sources/${record.id}/calibration`, { method: "PUT", body: JSON.stringify({ revision: 0,
      tables: [table], confirmed: true, floor_plan_mode: "schematic", setup_reference: source.setup_reference }) })).rejects.toThrow(/mark and review/);
    expect(record.source).toEqual(source); expect(record.references).toEqual(references); expect(record.assets).toEqual(assets);
    expect(record.bundle).toBe(bundle);
    record.dispose();
  });
  it("invalidates stored approvals on reference replacement even after cancelling and reopening setup", async () => {
    const { record } = harness(), oldTable = structuredClone(record.source.tables[0]);
    const oldBytes = new Uint8Array([3, 2, 1]), oldHash = hashBytes(oldBytes);
    const oldPath = `setup/clean_reference-${oldHash}.png`;
    const oldUrl = record.storeImage(oldPath, { sha256: oldHash, image_base64: "AwIB", width: 640, height: 360 });
    record.source.setup_assets = { clean_reference: { file: oldPath, sha256: oldHash, width: 640, height: 360 } };
    record.source.setup_reference = { reference_source: "uploaded_image", reference_t: null, reference_image_sha256: oldHash, alignment_confirmed: true };
    record.source.tables[0].setup_review = { tabletop: true, occupancy: true, map: true };
    record.bundle = objectBundle(8);
    vi.stubGlobal("createImageBitmap", async () => ({ width: 640, height: 360, close() {} }));
    vi.stubGlobal("OffscreenCanvas", class {
      getContext() { return { drawImage() {} }; }
      async convertToBlob() { return new Blob([new Uint8Array([4, 5, 6])], { type: "image/png" }); }
    });
    try {
      const body = new FormData(); body.append("file", new File(["png"], "reference.png", { type: "image/png" })); body.append("revision", "0");
      await record.adapter.api(`/sources/${record.id}/setup-assets/clean_reference`, { method: "PUT", body });
      // Cancelling the mounted editor and reopening reads the saved source state.
      const reopened = await record.adapter.api<typeof record.source>(`/sources/${record.id}`);
      expect(reopened.tables[0].object_baseline).toBeUndefined(); expect(reopened.tables[0].reference).toBeNull();
      expect(reopened.tables[0].reference_approved).toBe(false); expect(reopened.setup_reference?.alignment_confirmed).toBe(false);
      expect(reopened.calibration_confirmed).toBe(false); expect(record.references).toEqual({}); expect(record.bundle).toBeUndefined();
      expect(reopened.setup_assets!.clean_reference!.file).not.toBe(oldPath); expect(record.asset(oldPath)).toBe(oldUrl);
      await expect(record.adapter.api(`/sources/${record.id}/calibration`, { method: "PUT", body: JSON.stringify({ revision: 1,
        tables: [{ ...oldTable, reference_approved: true }], confirmed: true, floor_plan_mode: "schematic", setup_reference: reopened.setup_reference }) })).rejects.toThrow(/reference or geometry changed/);
      const floor = new FormData(); floor.append("file", new File(["png"], "floor.png", { type: "image/png" })); floor.append("revision", "1");
      await record.adapter.api(`/sources/${record.id}/setup-assets/floor_plan`, { method: "PUT", body: floor });
      expect(record.source.tables[0].setup_review?.map).toBe(false);
    } finally { vi.unstubAllGlobals(); record.dispose(); }
  });
  it("keeps reviewed setup and exact PNG references in memory and hashes explicit inventory approval", async () => {
    const { record } = harness(), table = structuredClone(record.source.tables[0]);
    const referenceBytes = new Uint8Array([1, 2, 3]), referenceHash = hashBytes(referenceBytes);
    const baseline = { ...table.object_baseline!, approved: false, reference_sha256: referenceHash };
    record.api.request = vi.fn(async (_op: FrameOperation, request: FrameBatchRequest) => ({ ...identity(request),
      reference: { image_base64: "AQID", sha256: referenceHash, width: 12, height: 12 },
      baseline, detections: [], geometry_sha256: table.geometry_sha256! })) as typeof record.api.request;
    const proposal = await record.adapter.api<{ baseline: typeof baseline; frame_base64: string }>(`/sources/${record.id}/baseline-proposal`, {
      method: "POST", body: JSON.stringify({ revision: 0, table_id: table.id, tabletop_polygon: table.tabletop_polygon,
        occupancy_regions: table.occupancy_regions, reference_source: "video_frame", reference_t: 0 }) });
    expect(proposal.frame_base64).toBe("data:image/png;base64,AQID");
    Object.assign(table, { setup_review: { tabletop: true, occupancy: true, map: true }, reference_source: "video_frame", reference_t: 0,
      reference_approved: true, reference: null, object_baseline: { ...proposal.baseline, approved: true, expected: [{ class_id: 41, count: 2 }] } });
    await record.adapter.api(`/sources/${record.id}/calibration`, { method: "PUT", body: JSON.stringify({ revision: 0, tables: [table],
      confirmed: true, setup_mode: "guided_v1", floor_plan_mode: "schematic", setup_reference: { reference_source: "video_frame", reference_t: 0, alignment_confirmed: false } }) });
    expect(record.source.calibration_confirmed).toBe(true); expect(record.source.revision).toBe(1);
    expect(record.references.T1.image_base64).toBe("AQID");
    expect(record.source.tables[0].object_baseline!.expected).toEqual([{ class_id: 41, count: 2 }]);
    await verifyBundleGeometry(record.createBundle("new-run"));
    await expect(record.adapter.api(`/sources/${record.id}/calibration`, { method: "PUT", body: JSON.stringify({ revision: 0, tables: [] }) })).rejects.toThrow(/Setup changed/);
    record.dispose();
  });
  it("applies assessments at their timestamp before the next observation and returns current browser evidence", async () => {
    const { record, calls } = harness(), progress: ProcessingProgress[] = [];
    const bundle = await new RecordingProcessor(record, (value) => progress.push(value)).run();
    expect(bundle).not.toHaveProperty("schema_version");
    expect(bundle.policy).toBe("automatic"); expect(bundle.video.source_kind).toBe("browser_file");
    expect(bundle.video.fps).toBe(24);
    expect(bundle.analysis.sample_hz).toBe(8);
    expect(bundle.observations).toHaveLength(65);
    expect(bundle.assessments!.length).toBeGreaterThan(0);
    expect(bundle.assessments!.every((assessment) => assessment.capture?.sample_index === assessment.frame_index)).toBe(true);
    expect(bundle.replay_events!.filter((event) => event.kind === "assessment_rejected")).toEqual([]);
    expect(calls.every(({ request }) => request.frames.length <= 8)).toBe(true);
    const assessed = calls.find(({ op }) => op === "assess-batch")!;
    expect(assessed.request.frames[0].t).toBe(assessed.request.requests![0].t);
    expect(progress.at(-1)!.progress).toBe(1); record.dispose();
  });
  it("retains the same batch after manual retry without advancing or decoding more frames", async () => {
    let failed = false;
    const { record, calls, decodedCalls } = harness(async (op) => { if (op === "observe-batch" && !failed) { failed = true; throw new PausableRequestError("busy"); } });
    let processor: RecordingProcessor;
    const paused = new Promise<void>((resolve) => {
      processor = new RecordingProcessor(record, (value) => { if (value.error) resolve(); });
    });
    const running = processor!.run(); await paused;
    expect(decodedCalls()).toBe(1); expect(record.bundle).toBeUndefined();
    processor!.resume(); const bundle = await running;
    expect(calls[0].request).toEqual(calls[1].request); expect(bundle.observations).toHaveLength(65); record.dispose();
  });
  it("cancels a paused recording without losing setup or applying further results", async () => {
    const { record, decodedCalls } = harness();
    const processor = new RecordingProcessor(record, () => {}); processor.pause();
    const running = processor.run(); await Promise.resolve(); processor.cancel();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(decodedCalls()).toBe(0); expect(record.source.tables).toHaveLength(1); expect(record.bundle).toBeUndefined(); record.dispose();
  });
  it("rejects results after a calibration revision changed", async () => {
    const { record } = harness(async () => { record.source.revision++; });
    await expect(new RecordingProcessor(record, () => {}).run()).rejects.toThrow(/Calibration changed/);
    expect(record.bundle).toBeUndefined(); record.dispose();
  });
  it("isolates two recordings sharing the same browser execution environment", async () => {
    const a = harness(), b = harness();
    const [first, second] = await Promise.all([new RecordingProcessor(a.record, () => {}).run(), new RecordingProcessor(b.record, () => {}).run()]);
    expect(first.analysis.run_id).not.toBe(second.analysis.run_id);
    expect(a.record.id).not.toBe(b.record.id); expect(first).not.toBe(second);
    a.record.source.tables[0].label = "Changed"; expect(b.record.source.tables[0].label).not.toBe("Changed");
    a.record.dispose(); b.record.dispose();
  });
});
