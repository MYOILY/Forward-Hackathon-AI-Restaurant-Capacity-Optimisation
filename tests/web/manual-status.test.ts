import { objectBundle } from "./object-fixtures";
import { describe, it, expect } from "vitest";
import type { StaffEvent, Status } from "../../shared/contracts";
import { createReplaySession, replay } from "../../web/src/engine";
import { replayFixture, person } from "./replay-fixtures";
import { legacyFixture } from "./fixtures";

const force = (status: Status, t = 7): StaffEvent => ({
  id: `manual-${status}-${t}`,
  table_id: "T1",
  t,
  action: "force_status",
  status,
  source: "staff",
  seq: 0,
});
const auto = (t = 9): StaffEvent => ({
  id: `auto-${t}`,
  table_id: "T1",
  t,
  action: "clear_status_override",
  source: "staff",
  seq: 1,
});

describe("manual service colours and monitoring scope", () => {
  it.each(["unknown", "occupied", "needs_cleaning", "ready"] as Status[])(
    "forces %s while preserving conflicting observed evidence",
    (status) => {
      const bundle = replayFixture(20, (o) => {
        if (status !== "occupied" && o.t >= 1) person(o);
      });
      const baseline = replay(bundle, 7).tables.T1;
      expect(baseline.status).not.toBe(status);
      const result = replay(bundle, 7, [force(status)]);
      expect(result.tables.T1.status).toBe(status);
      expect(result.tables.T1.automatic_status).toBe(baseline.status);
      expect(result.tables.T1.people_state).toBe(baseline.people_state);
      expect(result.tables.T1.surface_state).toBe(baseline.surface_state);
      expect(result.tables.T1.manual_override).toEqual({
        status,
        t: 7,
        event_id: `manual-${status}-7`,
      });
      expect(
        result.events.some(
          (e) =>
            e.kind === "staff_accepted" && e.event_id === `manual-${status}-7`,
        ),
      ).toBe(true);
    },
  );
  it("manual green persists through person, surface and failed-analysis changes until Auto", () => {
    const bundle = replayFixture(20, (o) => {
      if (o.t >= 8) person(o);
      if (o.t >= 10) {
        o.valid = false;
        o.tables.T1 = "uncertain";
        o.surface!.T1.visible = null;
      }
    });
    const value = createReplaySession(bundle, [force("ready", 6), auto(12)]);
    expect(value.advanceTo(8).tables.T1.status).toBe("ready");
    const uncertain = value.advanceTo(11).tables.T1;
    expect(uncertain.status).toBe("ready");
    expect(uncertain.people_state).toBe("uncertain");
    expect(uncertain.automatic_status).toBe("unknown");
    expect(value.advanceTo(12).tables.T1.manual_override).toBeNull();
    expect(value.advanceTo(12).tables.T1.status).toBe("unknown");
  });
  it("Auto, source-time backseek and restart reconstruct without future/manual colour leakage", () => {
    const bundle = replayFixture(20, (o) => {
      if (o.t >= 1) person(o);
    });
    const value = createReplaySession(bundle, [force("ready"), auto()]);
    expect(value.advanceTo(8).tables.T1.status).toBe("ready");
    expect(value.advanceTo(9).tables.T1.status).toBe("occupied");
    expect(value.advanceTo(9).tables.T1.manual_override).toBeNull();
    expect(value.advanceTo(6).tables.T1.status).toBe("occupied");
    expect(value.advanceTo(8).tables.T1.status).toBe("ready");
    value.reset();
    expect(value.advanceTo(8).tables.T1.status).toBe("occupied");
  });
  it("disabled tables keep their identity but emit no assessment requests or active service colour", () => {
    const bundle = objectBundle(20, undefined, 2);
    bundle.tables[1].monitoring_enabled = false;
    const value = createReplaySession(bundle);
    const result = value.advanceTo(7);
    expect(Object.keys(result.tables)).toEqual(["T1", "T2"]);
    expect(result.tables.T2.monitoring_enabled).toBe(false);
    expect(result.tables.T2.status).toBe("unknown");
    expect(result.tables.T1.monitoring_enabled).toBe(true);
    expect(
      value
        .getAssessmentRequests()
        .some((request) => request.table_id === "T2"),
    ).toBe(false);
    expect(
      value
        .getAssessmentRequests()
        .some((request) => request.table_id === "T1"),
    ).toBe(true);
    bundle.tables[1].monitoring_enabled = true;
    const enabled = createReplaySession(bundle);
    expect(enabled.advanceTo(7).tables.T2.monitoring_enabled).toBe(true);
    expect(
      enabled
        .getAssessmentRequests()
        .some((request) => request.table_id === "T2"),
    ).toBe(true);
  });
  it("disabled table cannot be assigned a manual colour", () => {
    const bundle = replayFixture();
    bundle.tables[0].monitoring_enabled = false;
    const result = replay(bundle, 7, [force("ready")]);
    expect(result.tables.T1.status).toBe("unknown");
    expect(result.tables.T1.manual_override).toBeNull();
    expect(result.events.some((event) => event.kind === "staff_rejected")).toBe(
      true,
    );
  });
  it.each(["missing", "invalid", "setup", "clear-with-status"])(
    "rejects invalid colour command %s",
    (mode) => {
      const event = force("ready") as unknown as Record<string, unknown>;
      if (mode === "missing") delete event.status;
      if (mode === "invalid") event.status = "blue";
      if (mode === "setup") event.source = "setup";
      if (mode === "clear-with-status") event.action = "clear_status_override";
      expect(() =>
        replay(replayFixture(), 8, [event as unknown as StaffEvent]),
      ).toThrow();
    },
  );
  it("schema1 rejects the new staff actions and monitoring switch", () => {
    expect(() => replay(legacyFixture(), 8, [force("ready")])).toThrow();
    expect(() => replay(legacyFixture(), 9, [auto()])).toThrow();
    const legacy = legacyFixture();
    legacy.tables[0].monitoring_enabled = false;
    expect(() => replay(legacy, 8)).toThrow();
  });
});
