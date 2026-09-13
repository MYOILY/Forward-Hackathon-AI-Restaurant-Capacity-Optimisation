import { describe, expect, it } from "vitest";
import type {
  ObjectSurfaceEvidence,
  SurfaceAssessment,
} from "../../shared/contracts";
import type {
  LiveAssessmentRequest,
  LiveReply,
} from "../../shared/live-contracts";
import { createReplaySession } from "../../web/src/engine";
import { createLiveSession } from "../../web/src/live-engine";
import {
  detected,
  objectAssessment,
  objectBundle,
  objectEvidence,
  objectLiveAssessment,
  objectLiveConfig,
} from "./object-fixtures";
import { liveObservation } from "./live-fixtures";
import { replayFixture } from "./replay-fixtures";

const dirtyEvidence = () => {
  const evidence = objectEvidence();
  evidence.reference.changed_fraction = 0.2;
  return evidence;
};
const alignedEvidence = (applied: boolean, dirty = false) => {
  const evidence = dirty ? dirtyEvidence() : objectEvidence();
  evidence.reference.alignment = {
    method: "translation_ecc_v1",
    applied,
    dx: applied ? 2 : 0,
    dy: 0,
    correlation: applied ? 0.9 : null,
  };
  return evidence;
};

function replayHarness(bundle = objectBundle(60)) {
  const session = createReplaySession(bundle);
  function submit(
    t: number,
    evidence: ObjectSurfaceEvidence = objectEvidence(),
  ) {
    session.advanceTo(t);
    const request = session
      .getAssessmentRequests()
      .find((item) => item.t === t);
    expect(request, `expected source capture at ${t}`).toBeDefined();
    session.submitAssessment(objectAssessment(request!, evidence));
    return session.advanceTo(t).tables.T1;
  }
  return { session, submit };
}

function liveHarness() {
  const config = objectLiveConfig(),
    session = createLiveSession(config);
  const requests: LiveAssessmentRequest[] = [];
  let lastFrame = -1,
    reply: LiveReply;
  function feed(t: number, delay = 0) {
    for (let frame = lastFrame + 1; frame <= Math.round(t * 10); frame++) {
      reply = session.send({
        op: "observation",
        observation: liveObservation(frame / 10, false, config),
        now: frame / 10 + delay,
      });
      requests.push(...reply.requests);
      lastFrame = frame;
    }
    return reply!;
  }
  function submit(t: number, now = t, evidence = objectEvidence()) {
    const request = requests.find((item) => item.t === t);
    expect(request, `expected live capture at ${t}`).toBeDefined();
    return session.send({
      op: "assessment",
      result: objectLiveAssessment(request!, now, evidence),
      now,
    }).snapshot.tables.T1;
  }
  return { session, requests, feed, submit };
}

describe("early dirty detection and strict clean eligibility", () => {
  it("can show red after one second of continuous visible absence while green and staff overrides still wait", () => {
    const { session, submit } = replayHarness();
    expect(session.advanceTo(0.9).tables.T1.status).toBe("unknown");
    expect(session.getAssessmentRequests()).toHaveLength(0);
    const red = submit(1, dirtyEvidence());
    expect(red.status).toBe("needs_cleaning");
    expect(red.people_state).not.toBe("vacant");
    expect(red.can_confirm_cleaned).toBe(false);
    expect(red.can_force_cleaned).toBe(false);
    expect(red.reason).toContain("20.00%");
  });

  it("does not count an early clean image and reaches initial green only after fresh captures at five and seven seconds", () => {
    const { session, submit } = replayHarness();
    expect(submit(1).status).toBe("unknown");
    expect(session.advanceTo(4.9).tables.T1.status).toBe("unknown");
    expect(session.getAssessmentRequests().map((item) => item.t)).toEqual([1]);
    expect(submit(5).status).toBe("unknown");
    expect(submit(7).status).toBe("ready");
    expect(session.getAssessmentRequests().map((item) => item.t)).toEqual([
      1, 5, 7,
    ]);
  });

  it("requires one uninterrupted visible second even if absence was already known", () => {
    const bundle = objectBundle();
    for (const observation of bundle.observations)
      if (observation.t < 3) observation.surface!.T1.visible = false;
    const { session, submit } = replayHarness(bundle);
    session.advanceTo(3.9);
    expect(session.getAssessmentRequests()).toHaveLength(0);
    expect(submit(4, dirtyEvidence()).status).toBe("needs_cleaning");
  });

  it("detection-only layouts never request surface inference and staff confirmation keeps its vacancy boundary", () => {
    const bundle = replayFixture();
    const session = createReplaySession(bundle, [
      {
        id: "too-soon",
        t: 1,
        table_id: "T1",
        action: "force_cleaned",
        source: "staff",
        seq: 0,
      },
    ]);
    expect(session.advanceTo(1).tables.T1.status).toBe("unknown");
    expect(session.advanceTo(4.9).tables.T1.can_confirm_cleaned).toBe(false);
    expect(session.getAssessmentRequests()).toHaveLength(0);
    expect(session.advanceTo(5).tables.T1.can_confirm_cleaned).toBe(true);
    expect(session.getAssessmentRequests()).toEqual([]);
    expect(
      session
        .advanceTo(5)
        .events.some(
          (event) =>
            event.event_id === "too-soon" && event.kind === "staff_rejected",
        ),
    ).toBe(true);
  });
});

describe("persistent dirty evidence and clean confirmation", () => {
  it("retains red until clean captures satisfy both the count and source-time span", () => {
    const { session, submit } = replayHarness();
    expect(submit(1, dirtyEvidence()).status).toBe("needs_cleaning");
    expect(submit(3).status).toBe("needs_cleaning"); // Before the five-second vacancy guard.
    for (const t of [5, 7, 9]) expect(submit(t).status).toBe("needs_cleaning");
    expect(session.advanceTo(9).tables.T1.surface_reason).toContain(
      "3 of at least 3 captures across 4 of 5 s",
    );
    expect(submit(11).status).toBe("ready");
    expect(
      session
        .advanceTo(11)
        .events.filter(
          (event) => event.kind === "transition" && event.status === "ready",
        )
        .map((event) => event.t),
    ).toEqual([11]);
  });

  it("restarts clean confirmation after a new negative capture", () => {
    const { submit } = replayHarness();
    submit(1, dirtyEvidence());
    submit(3);
    submit(5);
    submit(7);
    expect(submit(9, dirtyEvidence()).status).toBe("needs_cleaning");
    for (const t of [11, 13, 15])
      expect(submit(t).status).toBe("needs_cleaning");
    expect(submit(17).status).toBe("ready");
  });

  it("turns grey immediately on obstruction and restores known red only after one clear second, with a fresh streak", () => {
    const bundle = objectBundle();
    for (const observation of bundle.observations)
      if (observation.t >= 8 && observation.t < 9)
        observation.surface!.T1.visible = false;
    const { session, submit } = replayHarness(bundle);
    submit(1, dirtyEvidence());
    submit(3);
    submit(5);
    submit(7);
    expect(session.advanceTo(8).tables.T1.status).toBe("unknown");
    expect(session.advanceTo(9.9).tables.T1.status).toBe("unknown");
    expect(
      session
        .getAssessmentRequests()
        .some((request) => request.t >= 8 && request.t < 10),
    ).toBe(false);
    expect(session.advanceTo(10).tables.T1.status).toBe("needs_cleaning");
    for (const t of [10, 12, 14])
      expect(submit(t).status).toBe("needs_cleaning");
    expect(submit(16).status).toBe("ready");
  });

  it("preserves known dirt across a surface-change event while resetting the clean streak", () => {
    const bundle = objectBundle();
    bundle.observations.find(
      (observation) => observation.t === 8,
    )!.surface!.T1.changed = true;
    const { session, submit } = replayHarness(bundle);
    submit(1, dirtyEvidence());
    submit(3);
    submit(5);
    submit(7);
    expect(session.advanceTo(8).tables.T1.status).toBe("needs_cleaning");
    for (const t of [8, 10, 12])
      expect(submit(t).status).toBe("needs_cleaning");
    expect(submit(14).status).toBe("ready");
  });

  it("expires stale clean confirmations without forgetting the cleaning need", () => {
    const { session, submit } = replayHarness();
    submit(1, dirtyEvidence());
    submit(3);
    submit(5);
    submit(7);
    expect(session.advanceTo(16.9).tables.T1.status).toBe("needs_cleaning");
    expect(session.advanceTo(17).tables.T1.surface_reason).toContain(
      "Clean confirmation expired",
    );
    for (const t of [17, 19, 21])
      expect(submit(t).status).toBe("needs_cleaning");
    expect(submit(23).status).toBe("ready");
  });

  it.each(["camera movement", "scene cut", "capture gap"])(
    "forgets old temporal evidence after %s",
    (mode) => {
      const bundle = objectBundle();
      if (mode === "capture gap")
        bundle.observations = bundle.observations.filter(
          (observation) => observation.t < 8 || observation.t >= 10,
        );
      else
        for (const observation of bundle.observations)
          if (observation.t >= 8 && observation.t < 9) {
            if (mode === "camera movement")
              observation.surface!.T1.camera_moved = true;
            else observation.scene_cut = true;
          }
      const { session, submit } = replayHarness(bundle);
      submit(1, dirtyEvidence());
      submit(3);
      submit(5);
      submit(7);
      const freshTime = mode === "capture gap" ? 11 : 10;
      expect(session.advanceTo(freshTime).tables.T1.status).toBe("unknown");
      expect(submit(freshTime).status).toBe("unknown");
    },
  );

  it("blocks true unobservable results but holds known red during an isolated alignment-mode verification", () => {
    const { session, submit } = replayHarness();
    submit(1, alignedEvidence(true, true));
    expect(submit(3, alignedEvidence(false)).status).toBe("needs_cleaning");
    expect(session.advanceTo(3).tables.T1.surface_reason).toContain(
      "Photo alignment changed",
    );
    const blocked = objectEvidence();
    blocked.reference.observable = false;
    blocked.reference.reason = "Tabletop obstructed";
    expect(submit(4, blocked).status).toBe("unknown");
    expect(submit(5, alignedEvidence(true)).status).toBe("needs_cleaning");
  });

  it("does not flicker directly from green to red on one object-only mismatch", () => {
    const { session, submit } = replayHarness();
    submit(1);
    submit(5);
    submit(7);
    const mismatch = objectEvidence([detected(), detected(45)]);
    expect(submit(9, mismatch).status).toBe("unknown");
    expect(session.advanceTo(9).tables.T1.surface_reason).toContain(
      "second capture",
    );
    expect(submit(10, mismatch).status).toBe("needs_cleaning");
  });
});

describe("live source-time gates and replay stability", () => {
  it("does not qualify early absence or visibility from delivery latency", () => {
    const h = liveHarness();
    h.feed(0.9, 0.6);
    expect(h.requests).toHaveLength(0);
    h.feed(1, 0.6);
    expect(h.requests.map((request) => request.t)).toEqual([1]);
  });

  it("does not count a one-second clean capture delivered after the five-second vacancy boundary", () => {
    const h = liveHarness();
    h.feed(5);
    expect(h.requests.map((request) => request.t)).toEqual([1]);
    expect(h.submit(1, 5).status).toBe("unknown");
    h.feed(5.1);
    expect(h.submit(5.1).status).toBe("unknown");
    h.feed(7.1);
    expect(h.submit(7.1).status).toBe("ready");
  });

  it("uses the same dirty-to-clean count and span for live captures", () => {
    const h = liveHarness();
    h.feed(1);
    expect(h.submit(1, 1, dirtyEvidence()).status).toBe("needs_cleaning");
    for (const t of [3, 5, 7, 9]) {
      h.feed(t);
      expect(h.submit(t).status).toBe("needs_cleaning");
    }
    h.feed(11);
    expect(h.submit(11).status).toBe("ready");
  });

  it("replays stored raw evidence and backward seeks with the same stabilization decisions", () => {
    const bundle = objectBundle(),
      { session, submit } = replayHarness(bundle);
    const results: SurfaceAssessment[] = [];
    for (const t of [1, 3, 5, 7, 9, 11]) {
      const state = submit(t, t === 1 ? dirtyEvidence() : objectEvidence());
      results.push(state.last_assessment!);
    }
    bundle.assessment_requests = session.getAssessmentRequests();
    bundle.assessments = results;
    const replay = createReplaySession(bundle);
    expect(replay.advanceTo(11).tables.T1.status).toBe("ready");
    expect(replay.advanceTo(9).tables.T1.status).toBe("needs_cleaning");
    expect(replay.advanceTo(11).tables.T1.status).toBe("ready");
    replay.reset();
    expect(replay.advanceTo(11).tables.T1.status).toBe("ready");
  });
});
