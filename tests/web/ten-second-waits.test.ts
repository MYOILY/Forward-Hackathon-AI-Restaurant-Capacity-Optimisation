import { describe, expect, it } from "vitest";
import type {
  Observation,
  ObjectSurfaceEvidence,
  ReplaySession,
  StaffEvent,
} from "../../shared/contracts";
import type {
  LiveAssessmentRequest,
  LiveReply,
} from "../../shared/live-contracts";
import { createReplaySession } from "../../web/src/engine";
import { createLiveSession } from "../../web/src/live-engine";
import { liveObservation } from "./live-fixtures";
import {
  objectAssessment,
  objectBundle,
  objectEvidence,
  objectLiveAssessment,
  objectLiveConfig,
} from "./object-fixtures";
import { person } from "./replay-fixtures";

type Change = (observation: Observation) => void;

function tenSecondBundle(change?: Change, staff: StaffEvent[] = []) {
  const bundle = objectBundle(40);
  bundle.rules.entry_s = 10;
  bundle.rules.exit_s = 10;
  bundle.staff_events = staff;
  bundle.observations.forEach((observation) => change?.(observation));
  return bundle;
}

function replayAssessment(
  session: ReplaySession,
  t: number,
  evidence = objectEvidence(),
) {
  session.advanceTo(t);
  const request = session.getAssessmentRequests().find((item) => item.t === t);
  expect(request, `expected a surface request at ${t}s`).toBeDefined();
  session.submitAssessment(objectAssessment(request!, evidence));
  return session.advanceTo(t).tables.T1;
}

function differentReference(): ObjectSurfaceEvidence {
  const evidence = objectEvidence();
  evidence.reference.changed_fraction = 0.1001;
  return evidence;
}

function liveHarness(change?: Change) {
  const config = objectLiveConfig();
  config.rules.entry_s = 10;
  config.rules.exit_s = 10;
  const session = createLiveSession(config),
    requests: LiveAssessmentRequest[] = [];
  let capture = -1,
    reply: LiveReply;
  function feed(t: number) {
    for (let index = capture + 1; index <= Math.round(t * 10); index++) {
      const observation = liveObservation(index / 10, false, config);
      change?.(observation);
      reply = session.send({
        op: "observation",
        observation,
        now: observation.t,
      });
      requests.push(...reply.requests);
      capture = index;
    }
    return reply!.snapshot.tables.T1;
  }
  function assess(t: number, evidence = objectEvidence()) {
    feed(t);
    const request = requests.find((item) => item.t === t);
    expect(request, `expected a live surface request at ${t}s`).toBeDefined();
    reply = session.send({
      op: "assessment",
      result: objectLiveAssessment(request!, t, evidence),
      now: t,
    });
    return reply.snapshot.tables.T1;
  }
  return { feed, assess, requests, session };
}

describe("custom ten-second occupancy/readiness waits with early dirty checks", () => {
  it("recorded arrival is grey at 9.9 seconds and yellow at exactly 10 seconds of the same person", () => {
    const session = createReplaySession(
      tenSecondBundle((observation) => person(observation)),
    );
    const pending = session.advanceTo(9.9).tables.T1;
    expect(pending.people_state).toBe("pending_arrival");
    expect(pending.status).toBe("unknown");
    expect(session.advanceTo(10).tables.T1.status).toBe("occupied");
    expect(session.getAssessmentRequests()).toEqual([]);
  });

  it("recorded departure turns grey, then permits red after one clear second without waiting for green eligibility", () => {
    const session = createReplaySession(
      tenSecondBundle((observation) => {
        if (observation.t < 12) person(observation);
      }),
    );
    expect(session.advanceTo(11.9).tables.T1.status).toBe("occupied");
    const departure = session.advanceTo(12).tables.T1;
    expect(departure.people_state).toBe("pending_departure");
    expect(departure.status).toBe("unknown");
    expect(session.advanceTo(12.9).tables.T1.status).toBe("unknown");
    expect(session.getAssessmentRequests()).toEqual([]);
    const dirty = replayAssessment(session, 13, differentReference());
    expect(dirty.people_state).toBe("pending_departure");
    expect(dirty.status).toBe("needs_cleaning");
    expect(dirty.last_assessment?.outcome).toBe("not_reset");
  });

  it("recorded opening stays grey until 10 seconds of vacancy and two matching captures at least 2 seconds apart", () => {
    const session = createReplaySession(tenSecondBundle());
    expect(session.advanceTo(0).tables.T1.status).toBe("unknown");
    expect(replayAssessment(session, 1).status).toBe("unknown");
    expect(session.advanceTo(9.9).tables.T1.status).toBe("unknown");
    expect(session.getAssessmentRequests().map((item) => item.t)).toEqual([1]);
    expect(replayAssessment(session, 10).status).toBe("unknown");
    expect(session.advanceTo(11.9).tables.T1.status).toBe("unknown");
    expect(session.getAssessmentRequests().map((item) => item.t)).toEqual([
      1, 10,
    ]);
    expect(replayAssessment(session, 12).status).toBe("ready");
    expect(session.getAssessmentRequests().map((item) => item.t)).toEqual([
      1, 10, 12,
    ]);
  });

  it.each(["exit", "different person", "invalid analysis"])(
    "restarts recorded arrival qualification after %s",
    (interruption) => {
      const session = createReplaySession(
        tenSecondBundle((observation) => {
          if (observation.t < 6) person(observation, "person-A");
          else if (observation.t === 6 && interruption === "different person")
            person(observation, "person-B");
          else if (observation.t >= 6.1)
            person(
              observation,
              interruption === "different person" ? "person-B" : "person-A",
            );
          if (observation.t === 6 && interruption === "invalid analysis") {
            observation.valid = false;
            observation.tables.T1 = "uncertain";
            observation.surface!.T1.visible = null;
          }
        }),
      );
      const qualifiesAt = interruption === "different person" ? 16 : 16.1;
      expect(session.advanceTo(qualifiesAt - 0.1).tables.T1.status).toBe(
        "unknown",
      );
      expect(session.advanceTo(qualifiesAt).tables.T1.status).toBe("occupied");
    },
  );

  it.each(["person returns", "invalid analysis"])(
    "restarts recorded vacancy wait when %s",
    (interruption) => {
      const session = createReplaySession(
        tenSecondBundle((observation) => {
          if (observation.t !== 6) return;
          if (interruption === "person returns") person(observation);
          else {
            observation.valid = false;
            observation.tables.T1 = "uncertain";
            observation.surface!.T1.visible = null;
          }
        }),
      );
      expect(replayAssessment(session, 1).status).toBe("unknown");
      expect(replayAssessment(session, 7.1).status).toBe("unknown");
      expect(session.advanceTo(16).tables.T1.status).toBe("unknown");
      expect(replayAssessment(session, 16.1).status).toBe("unknown");
      expect(replayAssessment(session, 18.1).status).toBe("ready");
    },
  );

  it("live occupancy retains the custom wait while a visible dirty departure can alert after one second", () => {
    const h = liveHarness((observation) => {
      if (observation.t < 12) person(observation);
    });
    expect(h.feed(9.9).status).toBe("unknown");
    expect(h.feed(10).status).toBe("occupied");
    const departure = h.feed(12);
    expect(departure.people_state).toBe("pending_departure");
    expect(departure.status).toBe("unknown");
    expect(h.feed(12.9).status).toBe("unknown");
    expect(h.requests).toEqual([]);
    expect(h.assess(13, differentReference()).status).toBe("needs_cleaning");
  });

  it("live opening needs 10 seconds of vacancy, then matching captures at 10 and 12 seconds", () => {
    const h = liveHarness();
    expect(h.assess(1).status).toBe("unknown");
    expect(h.feed(9.9).status).toBe("unknown");
    expect(h.requests.map((item) => item.t)).toEqual([1]);
    expect(h.assess(10).status).toBe("unknown");
    expect(h.feed(11.9).status).toBe("unknown");
    expect(h.requests.map((item) => item.t)).toEqual([1, 10]);
    expect(h.assess(12).status).toBe("ready");
  });

  it("manual colour overrides still take precedence over recorded and live waiting states", () => {
    const override: StaffEvent = {
      id: "manual-ready",
      table_id: "T1",
      t: 0,
      seq: 0,
      source: "staff",
      action: "force_status",
      status: "ready",
    };
    const change: Change = (observation) => {
      if (observation.t < 12) person(observation);
    };
    const replay = createReplaySession(tenSecondBundle(change, [override]));
    const live = liveHarness(change);
    live.feed(0);
    live.session.send({ op: "staff", event: override });
    for (const t of [9.9, 12]) {
      for (const state of [replay.advanceTo(t).tables.T1, live.feed(t)]) {
        expect(state.status).toBe("ready");
        expect(state.automatic_status).toBe("unknown");
        expect(state.manual_override?.event_id).toBe("manual-ready");
      }
    }
  });
});
