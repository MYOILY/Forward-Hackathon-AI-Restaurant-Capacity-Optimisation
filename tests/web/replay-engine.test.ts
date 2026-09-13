import { objectBundle as replayFixture } from "./object-fixtures";
import { describe, expect, it } from "vitest";
import type {
  AssessmentRequest,
  Bundle,
  ReplaySession,
  SurfaceAssessment,
} from "../../shared/contracts";
import * as production from "../../web/src/engine";
import { assessment, person } from "./replay-fixtures";

function session(bundle: Bundle): ReplaySession {
  const factory = (
    production as unknown as {
      createReplaySession: (bundle: Bundle) => ReplaySession;
    }
  ).createReplaySession;
  expect(
    factory,
    "replay must provide the public replay session API",
  ).toBeTypeOf("function");
  return factory(bundle);
}
function due(
  value: ReplaySession,
  t: number,
  tableId = "T1",
): AssessmentRequest {
  value.advanceTo(t);
  const request = value
    .getAssessmentRequests()
    .filter((item) => item.table_id === tableId && Math.abs(item.t - t) < 1e-6)
    .at(-1);
  expect(
    request,
    `expected ${tableId} readiness assessment at ${t}s`,
  ).toBeDefined();
  return request!;
}
function positive(value: ReplaySession, t: number) {
  value.submitAssessment(assessment(due(value, t)));
  return value.advanceTo(t);
}
function ready(value: ReplaySession) {
  positive(value, 5);
  return positive(value, 7);
}
function rejected(value: ReplaySession, result: SurfaceAssessment, t: number) {
  let reason = "";
  try {
    value.submitAssessment(result);
  } catch (error) {
    reason = String(error);
  }
  const snapshot = value.advanceTo(t);
  expect(
    reason.length > 0 ||
      snapshot.events.some(
        (event) =>
          event.kind === "assessment_rejected" && event.event_id === result.id,
      ),
    "invalid evidence needs an explicit rejection reason",
  ).toBe(true);
  expect(snapshot.tables.T1.status).not.toBe("ready");
}

describe("object/reference independently authored BDD scenarios", () => {
  it("B01 opening: early checks never grant readiness; matching captures at 5s and 7s make green", () => {
    const value = session(replayFixture());
    expect(value.advanceTo(4.9).tables.T1.status).toBe("unknown");
    expect(value.getAssessmentRequests().map((request) => request.t)).toEqual([
      1, 3,
    ]);
    const first = positive(value, 5);
    expect(first.tables.T1.people_state).toBe("vacant");
    expect(first.tables.T1.surface_state).toBe("unverified");
    expect(first.tables.T1.status).toBe("unknown");
    expect(value.advanceTo(6.9).tables.T1.status).toBe("unknown");
    const final = positive(value, 7);
    expect(final.tables.T1.status).toBe("ready");
    expect(final.tables.T1.surface_state).toBe("cleared_reset");
    expect(final.tables.T1.readiness_source).toBe("automatic");
  });
  it("B01 replay rejects invented opening readiness without two positive assessments", () => {
    const snapshot = production.replay(replayFixture(), 7);
    expect(snapshot.tables.T1.people_state).toBe("vacant");
    expect(snapshot.tables.T1.surface_state).toBe("unverified");
    expect(snapshot.tables.T1.status).toBe("unknown");
  });
  it("B02 arrival immediately invalidates ready; same-person dwell establishes yellow after 5s", () => {
    const value = session(
      replayFixture(30, (o) => {
        if (o.t >= 10 && o.t < 20) person(o);
      }),
    );
    const initial = ready(value);
    const arrival = value.advanceTo(10);
    expect(arrival.tables.T1.people_state).toBe("pending_arrival");
    expect(arrival.tables.T1.surface_state).toBe("unverified");
    expect(arrival.tables.T1.status).toBe("unknown");
    expect(arrival.tables.T1.generation!).toBeGreaterThan(
      initial.tables.T1.generation!,
    );
    expect(value.advanceTo(14.9).tables.T1.status).toBe("unknown");
    expect(value.advanceTo(15).tables.T1.status).toBe("occupied");
  });
  it("B03 walk-by under 5s cannot establish occupation or preserve old clearance", () => {
    const value = session(
      replayFixture(30, (o) => {
        if (o.t >= 10 && o.t < 11) person(o);
      }),
    );
    ready(value);
    const result = value.advanceTo(16);
    expect(
      result.events.some(
        (e) => e.kind === "transition" && e.status === "occupied",
      ),
    ).toBe(false);
    expect(result.tables.T1.surface_state).toBe("unverified");
    expect(result.tables.T1.status).not.toBe("ready");
  });
  it("B04 different passers cannot aggregate table dwell", () => {
    const value = session(
      replayFixture(25, (o) => {
        if (o.t >= 10 && o.t < 18)
          person(o, `clip:passer-${Math.floor((o.t - 10) / 2)}`);
      }),
    );
    expect(
      value
        .advanceTo(18)
        .events.some((e) => e.kind === "transition" && e.status === "occupied"),
    ).toBe(false);
  });
  it("B05 staff and diners follow the same dwell rule; labels cannot magically identify staff", () => {
    const brief = session(
      replayFixture(20, (o) => {
        if (o.t >= 1 && o.t < 5) person(o, "clip:staff");
      }),
    );
    expect(brief.advanceTo(6).events.some((e) => e.status === "occupied")).toBe(
      false,
    );
    const long = session(
      replayFixture(20, (o) => {
        if (o.t >= 1 && o.t < 12) person(o, "clip:staff");
      }),
    );
    expect(long.advanceTo(6).tables.T1.people_state).toBe("occupied");
  });
  it("B06 known occupied people stay yellow while the surface is unobservable", () => {
    const value = session(
      replayFixture(20, (o) => {
        if (o.t >= 1) {
          person(o);
          o.surface!.T1.visible = false;
        }
      }),
    );
    const result = value.advanceTo(8).tables.T1;
    expect(result.people_state).toBe("occupied");
    expect(result.surface_state).toBe("unverified");
    expect(result.status).toBe("occupied");
  });
  it("B07 one remaining qualified person keeps table occupied", () => {
    const value = session(
      replayFixture(25, (o) => {
        if (o.t >= 1 && o.t < 10) person(o, "clip:A");
        if (o.t >= 1 && o.t < 20) person(o, "clip:B");
      }),
    );
    expect(value.advanceTo(12).tables.T1.status).toBe("occupied");
  });
  it("B08 valid vacancy is pending at 4.9s and vacant at 5s, even if predicted track remains", () => {
    const value = session(
      replayFixture(20, (o) => {
        if (o.t >= 1 && o.t < 10) person(o);
        if (o.t >= 10 && o.t < 11) person(o, "clip:person-1", "T1", false);
      }),
    );
    expect(value.advanceTo(14.9).tables.T1.people_state).toBe(
      "pending_departure",
    );
    expect(value.advanceTo(14.9).tables.T1.status).toBe("unknown");
    expect(value.advanceTo(15).tables.T1.people_state).toBe("vacant");
    expect(value.advanceTo(15.1).tables.T1.status).toBe("unknown");
  });
  it("B09 empty dirty evidence produces red and retries within 5s", () => {
    const value = session(replayFixture());
    value.submitAssessment(assessment(due(value, 5), "not_reset"));
    const result = value.advanceTo(5).tables.T1;
    expect(result.people_state).toBe("vacant");
    expect(result.surface_state).toBe("needs_reset");
    expect(result.status).toBe("needs_cleaning");
    expect(value.advanceTo(10).tables.T1.status).toBe("needs_cleaning");
    expect(
      value.getAssessmentRequests().some((r) => r.t > 5 && r.t <= 10),
    ).toBe(true);
  });
  it("B10 clearing a dirty table requires three later positives spanning five seconds", () => {
    const value = session(replayFixture());
    value.submitAssessment(assessment(due(value, 5), "not_reset"));
    expect(positive(value, 7).tables.T1.status).not.toBe("ready");
    expect(positive(value, 9).tables.T1.status).not.toBe("ready");
    expect(positive(value, 13).tables.T1.status).toBe("ready");
  });
  it("B11 repeated assessment/capture cannot count twice; identical pixels from new captures can", () => {
    const value = session(replayFixture());
    const first = assessment(due(value, 5));
    value.submitAssessment(first);
    rejected(value, first, 5);
    const second = due(value, 7);
    value.submitAssessment(assessment(second));
    expect(value.advanceTo(7).tables.T1.status).toBe("ready");
  });
  it("B11 forged capture timestamp/identity and sub-two-second result cannot qualify", () => {
    const value = session(replayFixture());
    positive(value, 5);
    const next = due(value, 7);
    rejected(
      value,
      assessment(next, "cleared_reset", {
        id: "same-capture",
        frame_index: 50,
        t: 5,
      }),
      7,
    );
    rejected(
      value,
      assessment(next, "cleared_reset", {
        id: "too-soon",
        t: 6.9,
        frame_index: 69,
      }),
      7,
    );
  });
  it("B12 late results from an older table generation cannot restore green", () => {
    const value = session(
      replayFixture(20, (o) => {
        if (o.t >= 6 && o.t < 7) person(o);
      }),
    );
    const old = assessment(due(value, 5));
    value.advanceTo(6);
    rejected(value, old, 6);
  });
  it("B13 recovered track resumes observed dwell without counting missing time", () => {
    const value = session(
      replayFixture(15, (o) => {
        if ((o.t >= 1 && o.t < 3.5) || (o.t >= 4 && o.t < 10)) person(o);
        else if (o.t >= 3.5 && o.t < 4) person(o, "clip:person-1", "T1", false);
      }),
    );
    expect(value.advanceTo(6).tables.T1.status).not.toBe("occupied");
    expect(value.advanceTo(6.5).tables.T1.status).toBe("occupied");
  });
  it("B13 an observed exit ends the visit; reentry cannot reuse prior dwell", () => {
    const value = session(
      replayFixture(15, (o) => {
        if ((o.t >= 1 && o.t < 4) || (o.t >= 5 && o.t < 12)) person(o);
      }),
    );
    expect(value.advanceTo(7).tables.T1.status).not.toBe("occupied");
    expect(value.advanceTo(10).tables.T1.status).toBe("occupied");
  });
  it("B13 failed analysis cannot establish vacancy or retain clearance", () => {
    const value = session(
      replayFixture(20, (o) => {
        if (o.t >= 10) {
          o.valid = false;
          o.tables.T1 = "uncertain";
          o.surface!.T1.visible = null;
        }
      }),
    );
    ready(value);
    const result = value.advanceTo(16).tables.T1;
    expect(result.people_state).toBe("uncertain");
    expect(result.surface_state).toBe("unverified");
    expect(result.status).toBe("unknown");
  });
  it("B15 obstruction/change invalidates green once per sustained episode", () => {
    const value = session(
      replayFixture(25, (o) => {
        if (o.t >= 10 && o.t < 14) {
          o.surface!.T1.visible = false;
          o.surface!.T1.changed = true;
        }
      }),
    );
    const initial = ready(value);
    const start = value.advanceTo(10);
    const sustained = value.advanceTo(13);
    expect(start.tables.T1.status).toBe("unknown");
    expect(start.tables.T1.generation).toBe(sustained.tables.T1.generation);
    expect(start.tables.T1.generation!).toBeGreaterThan(
      initial.tables.T1.generation!,
    );
    value.advanceTo(15);
    expect(value.getAssessmentRequests().some((r) => r.t === 15)).toBe(true);
  });
  it("keeps a latched camera blocker visible after a later arrival and departure", () => {
    const value = session(
      replayFixture(25, (o) => {
        if (o.t >= 8) {
          o.surface!.T1.camera_moved = true;
          o.surface!.T1.visible = false;
        }
        if (o.t >= 10 && o.t < 16) person(o);
      }),
    );
    ready(value);
    const occupied = value.advanceTo(15).tables.T1;
    expect(occupied.status).toBe("occupied");
    expect(occupied.surface_reason).toMatch(
      /Camera movement prevents tabletop checks/,
    );
    const vacant = value.advanceTo(21).tables.T1;
    expect(vacant.status).toBe("unknown");
    expect(vacant.reason).toMatch(/Review camera alignment/);
    expect(vacant.can_confirm_cleaned).toBe(false);
    expect(
      value.getAssessmentRequests().filter((request) => request.t >= 8),
    ).toEqual([]);
  });
  it("B16 simultaneous arrival, surface result and staff action cannot log transient ready", () => {
    const bundle = replayFixture(20, (o) => {
      if (o.t >= 7) person(o);
    });
    bundle.staff_events = [
      {
        id: "staff-at-arrival",
        table_id: "T1",
        t: 7,
        action: "confirm_cleaned",
        source: "staff",
        seq: 0,
      },
    ];
    const value = session(bundle);
    positive(value, 5);
    const before = value.getAssessmentRequests().at(-1)!;
    value.advanceTo(7);
    try {
      value.submitAssessment(
        assessment({
          ...before,
          id: "forged-same-time",
          t: 7,
          frame_index: 70,
        }),
      );
    } catch {}
    const result = value.advanceTo(7);
    expect(result.tables.T1.status).toBe("unknown");
    expect(
      result.events.some(
        (e) => e.t === 7 && e.kind === "transition" && e.status === "ready",
      ),
    ).toBe(false);
    expect(
      result.events.some(
        (e) => e.event_id === "staff-at-arrival" && e.kind === "staff_rejected",
      ),
    ).toBe(true);
  });
  it("B17 pause freezes state, fast advance consumes all events, backward replay drops future evidence", () => {
    const value = session(replayFixture());
    ready(value);
    expect(value.advanceTo(7)).toEqual(value.advanceTo(7));
    expect(value.advanceTo(2).tables.T1.status).toBe("unknown");
    expect(value.getAssessmentRequests().map((request) => request.t)).toEqual([
      1,
    ]);
    value.reset();
    expect(value.advanceTo(0).tables.T1.status).toBe("unknown");
  });
  it.each([1, 3, 7, 15, 30])(
    "B18 supports %i tables with no chair/capacity metadata",
    (count) => {
      const value = session(replayFixture(10, undefined, count));
      const result = value.advanceTo(5);
      expect(Object.keys(result.tables)).toHaveLength(count);
      expect(value.getAssessmentRequests()).toHaveLength(count * 3);
    },
  );
  it.each(["video_sha256", "geometry_sha256", "reference_sha256"] as const)(
    "B19 rejects assessment %s identity mismatch",
    (field) => {
      const value = session(replayFixture());
      const request = due(value, 5);
      rejected(
        value,
        assessment(request, "cleared_reset", { [field]: "f".repeat(64) }),
        5,
      );
    },
  );
  it("B19 unconfirmed/missing reference cannot produce automatic assessment requests", () => {
    for (const mode of ["missing", "unconfirmed"]) {
      const bundle = replayFixture();
      if (mode === "missing") {
        bundle.tables[0].reference = null;
        delete bundle.tables[0].object_baseline;
      } else bundle.tables[0].reference!.confirmed_clean = false;
      const value = session(bundle);
      expect(value.advanceTo(20).tables.T1.status).not.toBe("ready");
      expect(value.getAssessmentRequests()).toEqual([]);
    }
  });
});

it.each([null, {}, { id: "malformed" }])(
  "B19 malformed assessment request is rejected before replay: %j",
  (request) => {
    const bundle = replayFixture();
    bundle.assessment_requests = [request] as unknown as AssessmentRequest[];
    expect(() => production.replay(bundle, 0)).toThrow();
  },
);

it("B19 duplicate assessment request IDs are rejected at load", () => {
  const bundle = replayFixture();
  const value = session(bundle);
  const request = due(value, 5);
  bundle.assessment_requests = [request, { ...request, t: 7, frame_index: 70 }];
  expect(() => production.replay(bundle, 0)).toThrow();
});
