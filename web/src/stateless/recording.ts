import type { Bundle, ImageAsset, ObjectBaseline } from "../../../shared/contracts";
import type { CalibrationTable, SourceInfo } from "../../../shared/live-contracts";
import type { EncodedImage, FrameBatchRequest, FrameCapabilities, ProposeReferenceReply, ProposeTablesReply } from "../../../shared/frame-batch-contracts";
import { FRAME_BATCH_LIMITS } from "../../../shared/frame-batch-contracts";
import { canonicalObjectJson, validateBundle } from "../validation";
import { setupRequirements } from "../setup-guidance";
import { validLabel } from "../api";
import { openVideo } from "./decoder";
import { FrameApi } from "./transport";
import { hashBytes, toBase64, verifyImage } from "./images";
import type { EncodedFrame, FrameDecoder } from "./media-types";

export interface StatelessRecordingResult {
  bundle: Bundle;
  asset(path: string | null | undefined): string | undefined;
  urls: string[];
  name: string;
  source: SourceInfo;
}
type Proposal = { reply: ProposeReferenceReply; frame: EncodedFrame; geometry: string };
const recordings = new Map<string, BrowserRecording>();
export const getStatelessRecording = (id: string) => recordings.get(id);
export const listStatelessRecordings = () => [...recordings.values()];
export function disposeStatelessRecording(id: string) { recordings.get(id)?.dispose(); recordings.delete(id); }
export function renameStatelessTable(sourceId: string, tableId: string, value: string): SourceInfo {
  const recording = recordings.get(sourceId);
  if (!recording) throw new Error("This recording is no longer open in this tab.");
  const table = recording.source.tables.find((item) => item.id === tableId);
  if (!table) throw new Error("Table does not exist.");
  const label = validLabel(value, recording.source.tables.filter((t) => t.id !== tableId).map((t) => t.label));
  table.label = label;
  const bundled = recording.bundle?.tables.find((t) => t.id === tableId);
  if (bundled) bundled.label = label;
  recording.source = { ...recording.source, tables: [...recording.source.tables] };
  return recording.source;
}
const hashJson = (value: unknown) => hashBytes(new TextEncoder().encode(canonicalObjectJson(value)));
const geometryKey = (table: CalibrationTable) => JSON.stringify({ occupancy_regions: table.occupancy_regions, tabletop_polygon: table.tabletop_polygon });

export class BrowserRecording {
  source: SourceInfo;
  bundle?: Bundle;
  readonly assets = new Map<string, string>();
  readonly references: Record<string, EncodedImage> = {};
  private proposals = new Map<string, Proposal>();
  private cleanImage?: EncodedImage;
  readonly id = `browser-${crypto.randomUUID()}`;
  private setupRunId = crypto.randomUUID();
  constructor(readonly file: File, readonly decoder: FrameDecoder, readonly api: FrameApi) {
    const m = decoder.metadata;
    const media = URL.createObjectURL(file);
    this.assets.set("video.mp4", media);
    this.source = { id: this.id, kind: "video", label: file.name, status: "needs_setup", progress: 0,
      phase: "Review the clean reference and table setup", revision: 0, calibration_confirmed: false,
      width: m.width, height: m.height, fps: m.fps, duration_s: m.duration_s,
      tables: [], media_url: media, setup_mode: "guided_v1",
      setup_reference: { reference_source: "video_frame", reference_t: Math.max(0, m.first_timestamp), alignment_confirmed: false } };
  }
  static async open(file: File, url: string, onProgress?: (progress: number) => void, signal?: AbortSignal) {
    const api = new FrameApi(url);
    await api.connect(signal);
    const decoder = await openVideo(file, onProgress, signal);
    const recording = new BrowserRecording(file, decoder, api);
    try {
      const frame = await decoder.frame(Math.max(0, decoder.metadata.first_timestamp));
      recording.source.frame_url = recording.storeImage("setup-frame.jpg", frame, "image/jpeg");
      recording.source.setup_reference!.reference_t = frame.t;
      recordings.set(recording.id, recording);
      return recording;
    } catch (error) { recording.dispose(); throw error; }
  }
  request(frames: EncodedFrame[], tables = this.source.tables, runId = this.setupRunId): FrameBatchRequest {
    const { sha256, width, height, fps, duration_s } = this.decoder.metadata;
    const capabilities = this.api.capabilities!;
    return { request_id: crypto.randomUUID(), run_id: runId, revision: this.source.revision,
      model_sha256: capabilities.model_sha256!, config_sha256: capabilities.config_sha256, build_id: capabilities.build_id,
      source: { sha256, width, height, fps, duration_s }, tables, frames };
  }
  asset = (path: string): string => {
    const url = this.assets.get(path);
    if (!url) throw new Error(`The recording asset ${path} is no longer available in this tab.`);
    return url;
  };
  storeImage(path: string, image: EncodedImage, mime = "image/png"): string {
    const bytes = verifyImage(image);
    const old = this.assets.get(path); if (old) return old;
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    this.assets.set(path, url); return url;
  }
  async proposeTables(signal?: AbortSignal) {
    const frame = await this.referenceFrame(this.source.setup_reference!);
    const result = await this.api.request<ProposeTablesReply>("propose-tables", this.request([frame], []), signal);
    this.source = { ...this.source, tables: result.tables.map((table) => ({ ...table, reference: null,
      setup_review: { tabletop: false, occupancy: false, map: false }, reference_approved: false,
      ...this.source.setup_reference })), revision: this.source.revision + 1 };
    return this.source;
  }
  private async referenceFrame(reference: NonNullable<SourceInfo["setup_reference"]>): Promise<EncodedFrame> {
    if (reference.reference_source === "uploaded_image") {
      if (!this.cleanImage) throw new Error("Upload the clean reference first.");
      return { ...this.cleanImage, sample_index: 0, t: 0 };
    }
    return this.decoder.frame(reference.reference_t ?? Math.max(0, this.decoder.metadata.first_timestamp));
  }
  readonly adapter = {
    persistentDrafts: false,
    canDeleteSavedTables: true,
    assetPath: (_sourceId: string, path: string) => this.asset(path),
    api: async <T>(path: string, init: RequestInit = {}): Promise<T> => this.setupApi(path, init) as Promise<T>,
  };
  private async setupApi(path: string, init: RequestInit): Promise<unknown> {
    const prefix = `/sources/${this.id}`;
    if (!path.startsWith(prefix)) throw new Error("Unknown in-memory recording.");
    const op = path.slice(prefix.length);
    const payload = typeof init.body === "string" ? JSON.parse(init.body) : {};
    if (!op) return structuredClone(this.source);
    if (op === "/frame") {
      if (!Number.isFinite(payload.t) || payload.t < 0 || payload.t > this.source.duration_s) throw new Error("Choose a timestamp within this video.");
      const frame = await this.decoder.frame(payload.t);
      return { t: frame.t, url: this.storeImage(`setup/frames/${frame.sha256}.jpg`, frame, "image/jpeg") };
    }
    if (op.startsWith("/setup-assets/")) {
      const kind = op.slice("/setup-assets/".length);
      if (!["clean_reference", "floor_plan"].includes(kind) || !(init.body instanceof FormData)) throw new Error("Invalid setup asset.");
      if (Number(init.body.get("revision")) !== this.source.revision) throw new Error("Setup changed. Reopen the current recording.");
      const file = init.body.get("file");
      if (!(file instanceof File) || file.size > 12 * 1024 * 1024 || !["image/jpeg", "image/png"].includes(file.type)) throw new Error("Choose a JPG or PNG up to 12 MB.");
      const bitmap = await createImageBitmap(file);
      try {
        if (bitmap.width > 8192 || bitmap.height > 8192 || bitmap.width * bitmap.height > 16_000_000) throw new Error("Image dimensions exceed the supported limit.");
        const m = this.decoder.metadata;
        if (kind === "clean_reference" && Math.abs(bitmap.width / bitmap.height - m.width / m.height) > 0.01)
          throw new Error("The clean reference must use the same camera aspect ratio as the video.");
        const width = kind === "clean_reference" ? m.processing_width : bitmap.width;
        const height = kind === "clean_reference" ? m.processing_height : bitmap.height;
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
        const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
        const image = { image_base64: toBase64(bytes), sha256: hashBytes(bytes), width, height };
        if (kind === "clean_reference" && bytes.length > FRAME_BATCH_LIMITS.image_bytes) throw new Error("Reference image is too detailed for a processing request. Choose a smaller image.");
        const asset: ImageAsset = { file: `setup/${kind}-${image.sha256}.png`, sha256: image.sha256, width, height };
        this.storeImage(asset.file, image);
        if (kind === "clean_reference") {
          this.cleanImage = image; this.proposals.clear();
          for (const key of Object.keys(this.references)) delete this.references[key];
          const reference: NonNullable<SourceInfo["setup_reference"]> = { reference_source: "uploaded_image", reference_t: null,
            reference_image_sha256: image.sha256, alignment_confirmed: false };
          this.source = { ...this.source, setup_reference: reference, tables: this.source.tables.map((table) => ({ ...table,
            ...reference, reference: null, reference_approved: false, object_baseline: undefined, expected_objects_draft: undefined,
            baseline_sha256: undefined, config_sha256: undefined })) };
        } else {
          this.source = { ...this.source, floor_plan_mode: "uploaded", tables: this.source.tables.map((table) => ({ ...table,
            setup_review: { ...(table.setup_review ?? { tabletop: false, occupancy: false, map: false }), map: false } })) };
        }
        this.bundle = undefined;
        this.source = { ...this.source, revision: this.source.revision + 1,
          setup_assets: { ...this.source.setup_assets, [kind]: asset }, calibration_confirmed: false, status: "needs_setup", progress: 0 };
        return structuredClone(this.source);
      } finally { bitmap.close(); }
    }
    if (payload.revision !== this.source.revision) throw new Error("Setup changed. Reopen the current recording.");
    if (op === "/baseline-proposal") {
      const table = this.source.tables.find((t) => t.id === payload.table_id);
      // Newly drawn tables may not have been saved yet; the editor sends full geometry.
      const candidate = { ...(table ?? { id: payload.table_id, label: payload.table_id, map: { x: .5, y: .5, w: .2, h: .2, shape: "rect" }, crop: [0, 0, 1, 1], video_region: [0, 0, 1, 1], reference: null }),
        tabletop_polygon: payload.tabletop_polygon, occupancy_regions: payload.occupancy_regions } as CalibrationTable;
      candidate.geometry_sha256 = hashBytes(new TextEncoder().encode(geometryKey(candidate)));
      const reference = { reference_source: payload.reference_source, reference_t: payload.reference_t,
        reference_image_sha256: payload.reference_image_sha256, alignment_confirmed: payload.alignment_confirmed } as NonNullable<SourceInfo["setup_reference"]>;
      const frame = await this.referenceFrame(reference);
      const reply = await this.api.request<ProposeReferenceReply>("propose-reference", this.request([frame], [candidate]));
      verifyImage(reply.reference);
      this.proposals.set(candidate.id, { reply, frame, geometry: geometryKey(candidate) });
      return { baseline: reply.baseline, detections: reply.detections, frame_base64: `data:image/png;base64,${reply.reference.image_base64}`,
        revision: this.source.revision, reference_t: frame.t };
    }
    if (op === "/calibration") {
      if (!Array.isArray(payload.tables) || payload.tables.length > FRAME_BATCH_LIMITS.tables) throw new Error("Too many tables in this recording.");
      const tables: CalibrationTable[] = structuredClone(payload.tables);
      const pendingReferences = new Map<string, { image: EncodedImage; path: string }>();
      for (const table of tables) {
        table.label = validLabel(table.label, tables.filter((t) => t.id !== table.id).map((t) => t.label));
        table.geometry_sha256 = hashBytes(new TextEncoder().encode(geometryKey(table)));
        if (table.object_baseline?.approved && table.reference_approved) {
          const proposal = this.proposals.get(table.id);
          const old = this.source.tables.find((t) => t.id === table.id);
          const image = proposal?.reply.reference ?? this.references[table.id];
          if (!image || image.sha256 !== table.object_baseline.reference_sha256 || table.object_baseline.geometry_sha256 !== table.geometry_sha256 ||
              (proposal && proposal.geometry !== geometryKey(table))) throw new Error("The reference or geometry changed. Generate a fresh object proposal.");
          const baseline: ObjectBaseline = { ...table.object_baseline, approved: true, reviewed_by: "browser_setup_review",
            expected: [...table.object_baseline.expected].sort((a, b) => a.class_id - b.class_id) };
          const { baseline_sha256: _unused, ...content } = baseline;
          baseline.baseline_sha256 = hashJson(content);
          table.object_baseline = baseline; table.surface_method = "objects_reference_v1";
          table.baseline_sha256 = baseline.baseline_sha256; table.config_sha256 = baseline.config_sha256;
          const referenceSource = table.reference_source ?? payload.setup_reference.reference_source;
          const sourceTime = referenceSource === "uploaded_image" ? 0 : (proposal?.frame.t ?? old?.reference?.source_t ?? table.reference_t ?? 0);
          table.reference = { file: `references/${encodeURIComponent(table.id)}-${image.sha256}.png`, sha256: image.sha256,
            source_t: sourceTime, confirmed_clean: true, reviewed_by: "browser_setup_review", source_kind: referenceSource,
            ...(referenceSource === "uploaded_image" ? { source_image: this.source.setup_assets?.clean_reference, alignment_confirmed: table.alignment_confirmed } : {}) };
          verifyImage(image);
          pendingReferences.set(table.id, { image, path: table.reference.file });
        } else if (!table.object_baseline?.approved) { table.reference = null; }
      }
      const next: SourceInfo = { ...this.source, tables, setup_reference: payload.setup_reference, setup_mode: "guided_v1",
        floor_plan_mode: payload.floor_plan_mode, revision: this.source.revision + 1, calibration_confirmed: !!payload.confirmed, status: "needs_setup", progress: 0 };
      if (payload.confirmed) {
        const missing = setupRequirements(next);
        if (missing.length) throw new Error(missing[0].message);
      }
      // Do not discard evidence or update reference assets until the whole save is valid.
      for (const [id, { image, path }] of pendingReferences) {
        this.storeImage(path, image);
        this.references[id] = image;
      }
      const remainingIds = new Set(tables.map((table) => table.id));
      const removedIds = new Set([
        ...this.source.tables.map((table) => table.id), ...Object.keys(this.references), ...this.proposals.keys(),
      ].filter((id) => !remainingIds.has(id)));
      const removedPaths = new Set(this.source.tables.filter((table) => removedIds.has(table.id))
        .flatMap((table) => table.reference ? [table.reference.file] : []));
      const retainedPaths = new Set([
        ...tables.flatMap((table) => table.reference ? [table.reference.file, table.reference.source_image?.file] : []),
        ...Object.values(next.setup_assets ?? {}).map((asset) => asset?.file),
      ]);
      const removedPrefixes = [...removedIds].map((id) => `references/${encodeURIComponent(id)}-`);
      for (const id of removedIds) { delete this.references[id]; this.proposals.delete(id); }
      for (const [path, url] of this.assets) {
        if (path.startsWith("references/") && !retainedPaths.has(path) &&
            (removedPaths.has(path) || removedPrefixes.some((prefix) => path.startsWith(prefix)))) {
          URL.revokeObjectURL(url); this.assets.delete(path);
        }
      }
      this.bundle = undefined; this.source = next; this.setupRunId = crypto.randomUUID();
      return structuredClone(next);
    }
    throw new Error(`Unsupported in-memory setup operation: ${op}`);
  }
  createBundle(runId: string): Bundle {
    const m = this.decoder.metadata;
    const bundle: Bundle = { policy: "automatic", provenance: "real_video",
      video: { file: "video.mp4", sha256: m.sha256, width: m.width, height: m.height, fps: m.fps, duration_s: m.duration_s,
        source_kind: "browser_file", timestamp_source: "mp4_presentation", fps_kind: "measured_average",
        processing_width: m.processing_width, processing_height: m.processing_height },
      original_scene: null, ...(this.source.floor_plan_mode === "uploaded" ? { floor_plan: this.source.setup_assets?.floor_plan } : {}),
      tables: structuredClone(this.source.tables), observations: [], staff_events: [], assessments: [], assessment_requests: [],
      rules: { entry_s: 5, exit_s: 5, gap_s: 1, assessment_separation_s: 2, assessment_retry_s: 5, track_grace_s: 1 },
      analysis: { processing_mode: "stateless", run_id: runId, setup_revision: this.source.revision,
        model_sha256: this.api.capabilities!.model_sha256, config_sha256: this.api.capabilities!.config_sha256,
        build_id: this.api.capabilities!.build_id, sample_hz: FRAME_BATCH_LIMITS.sample_hz, first_timestamp: m.first_timestamp, rotation: m.rotation } };
    validateBundle(bundle); return bundle;
  }
  result(): StatelessRecordingResult {
    if (!this.bundle) throw new Error("Analyze this recording before opening its dashboard.");
    return { bundle: this.bundle, asset: (path) => path ? this.asset(path) : undefined, urls: [], name: this.file.name, source: this.source };
  }
  dispose() { this.decoder.close(); for (const url of this.assets.values()) URL.revokeObjectURL(url); this.assets.clear(); }
}
