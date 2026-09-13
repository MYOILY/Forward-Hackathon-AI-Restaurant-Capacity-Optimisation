import { FRAME_BATCH_LIMITS, type AssessBatchReply, type EncodedAssessment, type FrameBatchRequest, type FrameCheckpoint, type FrameInput, type FrameOperation, type FrameReplyIdentity, type ObserveBatchReply } from "../../../shared/frame-batch-contracts";
import type { Bundle, Snapshot } from "../../../shared/contracts";
import { createReplaySession } from "../engine";
import { MAX_BODY_BYTES } from "./config";
import { abortError, jsonBytes, PausableRequestError, PayloadSizeError } from "./transport";
import { assessmentBatch, fitAssessments, orderedAssessments, type AssessmentBatch } from "./assessment-batches";
import type { BrowserRecording } from "./recording";
export interface ProcessingProgress { progress: number; paused: boolean; error?: string; snapshot?: Snapshot }

/** Choose the largest prefix that fits after including setup and prior checkpoint. */
export function fitFrames(request: FrameBatchRequest, frames: FrameInput[]): FrameInput[] {
  let count = Math.min(frames.length, 8);
  while (count > 0 && jsonBytes({ ...request, frames: frames.slice(0, count) }) > MAX_BODY_BYTES) count--;
  if (!count) throw new Error("A frame plus this setup exceeds the request limit. Reduce the number of tables or image detail.");
  return frames.slice(0, count);
}
export class RecordingProcessor {
  private abort = new AbortController();
  private paused = false;
  private waiting?: () => void;
  private progress = 0;
  private snapshot?: Snapshot;
  private assessmentLimit = FRAME_BATCH_LIMITS.frames;
  constructor(private recording: BrowserRecording, private changed: (value: ProcessingProgress) => void) {}
  pause() { this.paused = true; this.publish(); }
  resume() { this.paused = false; this.waiting?.(); this.waiting = undefined; this.publish(); }
  cancel() { this.abort.abort(); this.waiting?.(); this.waiting = undefined; }
  private publish(error?: string) { this.changed({ progress: this.progress, paused: this.paused, error, snapshot: this.snapshot }); }
  private async gate() {
    if (this.abort.signal.aborted) throw abortError();
    if (this.paused) await new Promise<void>((resolve) => { this.waiting = resolve; });
    if (this.abort.signal.aborted) throw abortError();
  }
  private async call<T extends FrameReplyIdentity>(operation: FrameOperation, request: FrameBatchRequest): Promise<T> {
    // Manual retries preserve the exact request and checkpoint, including request_id.
    for (;;) {
      await this.gate();
      try {
        const reply = await this.recording.api.request<T>(operation, request, this.abort.signal);
        await this.gate();
        if (this.recording.source.revision !== request.revision) throw new Error("Calibration changed during analysis. Start a new analysis.");
        return reply;
      } catch (error) {
        if (!(error instanceof PausableRequestError)) throw error;
        this.paused = true; this.publish(error.message);
      }
    }
  }
  private async assess(batch: AssessmentBatch): Promise<EncodedAssessment[]> {
    let response: AssessBatchReply;
    try {
      response = await this.call<AssessBatchReply>("assess-batch", batch);
    } catch (error) {
      if (!(error instanceof PayloadSizeError) || batch.requests.length === 1) throw error;
      const split = Math.ceil(batch.requests.length / 2);
      // Remember the smaller group size for later frames in this run.
      this.assessmentLimit = Math.min(this.assessmentLimit, split);
      const results: EncodedAssessment[] = [];
      for (const requests of [batch.requests.slice(0, split), batch.requests.slice(split)]) {
        const child = assessmentBatch({ ...batch, request_id: crypto.randomUUID() }, requests, batch.references);
        results.push(...await this.assess(child));
      }
      // No result from the failed parent group is applied until all children succeed.
      return orderedAssessments(batch, { ...batch, assessments: results });
    }
    return orderedAssessments(batch, response);
  }
  async run(): Promise<Bundle> {
    const record = this.recording, runId = crypto.randomUUID(), revision = record.source.revision;
    const bundle = record.createBundle(runId), session = createReplaySession(bundle);
    const assessmentIds = new Set<string>();
    let checkpoint: FrameCheckpoint | null = null;
    await record.decoder.reset();
    let ended = false;
    while (!ended) {
      await this.gate();
      const decoded = await record.decoder.next(8);
      ended = decoded.done;
      let pending = decoded.frames;
      while (pending.length) {
        const base: FrameBatchRequest = { ...record.request([], bundle.tables, runId), revision, checkpoint };
        const frames = fitFrames(base, pending);
        const reply: ObserveBatchReply = await this.call<ObserveBatchReply>("observe-batch", { ...base, frames });
        if (!Array.isArray(reply.observations) || reply.observations.length !== frames.length ||
          !reply.checkpoint || typeof reply.checkpoint !== "object") throw new Error("Incomplete observation batch returned by the processor.");
        for (let index = 0; index < frames.length; index++) {
          await this.gate();
          const observation = reply.observations[index], frame = frames[index];
          const { image_base64: _bytes, ...capture } = frame;
          if (observation.t !== frame.t || observation.frame_index !== frame.sample_index ||
            JSON.stringify(observation.capture) !== JSON.stringify(capture)) {
            // Compare fields explicitly because JSON key order is not part of capture identity.
            if (observation.t !== frame.t || observation.frame_index !== frame.sample_index ||
              !observation.capture || Object.entries(capture).some(([k, v]) => observation.capture![k as keyof typeof capture] !== v))
              throw new Error("Observation capture does not match its source frame.");
          }
          session.appendObservation(observation);
          this.snapshot = session.advanceTo(observation.t);
          const requests = session.getAssessmentRequests().filter((request) => request.t === observation.t);
          // Retain this exact frame and finish every group before the next observation.
          for (let offset = 0; offset < requests.length;) {
            const batch = fitAssessments({ ...record.request([frame], bundle.tables, runId), revision },
              requests.slice(offset), record.references, this.assessmentLimit);
            const assessments = await this.assess(batch);
            if (assessments.some((assessment) => assessmentIds.has(assessment.id)))
              throw new Error("Repeated surface assessment returned by the processor.");
            for (const { crop_base64, width, height, ...assessment } of assessments) {
              record.storeImage(assessment.crop_file, { image_base64: crop_base64, sha256: assessment.crop_sha256, width, height });
              session.submitAssessment(assessment);
              bundle.assessments!.push(assessment);
              assessmentIds.add(assessment.id);
              this.snapshot = session.advanceTo(observation.t);
            }
            offset += batch.requests.length;
          }
          this.progress = Math.min(1, observation.t / bundle.video.duration_s); this.publish();
        }
        checkpoint = reply.checkpoint;
        pending = pending.slice(frames.length);
      }
    }
    this.snapshot = session.advanceTo(bundle.video.duration_s);
    bundle.assessment_requests = session.getAssessmentRequests();
    bundle.replay_events = this.snapshot.events;
    record.bundle = bundle;
    record.source = { ...record.source, status: "completed", progress: 1, phase: "Analysis complete" };
    this.progress = 1; this.publish();
    return bundle;
  }
}
