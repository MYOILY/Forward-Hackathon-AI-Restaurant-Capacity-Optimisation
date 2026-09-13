import { describe, it, expect } from "vitest";
import type { StaffEvent, TableState } from "../../shared/contracts";
import { createReplaySession, replay } from "../../web/src/engine";
import { replayFixture, person } from "./replay-fixtures";
import { legacyFixture } from "./fixtures";

const override = (t = 6, source = "staff"): StaffEvent =>
  ({
    id: `override-${t}`,
    table_id: "T1",
    t,
    action: "force_cleaned",
    source,
    seq: 0,
  }) as StaffEvent;
const canForce = (state: TableState) =>
  (state as TableState & { can_force_cleaned: boolean }).can_force_cleaned;

describe("explicit staff Force clean override", () => {
  it("permits stable vacant surface override without a visible surface, reference or model result", () => {
    const bundle = replayFixture(20, (o) => {
      o.surface!.T1.visible = false;
      o.surface!.T1.camera_moved = true;
    });
    bundle.tables[0].reference = null;
    const before = replay(bundle, 6);
    expect(before.tables.T1.people_state).toBe("vacant");
    expect(before.tables.T1.can_confirm_cleaned).toBe(false);
    expect(canForce(before.tables.T1)).toBe(true);
    const after = replay(bundle, 6, [override()]);
    expect(after.tables.T1.status).toBe("ready");
    expect(after.tables.T1.surface_state).toBe("cleared_reset");
    expect(after.tables.T1.readiness_source).toBe("staff_override");
    expect(after.tables.T1.people_state).toBe("vacant");
    expect(
      after.events.some(
        (event) =>
          event.event_id === "override-6" &&
          event.kind === "staff_accepted" &&
          /override/i.test(event.reason),
      ),
    ).toBe(true);
  });
  it("rejects a force action for an occupied table without changing its people state", () => {
    const bundle = replayFixture(20, (o) => {
      if (o.t >= 1) person(o);
    });
    const result = replay(bundle, 7, [override(7)]);
    expect(result.tables.T1.status).toBe("occupied");
    expect(result.tables.T1.people_state).toBe("occupied");
    expect(canForce(result.tables.T1)).toBe(false);
    expect(
      result.events.some(
        (event) =>
          event.event_id === "override-7" && event.kind === "staff_rejected",
      ),
    ).toBe(true);
  });
  it.each([
    "initial uncertain",
    "pending arrival",
    "pending departure",
    "stale observation",
  ])("cannot override %s person evidence", (mode) => {
    const bundle = replayFixture(20, (o) => {
      if (mode === "pending arrival" && o.t >= 1) person(o);
      if (mode === "pending departure" && o.t >= 1 && o.t < 10) person(o);
    });
    const t =
      mode === "pending departure" ? 11 : mode === "stale observation" ? 8 : 2;
    if (mode === "stale observation")
      bundle.observations = bundle.observations.filter((o) => o.t <= 6);
    const result = replay(bundle, t, [override(t)]);
    expect(result.tables.T1.status).not.toBe("ready");
    expect(canForce(result.tables.T1)).toBe(false);
    expect(result.events.some((event) => event.kind === "staff_rejected")).toBe(
      true,
    );
  });
  it("a new arrival invalidates forced clearance and preserves normal dwell timing", () => {
    const bundle = replayFixture(20, (o) => {
      o.surface!.T1.visible = false;
      if (o.t >= 8) person(o);
    });
    const value = createReplaySession(bundle, [override()]);
    expect(value.advanceTo(6).tables.T1.readiness_source).toBe(
      "staff_override",
    );
    expect(value.advanceTo(8).tables.T1.status).toBe("unknown");
    expect(value.advanceTo(8).tables.T1.readiness_source).toBeNull();
    expect(value.advanceTo(13).tables.T1.status).toBe("occupied");
  });
  it("surface change invalidates the override; paused replay and backward/restart keep source-time semantics", () => {
    const bundle = replayFixture(20, (o) => {
      o.surface!.T1.visible = false;
      if (o.t >= 9) o.surface!.T1.changed = true;
    });
    const value = createReplaySession(bundle, [override()]);
    const ready = value.advanceTo(6);
    expect(ready.tables.T1.status).toBe("ready");
    expect(value.advanceTo(6)).toEqual(ready);
    expect(value.advanceTo(9).tables.T1.status).toBe("unknown");
    expect(value.advanceTo(5).tables.T1.status).toBe("unknown");
    expect(value.advanceTo(6).tables.T1.status).toBe("ready");
    value.reset();
    expect(value.advanceTo(6).tables.T1.status).toBe("unknown");
  });
  it("schema1 and setup events cannot silently acquire force-override meaning", () => {
    expect(() => replay(legacyFixture(), 6, [override()])).toThrow();
    expect(() => replay(replayFixture(), 6, [override(6, "setup")])).toThrow();
  });
});
