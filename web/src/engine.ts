import type {
  AssessmentRequest,
  Bundle,
  LogEvent,
  Observation,
  ReplaySession,
  Snapshot,
  StaffEvent,
  Status,
  SurfaceAssessment,
  TableState,
} from "../../shared/contracts";
import {
  validateAssessment,
  validateBundle,
  validateStaffEvents,
  validateObservation,
  validateFrameCapture,
  sameCapture,
} from "./validation";
import { createRuleCore, type RuleMemory } from "./rule-core";
import {
  approvedObjectBaseline,
  normalizeObjectAssessment,
  objectSurfaceTiming,
  usesObjectSurface,
} from "./object-surface";

const EPS = 1e-7;
/** Shared source-time executor for UI, evaluator, and the Python assessment coordinator. */
export function createReplaySession(
  bundle: Bundle,
  initialStaff: StaffEvent[] = [],
): ReplaySession {
  validateBundle(bundle);
  const surfaceTiming = objectSurfaceTiming(bundle.rules);
  const timingProfile =
    bundle.rules.demo_timing_scale === 3
      ? ("demo_fast_3x" as const)
      : undefined;
  const tableIds = new Set(bundle.tables.map((table) => table.id));
  const separation = bundle.rules.assessment_separation_s ?? 2;
  let extraStaff = [...initialStaff];
  const submitted: SurfaceAssessment[] = [];
  let core: ReturnType<typeof createRuleCore<SurfaceAssessment>>,
    memories: RuleMemory<SurfaceAssessment>[],
    byId: Record<string, RuleMemory<SurfaceAssessment>>,
    staff: StaffEvent[],
    results: SurfaceAssessment[];
  let events: LogEvent[],
    requests: AssessmentRequest[],
    requestById: Map<string, AssessmentRequest>;
  let usedResults: Set<string>,
    usedRequests: Set<string>,
    usedCaptures: Set<string>;
  let observationIndex = 0,
    staffIndex = 0,
    assessmentIndex = 0,
    cursor = -Infinity;
  let batchStart: Record<string, Status> = {};

  function initialize() {
    staff = [...bundle.staff_events, ...extraStaff];
    validateStaffEvents(staff, tableIds, bundle.video.duration_s);
    staff.sort((a, b) => a.t - b.t || a.seq - b.seq);
    results = [...(bundle.assessments ?? []), ...submitted].sort(
      (a, b) => a.t - b.t,
    );
    core = createRuleCore<SurfaceAssessment>(bundle.tables, bundle.rules);
    memories = core.memories;
    byId = core.byId;
    events = [];
    requests = [];
    requestById = new Map();
    usedResults = new Set();
    usedRequests = new Set();
    usedCaptures = new Set();
    observationIndex = staffIndex = assessmentIndex = 0;
    cursor = -Infinity;
    batchStart = {};
  }
  const service = (m: RuleMemory<SurfaceAssessment>) => core.service(m);
  const eligible = (m: RuleMemory<SurfaceAssessment>, t: number) =>
    core.assessmentEligible(m, t);
  function plan(observation: Observation) {
    for (const m of memories) {
      const reference = m.table.reference;
      const baseline = approvedObjectBaseline(m.table);
      if (
        !baseline ||
        !eligible(m, observation.t) ||
        (m.surface === "cleared_reset" && m.readinessSource !== "automatic") ||
        observation.t + EPS < m.nextDue ||
        !reference?.confirmed_clean ||
        !reference.sha256 ||
        reference.source_t > observation.t
      )
        continue;
      const identity = {
        table_id: m.table.id,
        t: observation.t,
        frame_index: observation.frame_index,
        generation: m.generation,
        video_sha256: bundle.video.sha256,
        geometry_sha256: m.table.geometry_sha256!,
        reference_sha256: reference.sha256,
        surface_method: m.table.surface_method,
        baseline_sha256: baseline.baseline_sha256,
        config_sha256: baseline.config_sha256,
        ...(timingProfile ? { timing_profile: timingProfile } : {}),
        ...(observation.capture ? { capture: { ...observation.capture } } : {}),
      };
      const recorded = bundle.assessment_requests?.find((request) =>
        Object.entries(identity).every(
          ([key, value]) => key === "capture"
            ? sameCapture(request.capture, observation.capture)
            : request[key as keyof AssessmentRequest] === value,
        ),
      );
      const request: AssessmentRequest = {
        id:
          recorded?.id ??
          `surface:${encodeURIComponent(m.table.id)}:${m.generation}:${observation.frame_index}`,
        ...identity,
      };
      if (requestById.has(request.id)) continue;
      requests.push(request);
      requestById.set(request.id, request);
      m.nextDue = observation.t + core.requestRetry(m);
    }
  }
  function reject(result: SurfaceAssessment, t: number, reason: string) {
    events.push({
      t,
      table_id: result.table_id,
      kind: "assessment_rejected",
      status: byId[result.table_id]
        ? service(byId[result.table_id])
        : "unknown",
      reason,
      event_id: result.id,
    });
  }
  function acceptAssessment(result: SurfaceAssessment, t: number): boolean {
    const m = byId[result.table_id],
      request = requestById.get(result.request_id),
      capture = `${result.table_id}:${result.video_sha256}:${result.frame_index}`;
    if (m) result = normalizeObjectAssessment(m.table, result);
    let reason: string | null = null;
    if (!m || !request)
      reason = "Assessment does not match an emitted request.";
    else if (Math.abs(result.t - t) > EPS)
      reason = "Assessment must be submitted at its source request timestamp.";
    else if (
      usedResults.has(result.id) ||
      usedRequests.has(result.request_id) ||
      usedCaptures.has(capture)
    )
      reason = "Repeated assessment, request, or source capture.";
    else if (
      [
        "table_id",
        "t",
        "frame_index",
        "generation",
        "video_sha256",
        "geometry_sha256",
        "reference_sha256",
        "surface_method",
        "baseline_sha256",
        "config_sha256",
        "timing_profile",
      ].some(
        (key) =>
          result[key as keyof SurfaceAssessment] !==
          request[key as keyof AssessmentRequest],
      )
    || !sameCapture(result.capture, request.capture))
      reason = "Assessment source identity does not match its request.";
    else if (
      usesObjectSurface(m.table) &&
      (!approvedObjectBaseline(m.table) ||
        result.baseline_sha256 !== m.table.object_baseline?.baseline_sha256 ||
        result.config_sha256 !== m.table.object_baseline?.config_sha256)
    )
      reason =
        "Assessment belongs to an outdated baseline or comparison configuration.";
    else if (result.generation !== m.generation)
      reason = "Assessment belongs to an older readiness generation.";
    else if (!eligible(m, t))
      reason =
        "Assessment requires fresh absence and a continuously observable surface.";
    else if (
      m.positive &&
      result.outcome === "cleared_reset" &&
      result.t - m.positive.t + EPS < separation
    )
      reason =
        "Positive assessments must use distinct captures separated by the required interval.";
    if (reason) {
      reject(result, t, reason);
      return false;
    }
    usedResults.add(result.id);
    usedRequests.add(result.request_id);
    usedCaptures.add(capture);
    core.applySurface(m, result, t);
    events.push({
      t,
      table_id: m.table.id,
      kind: "assessment_accepted",
      status: service(m),
      reason: m.surfaceReason,
      event_id: result.id,
    });
    return true;
  }
  function applyStaff(event: StaffEvent, log = true) {
    const result = core.applyStaff(event);
    if (log) events.push(result);
  }
  function derive(t: number, replace = false) {
    if (replace)
      events = events.filter(
        (event) => !(event.t === t && event.kind === "transition"),
      );
    for (const m of memories) {
      const status = service(m),
        previous = replace ? batchStart[m.table.id] : m.status;
      if (status !== previous)
        events.push({
          t,
          table_id: m.table.id,
          kind: "transition",
          status,
          reason: core.reason(m),
        });
      m.status = status;
    }
    for (const event of events)
      if (event.t === t && byId[event.table_id])
        event.status = byId[event.table_id].status;
  }
  function internalTime(): number {
    let next = Infinity;
    for (const m of memories) {
      if (!m.failed && m.lastSample !== null)
        next = Math.min(next, m.lastSample + bundle.rules.gap_s + EPS);
      if (
        !m.failed &&
        m.presence === "absent" &&
        m.absenceSince !== null &&
        m.people !== "vacant"
      )
        next = Math.min(next, m.absenceSince + bundle.rules.exit_s);
      if (
        usesObjectSurface(m.table) &&
        m.readinessSource === "automatic" &&
        m.surfaceT !== null
      )
        next = Math.min(next, m.surfaceT + surfaceTiming.clearance_ttl_s);
      if (usesObjectSurface(m.table) && m.cleanLastT !== null)
        next = Math.min(next, m.cleanLastT + surfaceTiming.clearance_ttl_s);
    }
    return next > cursor + EPS / 4 ? next : Infinity;
  }
  function snapshot(t: number): Snapshot {
    const tables: Record<string, TableState> = {};
    for (const m of memories) tables[m.table.id] = core.tableState(m, t);
    return { t, tables, events: events.map((event) => ({ ...event })) };
  }
  function advanceTo(t: number): Snapshot {
    if (!Number.isFinite(t) || t < 0 || t > bundle.video.duration_s)
      throw new Error("Replay time must be within the video.");
    if (t < cursor) initialize();
    if (t === cursor) return snapshot(t);
    while (true) {
      const external = Math.min(
          bundle.observations[observationIndex]?.t ?? Infinity,
          staff[staffIndex]?.t ?? Infinity,
          results[assessmentIndex]?.t ?? Infinity,
        ),
        next = Math.min(external, internalTime());
      if (next > t || next === Infinity) break;
      batchStart = Object.fromEntries(
        memories.map((m) => [m.table.id, m.status]),
      );
      let observation: Observation | undefined;
      if (bundle.observations[observationIndex]?.t === next) {
        observation = bundle.observations[observationIndex++];
        core.observe(observation);
      }
      core.timers(next);
      if (observation) plan(observation);
      while (results[assessmentIndex]?.t === next)
        acceptAssessment(results[assessmentIndex++], next);
      while (staff[staffIndex]?.t === next) applyStaff(staff[staffIndex++]);
      derive(next);
      cursor = next;
    }
    if (cursor !== t) {
      batchStart = Object.fromEntries(
        memories.map((m) => [m.table.id, m.status]),
      );
      core.timers(t);
      derive(t);
      cursor = t;
    }
    return snapshot(t);
  }
  initialize();
  return {
    appendObservation(observation) {
      const previous = bundle.observations.at(-1);
      validateObservation(observation, tableIds, bundle.video.duration_s,
        previous?.t ?? -Infinity, previous?.frame_index ?? -1,
        bundle.video.source_kind === "browser_file" ? { width: bundle.video.processing_width!, height: bundle.video.processing_height! } : undefined);
      if (observation.t <= cursor)
        throw new Error("Append observations before advancing beyond their timestamp.");
      bundle.observations.push(structuredClone(observation));
    },
    advanceTo,
    getAssessmentRequests: () => requests.map((request) => ({ ...request })),
    submitAssessment(result) {
      validateAssessment(result);
      if (bundle.video.source_kind === "browser_file") validateFrameCapture(result.capture);
      if (!Number.isFinite(cursor))
        throw new Error(
          "Advance to an assessment request before submitting a result.",
        );
      if (acceptAssessment(result, cursor))
        submitted.push({ ...byId[result.table_id].lastAssessment! });
      for (const event of staff)
        if (event.t === cursor) applyStaff(event, false);
      derive(cursor, true);
    },
    reset(staffEvents = []) {
      extraStaff = [...staffEvents];
      initialize();
    },
  };
}

/** Replay one point in source time. Persistent callers reuse a replay session. */
export function replay(
  bundle: Bundle,
  t: number,
  staffEvents: StaffEvent[] = [],
): Snapshot {
  return createReplaySession(bundle, staffEvents).advanceTo(t);
}
