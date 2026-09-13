import { describe, it, expect } from "vitest";
import { createLiveSession } from "../../web/src/live-engine";
import type {
  LiveReply,
  LiveAssessmentRequest,
} from "../../shared/live-contracts";
import { liveConfig, liveObservation, livePositive } from "./live-fixtures";

function feed(
  session: ReturnType<typeof createLiveSession>,
  start: number,
  end: number,
  occupied = false,
  delay = 0,
): LiveReply {
  let reply: LiveReply | undefined;
  for (
    let index = Math.round(start * 10);
    index <= Math.round(end * 10);
    index++
  ) {
    const observation = liveObservation(index / 10, occupied);
    // This availability fixture starts with an obstructed tabletop. Its first
    // continuous visible second ends at five; separate policy tests cover early checks.
    observation.surface!.T1.visible = index >= 40;
    reply = session.send({
      op: "observation",
      observation,
      now: index / 10 + delay,
    });
  }
  return reply!;
}
describe("independent live source-time and availability contract", () => {
  it("M01 detection-only never requests surface inference or invents cleared readiness", () => {
    const config = liveConfig(true);
    const session = createLiveSession(config);
    const requests: LiveAssessmentRequest[] = [];
    for (let i = 0; i <= 80; i++) {
      const value = session.send({
        op: "observation",
        observation: liveObservation(i / 10, false, config),
        now: i / 10,
      });
      requests.push(...value.requests);
    }
    const table = session.send({ op: "tick", t: 8 }).snapshot.tables.T1;
    expect(table.people_state).toBe("vacant");
    expect(table.surface_state).toBe("unverified");
    expect(table.status).toBe("unknown");
    expect(requests).toEqual([]);
  });
  it("L01 observed capture duration controls 5s dwell and latency cannot qualify early", () => {
    const session = createLiveSession(liveConfig(true));
    expect(
      feed(session, 0, 4.9, true, 0.3).snapshot.tables.T1.people_state,
    ).toBe("pending_arrival");
    expect(feed(session, 5, 5, true, 0.3).snapshot.tables.T1.people_state).toBe(
      "occupied",
    );
  });
  it("L01 a fresh delayed capture is accepted after a later heartbeat without rewinding display time", () => {
    const session = createLiveSession(liveConfig(true));
    feed(session, 0, 0);
    session.send({ op: "tick", t: 0.3 });
    const result = session.send({
      op: "observation",
      observation: liveObservation(0.2, true),
      now: 0.4,
    });
    expect(result.snapshot.t).toBe(0.4);
    expect(result.snapshot.tables.T1.people_state).toBe("pending_arrival");
  });
  it("L05 heartbeat alone expires person evidence independently of UI or new frames", () => {
    const session = createLiveSession(liveConfig(true));
    feed(session, 0, 5, true);
    const result = session.send({ op: "tick", t: 6.1 });
    expect(result.snapshot.tables.T1.people_state).toBe("uncertain");
    expect(result.snapshot.tables.T1.automatic_status).toBe("unknown");
  });
  it("L02 missing frames never add observed person dwell", () => {
    const session = createLiveSession(liveConfig(true));
    feed(session, 0, 2, true);
    session.send({ op: "tick", t: 3.2 });
    expect(
      feed(session, 3.3, 6.2, true).snapshot.tables.T1.people_state,
    ).not.toBe("occupied");
  });
  it("L03 L04 late positive results apply now with capture separation and no retrospective green", () => {
    const session = createLiveSession(liveConfig());
    const first = feed(session, 0, 5).requests[0];
    expect(first.t).toBe(5);
    feed(session, 5.1, 5.4);
    const a = session.send({
      op: "assessment",
      result: livePositive(first, 5.4),
      now: 5.4,
    });
    expect(a.snapshot.tables.T1.status).toBe("unknown");
    const second = feed(session, 5.5, 7).requests[0];
    expect(second.t).toBe(7);
    feed(session, 7.1, 7.8);
    const b = session.send({
      op: "assessment",
      result: livePositive(second, 7.8),
      now: 7.8,
    });
    expect(b.snapshot.tables.T1.status).toBe("ready");
    expect(
      b.snapshot.events
        .filter((e) => e.kind === "transition" && e.status === "ready")
        .map((e) => e.t),
    ).toEqual([7.8]);
  });
  it("L03 one outstanding request prevents duplicate work and expiry releases its slot", () => {
    const session = createLiveSession(liveConfig());
    const request = feed(session, 0, 5).requests[0];
    expect(request).toBeDefined();
    const seen: LiveAssessmentRequest[] = [];
    for (let i = 51; i <= 99; i++)
      seen.push(
        ...session.send({
          op: "observation",
          observation: liveObservation(i / 10),
          now: i / 10,
        }).requests,
      );
    expect(seen).toEqual([]);
    const after = feed(session, 10, 10.2);
    expect(after.snapshot.tables.T1.status).toBe("unknown");
    const expired = session.send({
      op: "assessment",
      result: livePositive(request, 10.2),
      now: 10.2,
    });
    expect(expired.snapshot.tables.T1.status).not.toBe("ready");
    expect(
      expired.snapshot.events.some((e) => e.kind === "assessment_rejected"),
    ).toBe(true);
  });
  it.each([
    "generation",
    "epoch",
    "calibration_id",
    "frame_sha256",
    "reference_sha256",
  ])("L03 rejects a late result with wrong %s identity", (key) => {
    const session = createLiveSession(liveConfig());
    const request = feed(session, 0, 5).requests[0];
    const result = livePositive(request, 5.2) as unknown as Record<
      string,
      unknown
    >;
    result[key] =
      typeof result[key] === "number"
        ? (result[key] as number) + 1
        : "wrong-identity";
    feed(session, 5.1, 5.2);
    const reply = session.send({
      op: "assessment",
      result: result as unknown as ReturnType<typeof livePositive>,
      now: 5.2,
    });
    expect(reply.snapshot.tables.T1.status).not.toBe("ready");
    expect(
      reply.snapshot.events.some((e) => e.kind === "assessment_rejected"),
    ).toBe(true);
  });
  it("L05 manual colour survives source loss while observed state becomes uncertain", () => {
    const session = createLiveSession(liveConfig(true));
    feed(session, 0, 5, true);
    session.send({
      op: "staff",
      event: {
        id: "manual-green",
        table_id: "T1",
        t: 5,
        seq: 0,
        source: "staff",
        action: "force_status",
        status: "ready",
      },
    });
    const result = session.send({ op: "tick", t: 6.1 });
    expect(result.snapshot.tables.T1.status).toBe("ready");
    expect(result.snapshot.tables.T1.manual_override?.event_id).toBe(
      "manual-green",
    );
    expect(result.snapshot.tables.T1.automatic_status).toBe("unknown");
  });
  it("L07 rename preserves evidence; disable/re-enable resets only that table and removes interactive colours", () => {
    const session = createLiveSession(liveConfig(true));
    feed(session, 0, 5, true);
    session.send({ op: "rename", table_id: "T1", label: "Window 1", t: 5 });
    expect(
      session.send({ op: "tick", t: 5 }).snapshot.tables.T1.people_state,
    ).toBe("occupied");
    session.send({
      op: "staff",
      event: {
        id: "manual",
        table_id: "T1",
        t: 5,
        seq: 0,
        source: "staff",
        action: "force_status",
        status: "ready",
      },
    });
    expect(
      session.send({ op: "monitoring", table_id: "T1", enabled: false, t: 5 })
        .snapshot.tables.T1.monitoring_enabled,
    ).toBe(false);
    const enabled = session.send({
      op: "monitoring",
      table_id: "T1",
      enabled: true,
      t: 5.1,
    });
    expect(enabled.snapshot.tables.T1.people_state).toBe("uncertain");
    expect(enabled.snapshot.tables.T1.manual_override).toBeNull();
  });
  it("L08 stop invalidates readiness and yields a bounded event history", () => {
    const session = createLiveSession(liveConfig(true));
    feed(session, 0, 5, true);
    for (let i = 0; i < 250; i++)
      session.send({
        op: "staff",
        event: {
          id: `manual-${i}`,
          table_id: "T1",
          t: 5 + i / 1000,
          seq: i,
          source: "staff",
          action: "force_status",
          status: i % 2 ? "ready" : "occupied",
        },
      });
    const result = session.send({ op: "stop", t: 5.3 });
    expect(result.snapshot.stopped).toBe(true);
    expect(result.snapshot.tables.T1.automatic_status).toBe("unknown");
    expect(result.snapshot.events.length).toBeLessThanOrEqual(200);
    expect(result.requests).toEqual([]);
  });
  it("L01 newly available fresh capture is processed before freshness at the same application time", () => {
    const session = createLiveSession(liveConfig(true));
    feed(session, 0, 0, true);
    session.send({
      op: "observation",
      observation: liveObservation(0.9, true),
      now: 1.1,
    });
    expect(feed(session, 1, 5, true, 0.2).snapshot.tables.T1.people_state).toBe(
      "occupied",
    );
  });
  it("L03 simultaneous arrival reconciles final state and logs for an earlier-delivered Force clean command", () => {
    const session = createLiveSession(liveConfig(true));
    feed(session, 0, 5);
    session.send({
      op: "staff",
      event: {
        id: "same-time-clean",
        table_id: "T1",
        t: 5.1,
        seq: 0,
        source: "staff",
        action: "force_cleaned",
      },
    });
    const result = session.send({
      op: "observation",
      observation: liveObservation(5.1, true),
      now: 5.1,
    });
    expect(result.snapshot.tables.T1.status).toBe("unknown");
    expect(
      result.snapshot.events.some(
        (e) => e.kind === "staff_accepted" && e.event_id === "same-time-clean",
      ),
    ).toBe(false);
    expect(
      result.snapshot.events.some(
        (e) => e.kind === "staff_rejected" && e.event_id === "same-time-clean",
      ),
    ).toBe(true);
    expect(
      result.snapshot.events.some(
        (e) => e.kind === "transition" && e.status === "ready" && e.t === 5.1,
      ),
    ).toBe(false);
  });
  it("L07 re-enabled table ignores an in-flight capture from before its new monitoring epoch", () => {
    const session = createLiveSession(liveConfig(true));
    feed(session, 0, 5, true);
    session.send({ op: "monitoring", table_id: "T1", enabled: false, t: 5.2 });
    session.send({ op: "monitoring", table_id: "T1", enabled: true, t: 5.3 });
    const old = session.send({
      op: "observation",
      observation: liveObservation(5.1, true),
      now: 5.4,
    });
    expect(old.snapshot.tables.T1.people_state).toBe("uncertain");
    expect(
      feed(session, 5.4, 10.3, true, 0.1).snapshot.tables.T1.people_state,
    ).toBe("pending_arrival");
    expect(
      feed(session, 10.4, 10.4, true, 0.1).snapshot.tables.T1.people_state,
    ).toBe("occupied");
  });
});
