import { describe, expect, it } from "vitest";
import type { ReplaySession } from "../../shared/contracts";
import { createReplaySession } from "../../web/src/engine";
import { createLiveSession } from "../../web/src/live-engine";
import { objectSurfaceTiming } from "../../web/src/object-surface";
import { validateBundle } from "../../web/src/validation";
import {
  objectAssessment,
  objectBundle,
  objectEvidence,
  objectLiveConfig,
} from "./object-fixtures";

function demoBundle() {
  const bundle = objectBundle(10);
  bundle.provenance = "ai_generated_video";
  bundle.rules = {
    entry_s: 5 / 3,
    exit_s: 5 / 3,
    assessment_separation_s: 2 / 3,
    assessment_retry_s: 5 / 3,
    gap_s: 1,
    track_grace_s: 1,
    demo_timing_scale: 3,
  };
  bundle.analysis.timing_profile = "demo_fast_3x";
  bundle.analysis.playback_rate = 1;
  return bundle;
}

function requestAt(session: ReplaySession, t: number) {
  session.advanceTo(t);
  const request = session
    .getAssessmentRequests()
    .find((item) => Math.abs(item.t - t) < 1e-7);
  expect(request, `expected source capture at ${t}`).toBeDefined();
  return request!;
}

function submitDemo(
  session: ReplaySession,
  t: number,
  evidence = objectEvidence(),
) {
  const request = requestAt(session, t);
  session.submitAssessment({
    ...objectAssessment(request, evidence),
    timing_profile: request.timing_profile,
  });
  return session.advanceTo(t);
}

describe("explicit 3x decision waits for the 1x AI video demo", () => {
  it("checks early without counting that clean capture toward initial readiness and tags the evidence identity", () => {
    const bundle = demoBundle(),
      session = createReplaySession(bundle);
    session.advanceTo(0.3);
    expect(session.getAssessmentRequests()).toEqual([]);
    const early = requestAt(session, 0.4);
    expect(early.timing_profile).toBe("demo_fast_3x");
    expect(early.config_sha256).toBe(
      bundle.tables[0].object_baseline!.config_sha256,
    );
    session.submitAssessment({
      ...objectAssessment(early),
      timing_profile: early.timing_profile,
    });
    expect(session.advanceTo(0.4).tables.T1.status).toBe("unknown");
    expect(session.advanceTo(1.6).tables.T1.people_state).not.toBe("vacant");
    expect(submitDemo(session, 1.7).tables.T1.status).toBe("unknown");
    expect(session.advanceTo(2.3).tables.T1.status).toBe("unknown");
    expect(submitDemo(session, 2.4).tables.T1.status).toBe("ready");
    expect(session.getAssessmentRequests().map((item) => item.t)).toEqual([
      0.4, 1.7, 2.4,
    ]);
    expect(bundle.analysis.playback_rate).toBe(1);
    expect(bundle.observations.at(-1)!.t).toBe(10);
  });
  it("scales periodic checks and capture-time expiry consistently without changing image thresholds", () => {
    const bundle = demoBundle(),
      session = createReplaySession(bundle);
    for (const t of [0.4, 1.7, 2.4]) submitDemo(session, t);
    session.advanceTo(3);
    expect(session.getAssessmentRequests().at(-1)!.t).toBe(2.4);
    expect(requestAt(session, 3.1).timing_profile).toBe("demo_fast_3x");
    expect(objectSurfaceTiming(bundle.rules)).toEqual({
      recheck_s: 2 / 3,
      clearance_ttl_s: 10 / 3,
    });
    expect(session.advanceTo(2.4 + 10 / 3 - 0.001).tables.T1.status).toBe(
      "ready",
    );
    expect(session.advanceTo(2.4 + 10 / 3).tables.T1.status).toBe("unknown");
  });
  it("keeps a dirty table red until repeated clean captures also span the scaled confirmation period", () => {
    const session = createReplaySession(demoBundle());
    for (const t of [0.4, 1.7, 2.4]) submitDemo(session, t);
    const dirty = objectEvidence();
    dirty.reference.changed_fraction = 0.2;
    expect(submitDemo(session, 3.1, dirty).tables.T1.status).toBe(
      "needs_cleaning",
    );
    for (const t of [3.8, 4.5, 5.2])
      expect(submitDemo(session, t).tables.T1.status).toBe("needs_cleaning");
    // Three captures 0.7 s apart span only 1.4 s, short of the required 5/3 s.
    expect(submitDemo(session, 5.9).tables.T1.status).toBe("ready");
    expect(session.getAssessmentRequests().map((item) => item.t)).toEqual([
      0.4, 1.7, 2.4, 3.1, 3.8, 4.5, 5.2, 5.9,
    ]);
  });
  it("qualifies a single observed visitor only after the shortened source-time dwell", () => {
    const bundle = demoBundle();
    for (const observation of bundle.observations) {
      observation.tables.T1 = "present";
      observation.tracks = [
        {
          track_id: "demo-person",
          box: [0.2, 0.1, 0.6, 0.8],
          score: 0.9,
          observed: true,
          table_id: "T1",
          candidate_table_ids: ["T1"],
        },
      ];
    }
    const session = createReplaySession(bundle);
    expect(session.advanceTo(1.6).tables.T1.people_state).toBe(
      "pending_arrival",
    );
    expect(session.advanceTo(1.7).tables.T1.people_state).toBe("occupied");
  });
  it("cannot apply ordinary evidence to accelerated requests", () => {
    const session = createReplaySession(demoBundle()),
      request = requestAt(session, 0.4);
    session.submitAssessment(objectAssessment(request));
    expect(session.advanceTo(0.4).tables.T1.last_assessment).toBeNull();
    expect(
      session
        .advanceTo(0.4)
        .events.some((event) => event.kind === "assessment_rejected"),
    ).toBe(true);
  });
  it.each([
    "real",
    "legacy",
    "missing-label",
    "unknown-scale",
    "changed-gap",
    "missing-profile",
    "unmarked-short-waits",
  ])("rejects an invalid or unlabelled demo policy: %s", (mode) => {
    const bundle = demoBundle();
    if (mode === "real") bundle.provenance = "real_video";
    else if (mode === "legacy") {
      Object.assign(bundle, { schema_version: 1, policy: "legacy_v1" });
    } else if (mode === "missing-label") delete bundle.analysis.timing_profile;
    else if (mode === "unknown-scale")
      Object.assign(bundle.rules, { demo_timing_scale: 2 });
    else if (mode === "changed-gap") bundle.rules.gap_s = 1 / 3;
    else if (mode === "missing-profile") delete bundle.rules.demo_timing_scale;
    else {
      delete bundle.rules.demo_timing_scale;
      delete bundle.analysis.timing_profile;
    }
    expect(() => validateBundle(bundle)).toThrow();
  });
  it("forbids accelerated profiles on live cameras while preserving standard timing", () => {
    const config = objectLiveConfig();
    config.rules = demoBundle().rules;
    expect(() => createLiveSession(config)).toThrow(
      /not permitted for live cameras/,
    );
    expect(objectSurfaceTiming(objectBundle().rules)).toEqual({
      recheck_s: 2,
      clearance_ttl_s: 10,
    });
    const normal = createReplaySession(objectBundle());
    normal.advanceTo(0.9);
    expect(normal.getAssessmentRequests()).toEqual([]);
    const early = requestAt(normal, 1);
    expect(early.timing_profile).toBeUndefined();
    normal.submitAssessment(objectAssessment(early));
    expect(normal.advanceTo(4.9).tables.T1.people_state).not.toBe("vacant");
    expect(normal.advanceTo(4.9).tables.T1.status).toBe("unknown");
    expect(normal.getAssessmentRequests().map((item) => item.t)).toEqual([1]);
  });
});
