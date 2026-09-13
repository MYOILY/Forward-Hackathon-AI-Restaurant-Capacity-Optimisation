import type { EncodedFrame, FrameDecoder, MediaCommand, VideoMetadata } from "./media-types";
import { abortError } from "./transport";
async function verifyPlaybackMetadata(file: File, metadata: VideoMetadata, signal?: AbortSignal): Promise<void> {
  const video = document.createElement("video"), url = URL.createObjectURL(file);
  video.preload = "metadata"; video.muted = true;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Video metadata could not be read. Choose another MP4 file.")), 15_000);
      const aborted = () => finish(abortError());
      const finish = (error?: Error) => {
        clearTimeout(timer); signal?.removeEventListener("abort", aborted);
        video.onloadedmetadata = null; video.onerror = null;
        if (error) reject(error); else resolve();
      };
      signal?.addEventListener("abort", aborted, { once: true });
      video.onloadedmetadata = () => {
        // Chrome initially reports the MP4 track span for some positive-start files,
        // then updates duration while decoding. Its currentTime remains the original
        // presentation timestamp; do not rebase frames to that transient duration.
        const durationMatches = Math.abs(video.duration - metadata.duration_s) <= 0.25 ||
          Math.abs(video.duration - (metadata.duration_s - Math.max(0, metadata.first_timestamp))) <= 0.25;
        if (video.videoWidth !== metadata.width || video.videoHeight !== metadata.height ||
          !Number.isFinite(video.duration) || !durationMatches)
          finish(new Error("This MP4 has a playback timeline or rotation the browser cannot align reliably. Re-export it as H.264 MP4."));
        else finish();
      };
      video.onerror = () => finish(new Error("This MP4 cannot be played by this browser."));
      if (signal?.aborted) return aborted();
      video.src = url;
    });
  } finally { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
}
export async function openVideo(file: File, onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<FrameDecoder> {
  if (!/Chrome\//.test(navigator.userAgent) || /Android|iPhone|iPad|Mobile/.test(navigator.userAgent))
    throw new Error("Browser processing currently supports desktop Chrome and Edge.");
  const worker = new Worker(new URL("./media.worker.ts", import.meta.url), { type: "module" });
  let seq = 0, closed = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const close = () => {
    closed = true; worker.terminate();
    for (const item of pending.values()) item.reject(abortError());
    pending.clear(); signal?.removeEventListener("abort", close);
  };
  signal?.addEventListener("abort", close, { once: true });
  worker.onmessage = ({ data }) => {
    if (data.progress !== undefined) { onProgress?.(data.progress); return; }
    const item = pending.get(data.id); if (!item) return;
    pending.delete(data.id);
    if (data.error) item.reject(new Error(data.error)); else item.resolve(data.result);
  };
  worker.onerror = (event) => { for (const p of pending.values()) p.reject(new Error(event.message)); close(); };
  const send = <T>(command: Omit<MediaCommand, "id"> | { op: "frame"; t: number } | { op: "next"; count: number } | { op: "open"; file: File }): Promise<T> =>
    new Promise((resolve, reject) => {
      if (closed || signal?.aborted) return reject(abortError());
      const id = ++seq; pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ ...command, id });
    });
  try {
    const metadata = await send<VideoMetadata>({ op: "open", file });
    await verifyPlaybackMetadata(file, metadata, signal);
    return { metadata, frame: (t) => send<EncodedFrame>({ op: "frame", t }),
      next: (count = 8) => send({ op: "next", count }), reset: () => send({ op: "reset" }), close };
  } catch (error) { close(); throw error; }
}
