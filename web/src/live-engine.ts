import type { LogEvent, Status } from "../../shared/contracts";
import type {
  LiveAssessmentRequest,
  LiveCommand,
  LiveConfig,
  LiveObservation,
  LiveReply,
  LiveSurfaceAssessment,
} from "../../shared/live-contracts";
import { createRuleCore } from "./rule-core";
import { validateStaffEvents } from "./validation";
import {
  approvedObjectBaseline,
  isObjectBaseline,
  normalizeObjectAssessment,
  OBJECT_SURFACE_CONFIG,
  OBJECT_SURFACE_METHOD,
  usesObjectSurface,
} from "./object-surface";

const EPS = 1e-7;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f\d]{64}$/i.test(value);
const point = (value: unknown) =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every((n) => finite(n) && n >= 0 && n <= 1);
const box = (value: unknown) =>
  Array.isArray(value) &&
  value.length === 4 &&
  value.every((n) => finite(n) && n >= 0 && n <= 1) &&
  value[2] > value[0] &&
  value[3] > value[1];
const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

function validateConfig(config: LiveConfig) {
  assert(
    config && !("protocol_version" in config) &&
      typeof config.session_id === "string" &&
      config.session_id &&
      typeof config.calibration_id === "string" &&
      config.calibration_id &&
      Number.isSafeInteger(config.epoch) &&
      config.epoch >= 0,
    "Invalid live session identity.",
  );
  assert(
    [config.width, config.height].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) &&
      finite(config.sample_hz) &&
      config.sample_hz > 0 &&
      typeof config.detection_only === "boolean" &&
      finite(config.evidence_max_age_s) &&
      config.evidence_max_age_s > 0 &&
      config.evidence_max_age_s <= 5,
    "Invalid live dimensions, cadence or evidence age.",
  );
  assert(
    config.rules &&
      ["entry_s", "exit_s", "gap_s"].every(
        (k) =>
          finite(config.rules[k as keyof typeof config.rules]) &&
          config.rules[k as keyof typeof config.rules]! > 0,
      ),
    "Invalid live timing rules.",
  );
  assert(
    config.rules.demo_timing_scale === undefined,
    "Accelerated demo timing is not permitted for live cameras.",
  );
  assert(
    Array.isArray(config.tables) && config.tables.length > 0,
    "Live setup requires tables.",
  );
  const ids = new Set<string>();
  for (const table of config.tables) {
    assert(
      typeof table.id === "string" && table.id && !ids.has(table.id),
      "Invalid or duplicate live table ID.",
    );
    ids.add(table.id);
    assert(
      typeof table.label === "string" &&
        box(table.video_region) &&
        box(table.crop) &&
        hash(table.geometry_sha256) &&
        table.tabletop_polygon?.length === 4 &&
        table.tabletop_polygon.every(point) &&
        table.occupancy_regions?.length &&
        table.occupancy_regions.every(
          (region) => region.length >= 3 && region.every(point),
        ),
      "Invalid calibrated live table geometry.",
    );
    assert(
      table.monitoring_enabled === undefined ||
        typeof table.monitoring_enabled === "boolean",
      "Monitoring must be boolean.",
    );
    if (table.reference)
      assert(
        hash(table.reference.sha256) &&
          finite(table.reference.source_t) &&
          table.reference.source_t >= 0 &&
          typeof table.reference.confirmed_clean === "boolean",
        "Invalid live reference identity.",
      );
    assert(
      table.surface_method === undefined ||
        table.surface_method === OBJECT_SURFACE_METHOD,
      "Unsupported surface method.",
    );
    if (table.object_baseline !== undefined)
      assert(
        usesObjectSurface(table) &&
          isObjectBaseline(table.object_baseline) &&
          table.object_baseline.geometry_sha256 === table.geometry_sha256 &&
          table.object_baseline.reference_sha256 === table.reference?.sha256,
        "Invalid live expected-object baseline.",
      );
  }
}

/** Incremental live adapter: capture-time rules, availability-time transitions, no finished-video identity. */
export function createLiveSession(input: LiveConfig): {
  send(command: LiveCommand): LiveReply;
} {
  validateConfig(input);
  const config = structuredClone(input),
    core = createRuleCore<LiveSurfaceAssessment>(config.tables, config.rules);
  const ids = new Set(config.tables.map((table) => table.id)),
    pending = new Map<string, LiveAssessmentRequest>();
  const captureFloors = new Map(config.tables.map((table) => [table.id, 0]));
  let now = 0,
    lastCapture = -Infinity,
    lastFrame = -1,
    stopped = false,
    events: LogEvent[] = [],
    outgoing: LiveAssessmentRequest[] = [];
  let lastStaffSeq = -1;
  const sameTimeStaff: import("../../shared/contracts").StaffEvent[] = [];
  let batchTime = -1,
    batchStart: Record<string, Status> = {};
  function begin(t: number, incomingObservation = false) {
    assert(
      finite(t) && t >= now,
      "Live availability time must not move backwards.",
    );
    if (t !== batchTime) {
      batchTime = t;
      batchStart = Object.fromEntries(
        core.memories.map((m) => [m.table.id, m.status]),
      );
      sameTimeStaff.length = 0;
    }
    now = t;
    if (!incomingObservation) core.timers(now, false);
    for (const [id, request] of pending) {
      const m = core.byId[id];
      if (
        now - request.t > config.evidence_max_age_s + EPS ||
        m.generation !== request.generation ||
        m.table.monitoring_enabled === false
      ) {
        pending.delete(id);
        m.nextDue = Math.min(m.nextDue, now);
      }
    }
  }
  function reapplyStaff() {
    for (const event of sameTimeStaff) {
      events = events.filter(
        (log) =>
          !(
            log.event_id === event.id &&
            ["staff_accepted", "staff_rejected"].includes(log.kind)
          ),
      );
      events.push(core.applyStaff(event));
    }
  }
  function reply(): LiveReply {
    // Re-derive a same-time batch atomically when separately delivered commands share now.
    events = events.filter(
      (event) => !(event.kind === "transition" && event.t === now),
    );
    for (const m of core.memories) {
      const status = core.service(m);
      if (status !== batchStart[m.table.id])
        events.push({
          t: now,
          table_id: m.table.id,
          kind: "transition",
          status,
          reason: core.reason(m),
        });
      m.status = status;
    }
    for (const event of events)
      if (event.t === now && core.byId[event.table_id])
        event.status = core.byId[event.table_id].status;
    events = events.slice(-200);
    const requests = outgoing;
    outgoing = [];
    return {
      snapshot: {
        t: now,
        stopped,
        tables: Object.fromEntries(
          core.memories.map((m) => [m.table.id, core.tableState(m, now)]),
        ),
        events: events.map((event) => ({ ...event })),
      },
      requests,
    };
  }
  function validateObservation(observation: LiveObservation, t: number) {
    assert(
      observation.session_id === config.session_id &&
        observation.epoch === config.epoch &&
        observation.calibration_id === config.calibration_id,
      "Live observation identity mismatch.",
    );
    assert(
      finite(observation.t) &&
        observation.t >= 0 &&
        observation.t > lastCapture &&
        observation.t <= t + EPS &&
        t - observation.t <= config.rules.gap_s + EPS &&
        Number.isSafeInteger(observation.frame_index) &&
        observation.frame_index > lastFrame &&
        hash(observation.frame_sha256),
      "Stale, future, repeated or out-of-order live capture.",
    );
    assert(
      typeof observation.valid === "boolean" &&
        observation.tables &&
        Object.keys(observation.tables).length === ids.size &&
        Object.entries(observation.tables).every(
          ([id, value]) =>
            ids.has(id) && ["present", "absent", "uncertain"].includes(value),
        ) &&
        (observation.valid ||
          Object.values(observation.tables).every(
            (value) => value === "uncertain",
          )),
      "Invalid live person evidence.",
    );
    assert(
      observation.surface &&
        Object.keys(observation.surface).length === ids.size &&
        Object.entries(observation.surface).every(
          ([id, value]) =>
            ids.has(id) &&
            [true, false, null].includes(value.visible) &&
            typeof value.changed === "boolean",
        ),
      "Invalid live surface evidence.",
    );
    assert(
      Array.isArray(observation.tracks) &&
        observation.tracks.every(
          (track) =>
            typeof track.track_id === "string" &&
            track.track_id &&
            box(track.box) &&
            typeof track.observed === "boolean" &&
            (track.table_id === null || ids.has(track.table_id)) &&
            Array.isArray(track.candidate_table_ids) &&
            track.candidate_table_ids.every((id) => ids.has(id)),
        ) &&
        new Set(observation.tracks!.map((track) => track.track_id)).size ===
          observation.tracks!.length,
      "Invalid live track evidence.",
    );
  }
  function plan(observation: LiveObservation) {
    if (config.detection_only || stopped) return;
    for (const m of core.memories) {
      const reference = m.table.reference;
      const baseline = approvedObjectBaseline(m.table);
      if (!baseline) {
        m.surfaceReason =
          "Approve expected objects and a reset reference in table setup.";
        continue;
      }
      if (
        pending.has(m.table.id) ||
        !core.assessmentEligible(m, observation.t) ||
        !core.assessmentEligible(m, now) ||
        (m.surface === "cleared_reset" && m.readinessSource !== "automatic") ||
        observation.t + EPS < m.nextDue ||
        !reference?.confirmed_clean ||
        !reference.sha256 ||
        reference.source_t > observation.t
      )
        continue;
      const request: LiveAssessmentRequest = {
        id: `live:${config.session_id}:${config.epoch}:${encodeURIComponent(m.table.id)}:${m.generation}:${observation.frame_index}`,
        session_id: config.session_id,
        epoch: config.epoch,
        calibration_id: config.calibration_id,
        table_id: m.table.id,
        t: observation.t,
        frame_index: observation.frame_index,
        frame_sha256: observation.frame_sha256,
        generation: m.generation,
        geometry_sha256: m.table.geometry_sha256!,
        reference_sha256: reference.sha256,
        surface_method: m.table.surface_method,
        baseline_sha256: baseline.baseline_sha256,
        config_sha256: baseline.config_sha256,
      };
      pending.set(m.table.id, request);
      outgoing.push({ ...request });
      m.nextDue = observation.t + core.requestRetry(m);
    }
  }
  function assessment(result: LiveSurfaceAssessment) {
    const m = core.byId[result.table_id],
      request = pending.get(result.table_id);
    if (m) result = normalizeObjectAssessment(m.table, result);
    const identity = [
      "session_id",
      "epoch",
      "calibration_id",
      "table_id",
      "t",
      "frame_index",
      "frame_sha256",
      "generation",
      "geometry_sha256",
      "reference_sha256",
      "surface_method",
      "baseline_sha256",
      "config_sha256",
      "timing_profile",
    ] as const;
    let reason: string | null = null;
    if (!m || !request || result.request_id !== request.id)
      reason = "Assessment does not match a current outstanding request.";
    else if (identity.some((key) => result[key] !== request[key]))
      reason =
        "Assessment session, generation, capture or reference identity mismatch.";
    else if (
      usesObjectSurface(m.table) &&
      (!approvedObjectBaseline(m.table) ||
        result.baseline_sha256 !== m.table.object_baseline?.baseline_sha256 ||
        result.config_sha256 !== m.table.object_baseline?.config_sha256)
    )
      reason =
        "Assessment belongs to an outdated baseline or comparison configuration.";
    else if (
      !finite(result.available_t) ||
      result.available_t > now + EPS ||
      result.available_t < result.t ||
      now - result.t > config.evidence_max_age_s + EPS
    )
      reason = "Assessment is stale or has an invalid availability timestamp.";
    else if (
      !core.assessmentEligible(m, result.t) ||
      !core.assessmentEligible(m, now) ||
      m.generation !== result.generation
    )
      reason =
        "Assessment needs fresh absence and a continuously visible surface in this generation.";
    else if (
      !hash(result.crop_sha256) ||
      typeof result.id !== "string" ||
      !result.id ||
      typeof result.valid !== "boolean" ||
      !["cleared_reset", "not_reset", "unobservable"].includes(
        result.outcome,
      ) ||
      typeof result.reason !== "string"
    )
      reason = "Malformed surface assessment.";
    else if (
      m.positive &&
      result.outcome === "cleared_reset" &&
      result.t - m.positive.t + EPS <
        (config.rules.assessment_separation_s ?? 2)
    )
      reason = "Positive captures are not sufficiently separated.";
    if (reason) {
      events.push({
        t: now,
        table_id: result.table_id,
        kind: "assessment_rejected",
        status: m ? core.service(m) : "unknown",
        reason,
        event_id: result.id,
      });
      return;
    }
    pending.delete(result.table_id);
    if (
      m.positive &&
      now - m.positive.t >
        (usesObjectSurface(m.table)
          ? OBJECT_SURFACE_CONFIG.clearance_ttl_s
          : config.evidence_max_age_s) +
          EPS
    )
      m.positive = null;
    core.applySurface(m, result, now);
    events.push({
      t: now,
      table_id: result.table_id,
      kind: "assessment_accepted",
      status: core.service(m),
      reason: m.surfaceReason,
      event_id: result.id,
    });
  }
  return {
    send(command) {
      if (command.op === "init")
        throw new Error(
          "Create a new live session to initialize another epoch.",
        );
      assert(!stopped || command.op === "stop", "Live session is stopped.");
      const t =
        command.op === "observation" || command.op === "assessment"
          ? command.now
          : command.op === "staff"
            ? command.event.t
            : command.t;
      if (command.op === "observation")
        validateObservation(command.observation, t);
      begin(t, command.op === "observation");
      if (command.op === "observation") {
        if (
          Number.isFinite(lastCapture) &&
          command.observation.t - lastCapture > config.rules.gap_s + EPS
        )
          for (const m of core.memories)
            if (m.table.monitoring_enabled !== false)
              core.failure(
                m,
                now,
                "Capture gap; occupancy and readiness need new evidence.",
              );
        core.observe(
          command.observation,
          (id) => command.observation.t + EPS >= captureFloors.get(id)!,
        );
        core.timers(now, false);
        lastCapture = command.observation.t;
        lastFrame = command.observation.frame_index;
        for (const [id, request] of pending)
          if (core.byId[id].generation !== request.generation)
            pending.delete(id);
        plan(command.observation);
        reapplyStaff();
      } else if (command.op === "assessment") {
        assessment(command.result);
        reapplyStaff();
      } else if (command.op === "staff") {
        validateStaffEvents([command.event], ids, Infinity);
        assert(
          command.event.source === "staff" && command.event.seq > lastStaffSeq,
          "Live staff commands require increasing sequence numbers.",
        );
        lastStaffSeq = command.event.seq;
        sameTimeStaff.push(command.event);
        events.push(core.applyStaff(command.event));
      } else if (command.op === "monitoring") {
        assert(
          typeof command.enabled === "boolean",
          "Monitoring must be boolean.",
        );
        core.resetTable(command.table_id, now, command.enabled);
        captureFloors.set(command.table_id, now);
        pending.delete(command.table_id);
        for (let i = sameTimeStaff.length - 1; i >= 0; i--)
          if (sameTimeStaff[i].table_id === command.table_id)
            sameTimeStaff.splice(i, 1);
      } else if (command.op === "rename") {
        const label =
          typeof command.label === "string" ? command.label.trim() : "";
        assert(
          label.length > 0 &&
            [...label].length <= 40 &&
            !core.memories.some(
              (m) =>
                m.table.id !== command.table_id &&
                m.table.label.toLocaleLowerCase() === label.toLocaleLowerCase(),
            ),
          "Table names need 1–40 characters and must be unique.",
        );
        assert(core.byId[command.table_id], "Unknown table.");
        core.byId[command.table_id].table = {
          ...core.byId[command.table_id].table,
          label,
        };
      } else if (command.op === "stop") {
        stopped = true;
        pending.clear();
        outgoing = [];
        for (const m of core.memories)
          core.failure(
            m,
            now,
            "Camera stopped; automatic evidence is unavailable.",
          );
      }
      return reply();
    },
  };
}
