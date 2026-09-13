import { describe, expect, it } from "vitest";
import type { Bundle, Observation, SurfaceAssessment } from "../../shared/contracts";
import { FRAME_BATCH_LIMITS } from "../../shared/frame-batch-contracts";
import { createReplaySession } from "../../web/src/engine";
import { validateBundle } from "../../web/src/validation";
import { objectAssessment, objectBundle } from "./object-fixtures";

function recording(): Bundle {
  const bundle = objectBundle(12);
  const sampleHz = FRAME_BATCH_LIMITS.sample_hz;
  bundle.analysis = { processing_mode: "stateless", run_id: "test-run", setup_revision: 1,
    build_id: "test-build", model_sha256: "b".repeat(64), config_sha256: "c".repeat(64),
    sample_hz: sampleHz, first_timestamp: 0, rotation: 0 };
  Object.assign(bundle.video, {
    source_kind: "browser_file", timestamp_source: "mp4_presentation",
    fps: 24, fps_kind: "measured_average", processing_width: 640, processing_height: 360,
  });
  const template = bundle.observations[0];
  bundle.observations = Array.from({ length: bundle.video.duration_s * sampleHz + 1 }, (_, index) => ({
    ...structuredClone(template), t: index / sampleHz, frame_index: index,
  }));
  bundle.observations.forEach((o, sample_index) => {
    o.capture = { sample_index, t: o.t, width: 640, height: 360,
      sha256: sample_index.toString(16).padStart(64, "0") };
  });
  return bundle;
}

function process(batchSize: number) {
  const bundle = recording(), observations = bundle.observations;
  bundle.observations = [];
  const session = createReplaySession(bundle), results: SurfaceAssessment[] = [];
  const handled = new Set<string>();
  for (let offset = 0; offset < observations.length; offset += batchSize) {
    for (const observation of observations.slice(offset, offset + batchSize)) {
      session.appendObservation(observation);
      session.advanceTo(observation.t);
      for (const request of session.getAssessmentRequests()) {
        if (handled.has(request.id)) continue;
        const result = { ...objectAssessment(request), capture: request.capture };
        session.submitAssessment(result);
        results.push(result);
        handled.add(request.id);
      }
    }
  }
  bundle.assessment_requests = session.getAssessmentRequests();
  bundle.assessments = results;
  return { bundle, snapshot: session.advanceTo(bundle.video.duration_s) };
}

describe("browser recording provenance and incremental replay", () => {
  it.each([1, 2, 8])("retains assessment scheduling and replay across batches of %s", (size) => {
    const { bundle, snapshot } = process(size);
    expect(bundle.video.fps).toBe(24);
    expect(bundle.analysis.sample_hz).toBe(8);
    expect(() => validateBundle(bundle)).not.toThrow();
    expect(snapshot.tables.T1.status).toBe("ready");
    expect(bundle.assessment_requests!.length).toBeGreaterThanOrEqual(2);
    expect(createReplaySession(bundle).advanceTo(12)).toEqual(snapshot);
    expect(process(121).snapshot).toEqual(snapshot);
  });

  it("requires exact frame provenance for browser recordings", () => {
    expect(() => validateBundle(objectBundle(12))).not.toThrow();
    const bundle = recording();
    delete bundle.observations[0].capture;
    expect(() => validateBundle(bundle)).toThrow(/capture/i);
    const changed = recording();
    changed.observations[1].capture!.t = 0.101;
    expect(() => validateBundle(changed)).toThrow(/capture/i);
    const rate = recording();
    delete rate.video.fps_kind;
    expect(() => validateBundle(rate)).toThrow(/measured frame rate/i);
    const identity = recording();
    delete identity.analysis.model_sha256;
    expect(() => validateBundle(identity)).toThrow(/identities/i);
  });

  it("rejects relabeling stateless analysis to bypass browser capture validation", () => {
    const bundle = recording();
    bundle.video.source_kind = "processed_file";
    delete bundle.observations[0].capture;
    expect(() => validateBundle(bundle)).toThrow(/browser-file video provenance/);
    expect(() => createReplaySession(bundle)).toThrow(/browser-file video provenance/);
  });

  it("does not commit duplicates, stale times or malformed appended observations", () => {
    const bundle = recording(), [first, second] = bundle.observations;
    bundle.observations = [];
    const session = createReplaySession(bundle);
    session.appendObservation(first);
    first.tables.T1 = "present";
    expect(bundle.observations[0].tables.T1).toBe("absent");
    session.advanceTo(first.t);
    expect(() => session.appendObservation(first)).toThrow(/timestamps/i);
    const invalid: Observation = { ...second, valid: false };
    expect(() => session.appendObservation(invalid)).toThrow(/uncertain/);
    expect(bundle.observations).toHaveLength(1);
    session.advanceTo(second.t);
    expect(() => session.appendObservation(second)).toThrow(/before advancing/);
    expect(bundle.observations).toHaveLength(1);
  });

  it("rejects an assessment whose frame bytes differ from the request", () => {
    const bundle = recording(), session = createReplaySession(bundle);
    session.advanceTo(1);
    const request = session.getAssessmentRequests()[0];
    expect(request.capture).toEqual(bundle.observations.find(o => o.t === 1)!.capture);
    session.submitAssessment({ ...objectAssessment(request),
      capture: { ...request.capture!, sha256: "f".repeat(64) } });
    expect(session.advanceTo(1).events.at(-1)?.kind).toBe("assessment_rejected");
    expect(session.advanceTo(1).events.at(-1)?.reason).toMatch(/identity/);
    expect(session.advanceTo(1).tables.T1.status).toBe("unknown");
  });

  it("uses actual presentation timestamps including a positive initial gap", () => {
    const bundle = recording();
    bundle.observations = bundle.observations.filter(o => o.t >= 0.7);
    for (const o of bundle.observations) {
      o.t = Number((o.t + 0.013).toFixed(3));
      o.capture!.t = o.t;
    }
    bundle.video.duration_s += 0.013;
    expect(() => validateBundle(bundle)).not.toThrow();
    const session = createReplaySession(bundle);
    expect(session.advanceTo(0.7).tables.T1.presence).toBe("uncertain");
    expect(session.advanceTo(bundle.observations[0].t).tables.T1.presence).toBe("absent");
  });

  it("refuses a completed manifest with a substituted request capture", () => {
    const { bundle } = process(8);
    bundle.assessment_requests![0].capture = {
      ...bundle.assessment_requests![0].capture!, sha256: "f".repeat(64),
    };
    expect(() => validateBundle(bundle)).toThrow(/encoded browser frame/);
  });
});
