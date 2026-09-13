import type {
  LogEvent,
  Observation,
  PeopleState,
  Presence,
  Rules,
  StaffEvent,
  Status,
  SurfaceAssessment,
  SurfaceState,
  Table,
  TableState,
} from "../../shared/contracts";
import {
  approvedObjectBaseline,
  objectSurfaceTiming,
  usesObjectSurface,
} from "./object-surface";
import {
  createSurfaceStabilityMemory,
  resetSurfaceStability,
  stabilizeSurfaceAssessment,
  surfaceStabilityTiming,
  type SurfaceStabilityMemory,
} from "./surface-stability";
export type SurfaceEvidence = Pick<
  SurfaceAssessment,
  "t" | "outcome" | "valid" | "reason" | "error"
> &
  Partial<Pick<SurfaceAssessment, "object_evidence">>;
// Display rounding never changes source-clock comparisons.
const secondsLabel = (seconds: number) => String(Number(seconds.toFixed(2)));
const EPS = 1e-7;
export interface Visit {
  dwell: number;
  last_t: number;
  observed: boolean;
  predicted_since: number | null;
}
export interface RuleMemory<A extends SurfaceEvidence> {
  table: Table;
  people: PeopleState;
  presence: Presence;
  surface: SurfaceState;
  generation: number;
  peopleReason: string;
  surfaceReason: string;
  lastSample: number | null;
  absenceSince: number | null;
  occupied: boolean;
  occupiedSince: number | null;
  visits: Map<string, Visit>;
  visible: boolean | null;
  changed: boolean;
  moved: boolean;
  cut: boolean;
  failed: boolean;
  visibleSince: number | null;
  dirtyLatched: boolean;
  dirtyBlocked: boolean;
  cleanSince: number | null;
  cleanLastT: number | null;
  cleanCount: number;
  stability: SurfaceStabilityMemory;
  positive: A | null;
  lastAssessment: A | null;
  surfaceT: number | null;
  nextDue: number;
  readinessSource: "automatic" | "staff" | "staff_override" | null;
  status: Status;
  manual: NonNullable<TableState["manual_override"]> | null;
}

/** The one people/surface/service rule implementation used by offline and live adapters. */
export function createRuleCore<A extends SurfaceEvidence>(
  tables: Table[],
  rules: Rules,
) {
  const surfaceTiming = objectSurfaceTiming(rules);
  const stabilityTiming = surfaceStabilityTiming(rules);
  let clockTime = 0;
  const separation = rules.assessment_separation_s ?? 2,
    retry = rules.assessment_retry_s ?? 5,
    grace = rules.track_grace_s ?? 1;
  const freshMemory = (table: Table): RuleMemory<A> => ({
    table,
    people: "uncertain",
    presence: "uncertain",
    surface: "unverified",
    generation: 0,
    peopleReason:
      table.monitoring_enabled === false
        ? "Monitoring disabled for this table."
        : "Awaiting reliable vacancy or a qualifying visit.",
    surfaceReason:
      table.monitoring_enabled === false
        ? "Monitoring disabled for this table."
        : usesObjectSurface(table) && !approvedObjectBaseline(table)
          ? "Approve expected objects and a reset reference in table setup."
          : "Awaiting two qualifying surface assessments.",
    lastSample: null,
    absenceSince: null,
    occupied: false,
    occupiedSince: null,
    visits: new Map(),
    visible: null,
    changed: false,
    moved: false,
    cut: false,
    failed: false,
    visibleSince: null,
    dirtyLatched: false,
    dirtyBlocked: false,
    cleanSince: null,
    cleanLastT: null,
    cleanCount: 0,
    stability: createSurfaceStabilityMemory(),
    positive: null,
    lastAssessment: null,
    surfaceT: null,
    nextDue: 0,
    readinessSource: null,
    status: "unknown",
    manual: null,
  });
  const memories = tables.map(freshMemory);
  const byId = Object.fromEntries(memories.map((m) => [m.table.id, m]));
  const automaticService = (m: RuleMemory<A>): Status =>
    m.people === "occupied"
      ? "occupied"
      : usesObjectSurface(m.table) &&
          m.dirtyLatched &&
          !m.dirtyBlocked &&
          assessmentEligible(m, clockTime)
        ? "needs_cleaning"
        : m.people !== "vacant"
          ? "unknown"
          : m.surface === "cleared_reset"
            ? "ready"
            : m.surface === "needs_reset" &&
                (!usesObjectSurface(m.table) ||
                  (assessmentEligible(m, clockTime) && !m.dirtyBlocked))
              ? "needs_cleaning"
              : "unknown";
  const service = (m: RuleMemory<A>): Status =>
    m.table.monitoring_enabled === false
      ? "unknown"
      : (m.manual?.status ?? automaticService(m));
  const surfaceReason = (m: RuleMemory<A>): string =>
    m.moved
      ? "Camera movement prevents tabletop checks. Review camera alignment and calibration."
      : m.surfaceReason;
  const reason = (m: RuleMemory<A>): string =>
    m.table.monitoring_enabled === false
      ? "Monitoring disabled for this table."
      : m.manual
        ? `Manual override: displayed service status is ${m.manual.status}. Observed people and surface evidence remain separate.`
        : m.people === "vacant" || automaticService(m) === "needs_cleaning"
          ? surfaceReason(m)
          : m.peopleReason;
  const vacant = (m: RuleMemory<A>, t: number): boolean =>
    m.table.monitoring_enabled !== false &&
    m.people === "vacant" &&
    m.presence === "absent" &&
    m.absenceSince !== null &&
    t + EPS >= m.absenceSince + rules.exit_s &&
    !m.failed &&
    m.lastSample !== null &&
    t - m.lastSample <= rules.gap_s + EPS / 2;
  const eligible = (m: RuleMemory<A>, t: number): boolean =>
    vacant(m, t) && m.visible === true && !m.moved && !m.cut;
  function assessmentEligible(m: RuleMemory<A>, t: number): boolean {
    if (!usesObjectSurface(m.table)) return eligible(m, t);
    return (
      m.table.monitoring_enabled !== false &&
      m.presence === "absent" &&
      m.absenceSince !== null &&
      t + EPS >= m.absenceSince + stabilityTiming.early_dirty_vacancy_s &&
      m.visible === true &&
      m.visibleSince !== null &&
      t + EPS >= m.visibleSince + stabilityTiming.unobstructed_s &&
      !m.failed &&
      !m.moved &&
      !m.cut &&
      m.lastSample !== null &&
      t - m.lastSample <= rules.gap_s + EPS / 2
    );
  }
  const requestRetry = (m: RuleMemory<A>): number =>
    usesObjectSurface(m.table) ? stabilityTiming.dirty_retry_s : retry;
  function resetCleanConfirmation(m: RuleMemory<A>) {
    m.positive = null;
    m.cleanSince = null;
    m.cleanLastT = null;
    m.cleanCount = 0;
  }
  function invalidate(
    m: RuleMemory<A>,
    t: number,
    reason: string,
    preserveDirty = false,
    forgetAlignment = true,
  ) {
    m.generation++;
    m.surface = "unverified";
    m.surfaceReason = reason;
    m.surfaceT = null;
    resetCleanConfirmation(m);
    resetSurfaceStability(m.stability, forgetAlignment);
    if (!preserveDirty || !usesObjectSurface(m.table)) m.dirtyLatched = false;
    m.dirtyBlocked = false;
    m.readinessSource = null;
    m.nextDue = t;
  }
  function failure(m: RuleMemory<A>, t: number, reason: string) {
    if (!m.failed) invalidate(m, t, reason);
    m.failed = true;
    m.presence = "uncertain";
    m.people = "uncertain";
    m.peopleReason = reason;
    m.absenceSince = null;
    m.visibleSince = null;
    m.occupied = false;
    m.visits.clear();
  }
  function updatePeople(m: RuleMemory<A>, t: number) {
    if (m.failed || m.presence === "uncertain") {
      m.people = "uncertain";
      return;
    }
    if (m.presence === "present") {
      if (
        m.occupied ||
        [...m.visits.values()].some(
          (visit) => visit.observed && visit.dwell + EPS >= rules.entry_s,
        )
      ) {
        if (!m.occupied) m.occupiedSince = t;
        m.occupied = true;
        m.people = "occupied";
        m.peopleReason = `Same-track visit qualified after ${secondsLabel(rules.entry_s)} s of observed presence.`;
      } else {
        m.people = "pending_arrival";
        m.peopleReason = `Person detected; qualifying a ${secondsLabel(rules.entry_s)} s visit.`;
      }
    } else if (
      m.absenceSince !== null &&
      t + EPS >= m.absenceSince + rules.exit_s
    ) {
      m.people = "vacant";
      m.occupied = false;
      m.occupiedSince = null;
      m.peopleReason = `Vacant for ${secondsLabel(rules.exit_s)} s of valid evidence.`;
    } else if (m.occupied) {
      m.people = "pending_departure";
      m.peopleReason = `Departure pending ${secondsLabel(rules.exit_s)} s of valid vacancy.`;
    } else {
      m.people = "uncertain";
      m.peopleReason = `Verifying ${secondsLabel(rules.exit_s)} s of vacancy.`;
    }
  }
  function timers(t: number, qualify = true) {
    clockTime = t;
    for (const m of memories) {
      if (m.table.monitoring_enabled === false) continue;
      if (
        m.lastSample !== null &&
        t - m.lastSample > rules.gap_s + EPS / 2 &&
        !m.failed
      )
        failure(
          m,
          t,
          "Analysis gap; occupancy and readiness need new evidence.",
        );
      if (
        usesObjectSurface(m.table) &&
        m.readinessSource === "automatic" &&
        m.surfaceT !== null &&
        t + EPS >= m.surfaceT + surfaceTiming.clearance_ttl_s
      )
        invalidate(
          m,
          t,
          "Automatic readiness expired; two fresh tabletop checks are required.",
          false,
          false,
        );
      if (
        usesObjectSurface(m.table) &&
        m.cleanLastT !== null &&
        t + EPS >= m.cleanLastT + surfaceTiming.clearance_ttl_s
      ) {
        resetCleanConfirmation(m);
        m.nextDue = Math.min(m.nextDue, t);
        m.surfaceReason =
          "Clean confirmation expired; the previous cleaning need remains until fresh clean captures agree.";
      }
      if (qualify) updatePeople(m, t);
      if (
        usesObjectSurface(m.table) &&
        m.dirtyLatched &&
        !m.dirtyBlocked &&
        m.surface === "unverified" &&
        assessmentEligible(m, t)
      ) {
        m.surface = "needs_reset";
        m.surfaceReason =
          "The previous cleaning need remains; waiting for consistent clean tabletop checks.";
      }
    }
  }
  function observe(
    observation: Observation,
    acceptsTable: (id: string) => boolean = () => true,
  ) {
    const t = observation.t,
      allTracks = new Map(
        (observation.tracks ?? []).map((track) => [track.track_id, track]),
      );
    clockTime = t;
    for (const m of memories) {
      if (m.table.monitoring_enabled === false || !acceptsTable(m.table.id))
        continue;
      const surface = observation.surface![m.table.id];
      if (observation.scene_cut && !m.cut) {
        invalidate(m, t, "Scene cut invalidated previous surface evidence.");
        m.visits.clear();
        m.absenceSince = null;
        m.occupied = false;
      }
      if (surface.camera_moved && !m.moved)
        invalidate(m, t, "Camera movement invalidated surface evidence.");
      if (
        (surface.visible !== true && m.visible === true) ||
        (surface.visible === false && m.visible === null)
      )
        invalidate(
          m,
          t,
          "Surface is obstructed or not observable.",
          true,
          false,
        );
      if (surface.changed && !m.changed)
        invalidate(
          m,
          t,
          "A surface change requires a new verification.",
          true,
          false,
        );
      if (surface.visible === true && m.visible !== true)
        m.nextDue = Math.min(m.nextDue, t);
      m.visible = surface.visible;
      m.changed = surface.changed;
      m.moved = !!surface.camera_moved;
      m.cut = !!observation.scene_cut;
      const evidence = observation.tables[m.table.id];
      if (
        !observation.valid ||
        evidence === "uncertain" ||
        observation.scene_cut
      ) {
        failure(
          m,
          t,
          observation.error ?? "Missing or ambiguous person evidence.",
        );
        m.lastSample = t;
        continue;
      }
      m.failed = false;
      // Attribute the previous observed frame's interval; predictions contribute no dwell.
      for (const [id, visit] of m.visits) {
        const track = allTracks.get(id);
        if (!track || (track.observed && track.table_id !== m.table.id)) {
          m.visits.delete(id);
          continue;
        }
        if (visit.observed && t - visit.last_t <= grace + EPS)
          visit.dwell += t - visit.last_t;
        if (!track.observed) {
          visit.predicted_since ??= t;
          if (t - visit.predicted_since > grace + EPS) {
            m.visits.delete(id);
            continue;
          }
        } else if (
          visit.predicted_since !== null &&
          t - visit.predicted_since > grace + EPS
        ) {
          m.visits.delete(id);
          continue;
        }
        visit.last_t = t;
        visit.observed = false;
      }
      const assigned = (observation.tracks ?? []).filter(
        (track) => track.observed && track.table_id === m.table.id,
      );
      for (const track of assigned) {
        let visit = m.visits.get(track.track_id);
        if (!visit) {
          visit = {
            dwell: 0,
            last_t: t,
            observed: true,
            predicted_since: null,
          };
          m.visits.set(track.track_id, visit);
          invalidate(
            m,
            t,
            "A new arrival invalidated the previous clearance.",
            true,
            false,
          );
        }
        visit.observed = true;
        visit.last_t = t;
        visit.predicted_since = null;
      }
      m.presence = assigned.length
        ? "present"
        : evidence === "absent"
          ? "absent"
          : "uncertain";
      if (m.presence === "absent") m.absenceSince ??= t;
      else m.absenceSince = null;
      if (m.presence === "absent" && m.visible === true && !m.moved && !m.cut)
        m.visibleSince ??= t;
      else m.visibleSince = null;
      m.lastSample = t;
      updatePeople(m, t);
    }
  }
  function applySurface(m: RuleMemory<A>, result: A, t: number) {
    clockTime = t;
    const objectMode = usesObjectSurface(m.table);
    const renew =
      objectMode &&
      m.surface === "cleared_reset" &&
      m.readinessSource === "automatic" &&
      m.surfaceT !== null &&
      t + EPS < m.surfaceT + surfaceTiming.clearance_ttl_s;
    if (
      objectMode &&
      m.positive &&
      t + EPS >= m.positive.t + surfaceTiming.clearance_ttl_s
    )
      m.positive = null;
    const normalized = result;
    if (objectMode)
      result = stabilizeSurfaceAssessment(
        m.stability,
        m.table,
        result,
        stabilityTiming,
      );
    const pendingVerification =
      normalized.valid &&
      normalized.outcome !== "unobservable" &&
      result.outcome === "unobservable";
    m.lastAssessment = { ...result };
    m.surfaceT = result.t;
    m.readinessSource = null;
    if (!result.valid || result.outcome === "unobservable") {
      resetCleanConfirmation(m);
      m.dirtyBlocked = objectMode && !pendingVerification;
      m.surface =
        objectMode && m.dirtyLatched && pendingVerification
          ? "needs_reset"
          : "unverified";
      m.surfaceReason = result.error ?? result.reason;
      m.nextDue = objectMode
        ? result.t + stabilityTiming.uncertain_retry_s
        : t + retry;
    } else if (result.outcome === "not_reset") {
      resetCleanConfirmation(m);
      m.dirtyLatched = objectMode;
      m.dirtyBlocked = false;
      m.surface = "needs_reset";
      m.surfaceReason = result.reason;
      m.nextDue = objectMode
        ? result.t + stabilityTiming.dirty_retry_s
        : t + retry;
    } else if (objectMode && (!eligible(m, result.t) || !eligible(m, t))) {
      // An early capture cannot become clean evidence merely because inference finished later.
      resetCleanConfirmation(m);
      m.dirtyBlocked = false;
      m.surface = m.dirtyLatched ? "needs_reset" : "unverified";
      m.surfaceReason = `Clean appearance captured before ${secondsLabel(rules.exit_s)} s of vacancy; fresh checks are required after the vacancy wait.`;
      m.nextDue = Math.max(
        result.t,
        (m.absenceSince ?? result.t) + rules.exit_s,
      );
    } else if (objectMode && m.dirtyLatched) {
      m.dirtyBlocked = false;
      m.cleanSince ??= result.t;
      m.cleanLastT = result.t;
      m.cleanCount++;
      const span = result.t - m.cleanSince;
      if (
        m.cleanCount >= stabilityTiming.clean_confirmation_captures &&
        span + EPS >= stabilityTiming.clean_confirmation_s
      ) {
        m.dirtyLatched = false;
        resetCleanConfirmation(m);
        m.surface = "cleared_reset";
        m.readinessSource = "automatic";
        m.surfaceReason = `Consistent clean captures spanning at least ${secondsLabel(stabilityTiming.clean_confirmation_s)} s cleared the previous cleaning need.`;
      } else {
        m.surface = "needs_reset";
        m.surfaceReason = `Clean appearance needs confirmation: ${m.cleanCount} of at least ${stabilityTiming.clean_confirmation_captures} captures across ${secondsLabel(span)} of ${secondsLabel(stabilityTiming.clean_confirmation_s)} s. Cleaning status is retained.`;
      }
      m.nextDue = result.t + stabilityTiming.recheck_s;
    } else if (renew || m.positive) {
      resetCleanConfirmation(m);
      m.dirtyBlocked = false;
      m.surface = "cleared_reset";
      m.surfaceReason = renew
        ? "Current objects and appearance renewed automatic readiness."
        : "Two separate source captures verified the surface as cleared and reset.";
      m.readinessSource = "automatic";
      m.nextDue = objectMode ? result.t + stabilityTiming.recheck_s : Infinity;
    } else {
      m.positive = { ...result };
      m.dirtyBlocked = false;
      m.surface = "unverified";
      m.surfaceReason =
        "First positive assessment; awaiting an independent confirmation.";
      m.nextDue = result.t + separation;
    }
  }
  function applyStaff(event: StaffEvent): LogEvent {
    clockTime = event.t;
    const m = byId[event.table_id],
      force = event.action === "force_cleaned";
    const statusAction =
      event.action === "force_status" ||
      event.action === "clear_status_override";
    const enabled = m.table.monitoring_enabled !== false;
    const allowed =
      enabled &&
      (statusAction ||
        event.action === "needs_cleaning" ||
        (force ? vacant(m, event.t) : eligible(m, event.t)));
    let staffReason = !enabled
      ? "Staff action rejected: monitoring is disabled for this table."
      : force
        ? "Staff override rejected: stable, valid vacancy is required; occupancy cannot be overridden."
        : "Staff confirmation requires stable vacancy and a reliable visible surface.";
    if (allowed && statusAction) {
      m.manual =
        event.action === "force_status"
          ? { status: event.status!, t: event.t, event_id: event.id }
          : null;
      staffReason = m.manual
        ? reason(m)
        : "Manual service colour override cleared; returned to state-based status.";
    } else if (allowed) {
      resetCleanConfirmation(m);
      resetSurfaceStability(m.stability);
      m.dirtyBlocked = false;
      m.surfaceT = event.t;
      if (force) {
        m.dirtyLatched = false;
        m.surface = "cleared_reset";
        m.readinessSource = "staff_override";
        m.nextDue = Infinity;
        m.surfaceReason =
          "Staff override: tabletop verification bypassed for a table with verified vacancy.";
      } else if (event.action === "confirm_cleaned") {
        m.dirtyLatched = false;
        m.surface = "cleared_reset";
        m.readinessSource = "staff";
        m.nextDue = Infinity;
        m.surfaceReason =
          "Staff explicitly confirmed the vacant table cleared and reset.";
      } else {
        m.dirtyLatched = usesObjectSurface(m.table);
        m.surface = "needs_reset";
        m.readinessSource = null;
        m.nextDue = event.t;
        m.surfaceReason = "Staff marked the table as needing cleaning.";
      }
      staffReason = m.surfaceReason;
    }
    return {
      t: event.t,
      table_id: m.table.id,
      kind: allowed ? "staff_accepted" : "staff_rejected",
      status: service(m),
      reason: staffReason,
      event_id: event.id,
    };
  }
  function resetTable(id: string, t: number, enabled?: boolean) {
    const memory = byId[id];
    if (!memory) throw new Error("Unknown table.");
    const generation = memory.generation + 1;
    const table = {
      ...memory.table,
      ...(enabled === undefined ? {} : { monitoring_enabled: enabled }),
    };
    Object.assign(memory, freshMemory(table), { generation, nextDue: t });
  }
  function tableState(
    m: RuleMemory<A>,
    t: number,
  ): Omit<TableState, "last_assessment"> & { last_assessment: A | null } {
    return {
      table_id: m.table.id,
      status: m.status,
      automatic_status: automaticService(m),
      manual_override: m.manual ? { ...m.manual } : null,
      monitoring_enabled: m.table.monitoring_enabled !== false,
      presence: m.presence,
      people_state: m.people,
      surface_state: m.surface,
      generation: m.generation,
      can_confirm_cleaned: eligible(m, t),
      can_force_cleaned: vacant(m, t),
      needs_cleaning: m.surface === "needs_reset",
      reason: reason(m),
      people_reason: m.peopleReason,
      surface_reason: surfaceReason(m),
      people_evidence_t: m.lastSample,
      surface_evidence_t: m.surfaceT,
      occupied_since: m.occupiedSince,
      last_assessment: m.lastAssessment ? { ...m.lastAssessment } : null,
      readiness_source: m.readinessSource,
    };
  }
  return {
    memories,
    byId,
    service,
    automaticService,
    reason,
    vacant,
    eligible,
    assessmentEligible,
    requestRetry,
    invalidate,
    failure,
    updatePeople,
    timers,
    observe,
    applySurface,
    applyStaff,
    resetTable,
    tableState,
  };
}
