/// <reference lib="webworker" />
import { Input, MP4, BlobSource, CanvasSink, type WrappedCanvas } from "mediabunny";
import { sha256 } from "@noble/hashes/sha2.js";
import { FrameSampler, hashBytes, hex, processingSize, toBase64 } from "./images";
import { MAX_BATCH_FRAMES, MAX_DURATION_S, MAX_FILE_BYTES, SAMPLE_HZ } from "./config";
import type { EncodedFrame, MediaCommand, VideoMetadata } from "./media-types";

let input: Input | undefined, sink: CanvasSink | undefined;
let iterator: AsyncGenerator<WrappedCanvas, void, unknown> | undefined;
let sampleIndex = 0, sampler = new FrameSampler(SAMPLE_HZ), done = false;
async function encode(frame: WrappedCanvas, index: number): Promise<EncodedFrame> {
  const canvas = frame.canvas as OffscreenCanvas;
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { sample_index: index, t: frame.timestamp, width: canvas.width, height: canvas.height,
    sha256: hashBytes(bytes), image_base64: toBase64(bytes) };
}
async function reset() {
  await iterator?.return();
  iterator = sink!.canvases(0);
  sampleIndex = 0; sampler = new FrameSampler(SAMPLE_HZ); done = false;
}
async function dispatch(command: MediaCommand): Promise<unknown> {
  if (command.op === "open") {
    if (!globalThis.VideoDecoder || !globalThis.OffscreenCanvas) throw new Error("Use desktop Chrome or Edge with WebCodecs support.");
    if (command.file.size > MAX_FILE_BYTES) throw new Error("Choose a video no larger than 1 GB.");
    if (!/\.mp4$/i.test(command.file.name)) throw new Error("Choose an MP4 video encoded with H.264.");
    input?.dispose();
    input = new Input({ source: new BlobSource(command.file), formats: [MP4] });
    const track = await input.getPrimaryVideoTrack();
    if (!track || await track.getCodec() !== "avc" || !await track.canDecode()) throw new Error("This video must use H.264 in an MP4 container. Use desktop Chrome or Edge.");
    const duration = await input.computeDuration();
    if (!(duration > 0) || duration > MAX_DURATION_S) throw new Error("Choose a video with a media timeline no longer than ten minutes.");
    const width = await track.getDisplayWidth(), height = await track.getDisplayHeight();
    if (!(width > 0 && height > 0) || width * height > 33_177_600) throw new Error("This video exceeds the supported decoding dimensions.");
    const [processing_width, processing_height] = processingSize(width, height);
    const metrics = await track.computeFrameRateMetrics({ targetPacketCount: Infinity });
    const digest = sha256.create();
    for (let offset = 0; offset < command.file.size; offset += 4 * 1024 * 1024) {
      digest.update(new Uint8Array(await command.file.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer()));
      postMessage({ id: command.id, progress: offset / command.file.size });
    }
    sink = new CanvasSink(track, { width: processing_width, height: processing_height, fit: "fill", poolSize: 1 });
    await reset();
    return { sha256: hex(digest.digest()), width, height, processing_width, processing_height,
      fps: metrics.averageFrameRate, duration_s: duration, first_timestamp: await track.getFirstTimestamp(),
      rotation: await track.getRotation() } satisfies VideoMetadata;
  }
  if (!sink) throw new Error("Open a video first.");
  if (command.op === "reset") { await reset(); return null; }
  if (command.op === "frame") {
    const frame = await sink.getCanvas(command.t);
    if (!frame || frame.timestamp < 0) throw new Error("No video frame is available at this timestamp.");
    return encode(frame, 0);
  }
  const frames: EncodedFrame[] = [];
  const count = Math.min(MAX_BATCH_FRAMES, Math.max(1, command.count));
  while (!done && frames.length < count) {
    const value = await iterator!.next();
    if (value.done) { done = true; break; }
    if (sampler.select(value.value.timestamp)) frames.push(await encode(value.value, sampleIndex++));
  }
  return { frames, done };
}
// Serialize commands so random-access setup cannot race sequential analysis decoding.
let chain = Promise.resolve();
self.onmessage = (event: MessageEvent<MediaCommand>) => {
  const command = event.data;
  chain = chain.then(async () => {
    try { postMessage({ id: command.id, result: await dispatch(command) }); }
    catch (error) { postMessage({ id: command.id, error: error instanceof Error ? error.message : String(error) }); }
  });
};
