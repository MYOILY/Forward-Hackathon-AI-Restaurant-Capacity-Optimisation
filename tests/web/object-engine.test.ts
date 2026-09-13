import { describe, expect, it } from "vitest";
import type { AssessmentRequest, ReplaySession } from "../../shared/contracts";
import type {
  LiveAssessmentRequest,
  LiveConfig,
  LiveReply,
} from "../../shared/live-contracts";
import { createReplaySession } from "../../web/src/engine";
import { createLiveSession } from "../../web/src/live-engine";
import {
  objectAssessment,
  objectBundle,
  objectEvidence,
  objectLiveAssessment,
  objectLiveConfig,
} from "./object-fixtures";
import { liveObservation } from "./live-fixtures";
import { person } from "./replay-fixtures";

function highDifferenceEvidence() {
  const evidence = objectEvidence();
  evidence.reference.changed_fraction = 0.2;
  return evidence;
}

function request(session: ReplaySession, t: number): AssessmentRequest {
  session.advanceTo(t);
  const result = session.getAssessmentRequests().find((item) => item.t === t);
  expect(result, `expected assessment at ${t}`).toBeDefined();
  return result!;
}
function readyReplay(bundle = objectBundle()) {
  const session = createReplaySession(bundle);
  session.submitAssessment(objectAssessment(request(session, 1)));
  session.submitAssessment(objectAssessment(request(session, 5)));
  session.submitAssessment(objectAssessment(request(session, 7)));
  expect(session.advanceTo(7).tables.T1.status).toBe("ready");
  return session;
}
function liveHarness(config: LiveConfig = objectLiveConfig()) {
  const session = createLiveSession(config),
    requests: LiveAssessmentRequest[] = [];
  let reply: LiveReply,
    capture = -1;
  function feed(end: number, delay = 0, occupied = false) {
    for (let i = capture + 1; i <= Math.round(end * 10); i++) {
      reply = session.send({
        op: "observation",
        observation: liveObservation(i / 10, occupied, config),
        now: i / 10 + delay,
      });
      requests.push(...reply.requests);
      capture = i;
    }
    return reply!;
  }
  function positive(t: number, availability = t) {
    const request = requests.find(
      (item) => item.t === t && item.table_id === "T1",
    );
    expect(request, `expected live request at ${t}`).toBeDefined();
    return session.send({
      op: "assessment",
      result: objectLiveAssessment(request!, availability),
      now: availability,
    });
  }
  function ready() {
    feed(1);
    positive(1);
    feed(5);
    positive(5);
    feed(7);
    expect(positive(7).snapshot.tables.T1.status).toBe("ready");
  }
  return { session, requests, feed, positive, ready };
}

describe("object-baseline replay scheduling and shared decisions", () => {
  it("requires approval and recomputes placeholder/forged outcomes from raw evidence", () => {
    const bundle = objectBundle();
    bundle.tables[0].object_baseline!.approved = false;
    const unapproved = createReplaySession(bundle);
    expect(unapproved.advanceTo(20).tables.T1.surface_reason).toMatch(
      /Approve expected objects/,
    );
    expect(unapproved.getAssessmentRequests()).toEqual([]);
    const session = createReplaySession(objectBundle());
    const emitted = request(session, 5);
    session.submitAssessment({
      ...objectAssessment(emitted, objectEvidence([])),
      outcome: "cleared_reset",
    });
    expect(session.advanceTo(5).tables.T1.last_assessment?.outcome).toBe(
      "unobservable",
    );
    session.submitAssessment({
      ...objectAssessment(request(session, 6), objectEvidence([])),
      outcome: "cleared_reset",
    });
    expect(session.advanceTo(6).tables.T1.last_assessment?.outcome).toBe(
      "not_reset",
    );
    expect(session.advanceTo(6).tables.T1.status).toBe("needs_cleaning");
  });
  it("marks a vacant table red from high reference difference even if the saved result asserted clean", () => {
    const session = createReplaySession(objectBundle()),
      emitted = request(session, 5);
    session.submitAssessment({
      ...objectAssessment(emitted, highDifferenceEvidence()),
      outcome: "cleared_reset",
    });
    const state = session.advanceTo(5).tables.T1;
    expect(state.people_state).toBe("vacant");
    expect(state.surface_state).toBe("needs_reset");
    expect(state.status).toBe("needs_cleaning");
    expect(state.last_assessment?.outcome).toBe("not_reset");
    expect(state.surface_reason).toContain("20.00%");
  });
  it("hides dirt on arrival, then restores the cleaning need after one second of clear absence", () => {
    const bundle = objectBundle();
    for (const observation of bundle.observations)
      if (observation.t >= 6 && observation.t <= 13) person(observation);
    const session = createReplaySession(bundle);
    session.submitAssessment(
      objectAssessment(request(session, 5), highDifferenceEvidence()),
    );
    const dirtyGeneration = session.advanceTo(5).tables.T1.generation;
    const arrival = session.advanceTo(6).tables.T1;
    expect(arrival.people_state).toBe("pending_arrival");
    expect(arrival.surface_state).toBe("unverified");
    expect(arrival.needs_cleaning).toBe(false);
    expect(arrival.generation).toBeGreaterThan(dirtyGeneration!);
    expect(session.advanceTo(11).tables.T1.status).toBe("occupied");
    expect(session.advanceTo(13.1).tables.T1.people_state).toBe(
      "pending_departure",
    );
    expect(session.advanceTo(14).tables.T1.status).toBe("unknown");
    expect(session.getAssessmentRequests().map((item) => item.t)).toEqual([
      1, 3, 5,
    ]);
    const fresh = request(session, 14.1);
    expect(fresh.generation).toBeGreaterThan(dirtyGeneration!);
    expect(session.advanceTo(14.1).tables.T1.people_state).toBe(
      "pending_departure",
    );
    expect(session.advanceTo(14.1).tables.T1.status).toBe("needs_cleaning");
    session.submitAssessment(objectAssessment(fresh, highDifferenceEvidence()));
    expect(session.advanceTo(14.1).tables.T1.status).toBe("needs_cleaning");
  });
  it("checks unchanged Ready tables every two seconds and renews without flicker", () => {
    const session = readyReplay();
    expect(session.advanceTo(8.9).tables.T1.status).toBe("ready");
    session.submitAssessment(objectAssessment(request(session, 9)));
    expect(session.advanceTo(9).tables.T1.status).toBe("ready");
    expect(
      session
        .advanceTo(10.9)
        .events.filter(
          (item) => item.kind === "transition" && item.status === "ready",
        )
        .map((item) => item.t),
    ).toEqual([7]);
    expect(request(session, 11).t).toBe(11);
  });
  it("expires at exactly capture +10 despite an unanswered request, then needs two fresh positives", () => {
    const session = readyReplay();
    request(session, 9);
    expect(session.advanceTo(16.9).tables.T1.status).toBe("ready");
    const oldGeneration = session.advanceTo(16.9).tables.T1.generation;
    const fresh = request(session, 17);
    expect(session.advanceTo(17).tables.T1.status).toBe("unknown");
    expect(fresh.generation).toBeGreaterThan(oldGeneration!);
    session.submitAssessment(objectAssessment(fresh));
    expect(session.advanceTo(17).tables.T1.status).toBe("unknown");
    session.submitAssessment(objectAssessment(request(session, 19)));
    expect(session.advanceTo(19).tables.T1.status).toBe("ready");
  });
  it("evaluates expiration between recorded observations instead of waiting for the next frame", () => {
    const bundle = objectBundle();
    bundle.rules.gap_s = 3;
    bundle.observations = bundle.observations.filter(
      (item) => item.t <= 16 || item.t >= 18,
    );
    const session = readyReplay(bundle);
    expect(session.advanceTo(17).tables.T1.status).toBe("unknown");
    expect(
      session
        .advanceTo(17)
        .events.some(
          (event) => event.t === 17 && event.reason.includes("expired"),
        ),
    ).toBe(true);
  });
  it.each(["baseline_sha256", "config_sha256", "surface_method"] as const)(
    "rejects mismatched %s without using asserted outcomes",
    (key) => {
      const session = createReplaySession(objectBundle()),
        emitted = request(session, 5);
      const result = {
        ...objectAssessment(emitted),
        [key]: key === "surface_method" ? undefined : "f".repeat(64),
      };
      try {
        session.submitAssessment(result);
      } catch {}
      expect(session.advanceTo(5).tables.T1.last_assessment).toBeNull();
      expect(session.advanceTo(5).tables.T1.status).toBe("unknown");
    },
  );
  it("stored raw placeholder results replay through the same comparator", () => {
    const bundle = objectBundle(),
      session = createReplaySession(bundle);
    const early = objectAssessment(request(session, 1));
    session.submitAssessment(early);
    const first = objectAssessment(request(session, 5));
    session.submitAssessment(first);
    const second = objectAssessment(request(session, 7));
    session.submitAssessment(second);
    bundle.assessment_requests = session.getAssessmentRequests();
    bundle.assessments = [early, first, second];
    const replay = createReplaySession(bundle);
    expect(replay.advanceTo(7).tables.T1.status).toBe("ready");
    expect(replay.advanceTo(17).tables.T1.status).toBe("unknown");
  });
});

describe("object-baseline live request expiry and capture-time readiness", () => {
  it("renews at availability time without moving expiry beyond capture +10", () => {
    const h = liveHarness();
    h.ready();
    h.feed(9);
    h.feed(13.9);
    const result = h.positive(9, 13.9);
    expect(result.snapshot.tables.T1.status).toBe("ready");
    expect(result.snapshot.tables.T1.surface_evidence_t).toBe(9);
    h.feed(18.9);
    expect(
      h.session.send({ op: "tick", t: 18.9 }).snapshot.tables.T1.status,
    ).toBe("ready");
    expect(h.feed(19).snapshot.tables.T1.status).toBe("unknown");
  });
  it("an exact-boundary delayed result cannot restore expired readiness and a new request can run", () => {
    const h = liveHarness();
    h.ready();
    h.feed(14.1);
    const old = h.requests.find((item) => item.t === 14.1)!;
    h.feed(17);
    const expired = h.session.send({
      op: "assessment",
      result: objectLiveAssessment(old, 17),
      now: 17,
    });
    expect(expired.snapshot.tables.T1.status).toBe("unknown");
    expect(
      expired.snapshot.events.some(
        (event) =>
          event.kind === "assessment_rejected" &&
          event.event_id === `result-${old.id}`,
      ),
    ).toBe(true);
    const fresh = h.requests.find((item) => item.t === 17)!;
    expect(fresh.generation).toBeGreaterThan(old.generation);
    expect(h.positive(17).snapshot.tables.T1.status).toBe("unknown");
    h.feed(19);
    expect(h.positive(19).snapshot.tables.T1.status).toBe("ready");
  });
  it("releases a dropped initial request and rejects its eventual result", () => {
    const h = liveHarness();
    h.feed(6.1);
    const first = h.requests[0];
    expect(h.requests.length).toBe(2);
    const result = h.session.send({
      op: "assessment",
      result: objectLiveAssessment(first, 6.1),
      now: 6.1,
    });
    expect(result.snapshot.tables.T1.last_assessment).toBeNull();
    expect(result.snapshot.tables.T1.status).toBe("unknown");
  });
  it.each([
    ["malformed", "unknown", "unobservable"],
    ["different", "needs_cleaning", "not_reset"],
  ])("does not retain Ready after %s evidence", (mode, status, outcome) => {
    const h = liveHarness();
    h.ready();
    h.feed(9);
    const emitted = h.requests.find((item) => item.t === 9)!;
    const result = objectLiveAssessment(emitted);
    if (mode === "malformed") result.object_evidence = undefined;
    else result.object_evidence!.reference.changed_fraction = 0.2;
    const rejected = h.session.send({
      op: "assessment",
      result: { ...result, outcome: "cleared_reset" },
      now: 9,
    });
    expect(rejected.snapshot.tables.T1.status).toBe(status);
    expect(rejected.snapshot.tables.T1.last_assessment?.outcome).toBe(outcome);
  });
  it("keeps occupied tables yellow and briefly waits in grey after departure before restoring red", () => {
    const h = liveHarness();
    h.feed(1);
    const request = h.requests[0];
    const dirty = h.session.send({
      op: "assessment",
      result: objectLiveAssessment(request, 1, highDifferenceEvidence()),
      now: 1,
    });
    expect(dirty.snapshot.tables.T1.status).toBe("needs_cleaning");
    const arrival = h.feed(1.1, 0, true).snapshot.tables.T1;
    expect(arrival.surface_state).toBe("unverified");
    expect(arrival.generation).toBeGreaterThan(
      dirty.snapshot.tables.T1.generation!,
    );
    expect(h.feed(6.1, 0, true).snapshot.tables.T1.status).toBe("occupied");
    const marked = h.session.send({
      op: "staff",
      event: {
        id: "clean-after-visit",
        t: 6.1,
        seq: 0,
        source: "staff",
        table_id: "T1",
        action: "needs_cleaning",
      },
    });
    expect(marked.snapshot.tables.T1.surface_state).toBe("needs_reset");
    expect(marked.snapshot.tables.T1.status).toBe("occupied");
    expect(h.feed(7.1).snapshot.tables.T1.people_state).toBe(
      "pending_departure",
    );
    expect(h.feed(7.1).snapshot.tables.T1.status).toBe("unknown");
    expect(h.requests).toHaveLength(1);
    expect(h.feed(7.2).snapshot.tables.T1.status).toBe("needs_cleaning");
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].t).toBe(7.2);
  });
  it("keeps one request per table while issuing work for every eligible table", () => {
    const h = liveHarness(objectLiveConfig(3));
    h.feed(5.9);
    expect(h.requests.map((item) => item.table_id)).toEqual(["T1", "T2", "T3"]);
  });
  it("preserves manual provenance and controls across automatic TTL expiry", () => {
    const h = liveHarness();
    h.ready();
    h.session.send({
      op: "staff",
      event: {
        id: "manual",
        t: 7,
        table_id: "T1",
        seq: 0,
        source: "staff",
        action: "force_status",
        status: "ready",
      },
    });
    const result = h.feed(17).snapshot.tables.T1;
    expect(result.status).toBe("ready");
    expect(result.automatic_status).toBe("unknown");
    expect(result.manual_override?.event_id).toBe("manual");
  });
  it.each(["matching", "high-difference"])(
    "blocks %s evidence captured before an arriving person invalidated its generation",
    (mode) => {
      const h = liveHarness();
      h.ready();
      h.feed(9);
      const pending = h.requests.find((item) => item.t === 9)!;
      h.session.send({
        op: "observation",
        observation: liveObservation(9.1, true),
        now: 9.1,
      });
      const result = h.session.send({
        op: "assessment",
        result: objectLiveAssessment(
          pending,
          9.1,
          mode === "matching" ? objectEvidence() : highDifferenceEvidence(),
        ),
        now: 9.1,
      });
      expect(result.snapshot.tables.T1.status).toBe("unknown");
      expect(
        result.snapshot.events.some(
          (item) => item.kind === "assessment_rejected",
        ),
      ).toBe(true);
    },
  );
});
