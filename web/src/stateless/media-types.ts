export interface EncodedFrame {
  sample_index: number;
  t: number;
  width: number;
  height: number;
  sha256: string;
  image_base64: string;
}
export interface VideoMetadata {
  sha256: string;
  width: number;
  height: number;
  processing_width: number;
  processing_height: number;
  fps: number;
  duration_s: number;
  first_timestamp: number;
  rotation: number;
}
export type MediaCommand =
  | { id: number; op: "open"; file: File }
  | { id: number; op: "frame"; t: number }
  | { id: number; op: "next"; count: number }
  | { id: number; op: "reset" };
export interface FrameDecoder {
  metadata: VideoMetadata;
  frame(t: number): Promise<EncodedFrame>;
  next(count?: number): Promise<{ frames: EncodedFrame[]; done: boolean }>;
  reset(): Promise<void>;
  close(): void;
}
