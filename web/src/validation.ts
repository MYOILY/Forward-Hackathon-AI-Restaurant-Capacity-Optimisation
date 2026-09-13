import type {
  Bundle,
  Box,
  ExpectedObject,
  ImageAsset,
  StaffEvent,
  SurfaceAssessment,
} from "../../shared/contracts";
import {
  isObjectBaseline,
  isObjectSurfaceEvidence,
  OBJECT_CLASSES,
  OBJECT_SURFACE_METHOD,
} from "./object-surface";
function fail(message: string): never {
  throw new Error(message);
}
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const unit = (v: unknown): v is number => finite(v) && v >= 0 && v <= 1;
export function isSafeMediaPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[\\?#:\u0000-\u001f]/.test(value) &&
    !value.startsWith("/") &&
    value
      .split("/")
      .every(
        (p) => p !== "" && p !== "." && p !== ".." && !/%2e|%2f|%5c/i.test(p),
      )
  );
}
const point = (v: unknown): boolean =>
  Array.isArray(v) && v.length === 2 && v.every(unit);
const box = (v: unknown): v is Box =>
  Array.isArray(v) &&
  v.length === 4 &&
  v.every(unit) &&
  v[0] < v[2] &&
  v[1] < v[3];
const hash = (v: unknown): v is string =>
  typeof v === "string" && /^[a-fA-F0-9]{64}$/.test(v);
/** Uploaded source photos and floor plans are bounded, local, content-addressed images. */
export function validateImageAsset(
  value: unknown,
  label = "Image asset",
): asserts value is ImageAsset {
  if (
    !object(value) ||
    !isSafeMediaPath(value.file) ||
    !hash(value.sha256) ||
    !["width", "height"].every(
      (key) =>
        Number.isSafeInteger(value[key]) &&
        (value[key] as number) > 0 &&
        (value[key] as number) <= 8192,
    ) ||
    (value.width as number) * (value.height as number) > 16000000
  )
    fail(
      `${label} requires a safe media path, SHA-256, and dimensions within 8192 pixels and 16 megapixels.`,
    );
}
/** Saved editing progress only; these counts never confer baseline approval. */
export function validateExpectedObjectsDraft(
  value: unknown,
): asserts value is ExpectedObject[] {
  if (!Array.isArray(value) || value.length > OBJECT_CLASSES.length)
    fail("Expected-object drafts must contain supported class/count pairs.");
  const seen = new Set<number>();
  for (const item of value) {
    if (
      !object(item) ||
      Object.keys(item).length !== 2 ||
      !Number.isSafeInteger(item.class_id) ||
      !OBJECT_CLASSES.some((entry) => entry.class_id === item.class_id) ||
      !Number.isSafeInteger(item.count) ||
      (item.count as number) < 0 ||
      (item.count as number) > 100 ||
      seen.has(item.class_id as number)
    )
      fail("Invalid or duplicate expected-object draft category or count.");
    seen.add(item.class_id as number);
  }
}
/** Uploaded reference source time means availability from the start, not a video capture. */
export function validateReferenceImageSource(
  reference: unknown,
  dimensions?: {
    width: number;
    height: number;
  },
): void {
  if (!object(reference)) fail("Invalid table reference.");
  if (
    reference.source_kind !== undefined &&
    !["uploaded_image", "video_frame"].includes(reference.source_kind as string)
  )
    fail("Invalid reference image source kind.");
  if (
    reference.alignment_confirmed !== undefined &&
    typeof reference.alignment_confirmed !== "boolean"
  )
    fail("Reference image alignment approval must be boolean.");
  if (reference.source_kind === "uploaded_image") {
    validateImageAsset(
      reference.source_image,
      "Uploaded reference source image",
    );
    if (reference.alignment_confirmed !== true || reference.source_t !== 0)
      fail(
        "Uploaded references require confirmed alignment and availability from source time zero.",
      );
    if (
      dimensions &&
      (reference.source_image.width !== dimensions.width ||
        reference.source_image.height !== dimensions.height)
    )
      fail(
        "Uploaded reference source image dimensions must match the source video.",
      );
  } else if (
    reference.source_image !== undefined ||
    reference.alignment_confirmed !== undefined
  )
    fail(
      "External reference images and alignment metadata require uploaded_image source provenance.",
    );
}
function polygon(value: unknown, quadrilateral = false): boolean {
  if (
    !Array.isArray(value) ||
    value.length < 3 ||
    (quadrilateral && value.length !== 4) ||
    !value.every(point)
  )
    return false;
  const points = value as [number, number][];
  const cross = (a: number[], b: number[], c: number[]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
    if (a[0] === b[0] && a[1] === b[1]) return false;
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      const c = points[j],
        d = points[(j + 1) % points.length];
      if (
        cross(a, b, c) * cross(a, b, d) <= 0 &&
        cross(c, d, a) * cross(c, d, b) <= 0
      )
        return false;
    }
  }
  return Math.abs(area) > 1e-10;
}
export function validateAssessment(
  value: unknown,
): asserts value is SurfaceAssessment {
  if (
    !object(value) ||
    !["id", "request_id", "table_id", "reason", "model"].every(
      (k) => typeof value[k] === "string",
    ) ||
    !value.id ||
    !value.request_id ||
    !value.table_id
  )
    fail("Invalid assessment identity or metadata.");
  validateSurfaceIdentity(value);
  if (!isObjectSurfaceEvidence(value.object_evidence))
    fail(
      "Surface assessment requires raw object and reference comparison evidence.",
    );
  if (
    value.prompt_version !== undefined &&
    typeof value.prompt_version !== "string"
  )
    fail("Invalid assessment prompt metadata.");
  if (
    !finite(value.t) ||
    value.t < 0 ||
    !Number.isSafeInteger(value.frame_index) ||
    (value.frame_index as number) < 0 ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 0
  )
    fail("Invalid assessment source time or generation.");
  if (
    ![
      "video_sha256",
      "geometry_sha256",
      "reference_sha256",
      "crop_sha256",
    ].every((k) => hash(value[k])) ||
    !isSafeMediaPath(value.crop_file)
  )
    fail("Invalid assessment hash or crop path.");
  if (
    typeof value.valid !== "boolean" ||
    !["cleared_reset", "not_reset", "unobservable"].includes(
      value.outcome as string,
    )
  )
    fail("Invalid surface assessment outcome.");
}
function validateSurfaceIdentity(value: Record<string, unknown>) {
  if (value.surface_method !== OBJECT_SURFACE_METHOD)
    fail(
      "This recording uses retired surface evidence. Reprocess the original video with TurnTable.",
    );
  if (
    value.timing_profile !== undefined &&
    value.timing_profile !== "demo_fast_3x"
  )
    fail("Invalid assessment timing identity.");
  if (!["baseline_sha256", "config_sha256"].every((key) => hash(value[key])))
    fail("Object surface evidence requires baseline and configuration hashes.");
}
export function canonicalObjectJson(value: unknown): string {
  // Match Python canonical_sha256: sorted compact JSON, ensure_ascii=False.
  // These contracts contain integer counts plus finite configuration fractions.
  const encode = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    if (object(item))
      return `{${Object.keys(item)
        .sort()
        .map((key) => `${encode(key)}:${encode(item[key])}`)
        .join(",")}}`;
    if (typeof item === "number") {
      if (!Number.isFinite(item))
        fail("Canonical object data requires finite numbers.");
      if (item !== 0 && Math.abs(item) < 0.0001)
        return item.toExponential().replace(/e([+-])(\d)$/, "e$10$2");
    }
    const encoded = JSON.stringify(item);
    if (encoded === undefined)
      fail("Canonical object data cannot contain undefined.");
    return encoded;
  };
  return encode(value);
}
/** Content verification at browser load and headless init; the synchronous engine verifies identity. */
export async function verifyBundleGeometry(bundle: Bundle): Promise<void> {
  for (const table of bundle.tables) {
    const canonical = JSON.stringify({
      occupancy_regions: table.occupancy_regions,
      tabletop_polygon: table.tabletop_polygon,
    });
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical),
    );
    const actual = [...new Uint8Array(digest)]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    if (actual !== table.geometry_sha256?.toLowerCase())
      fail(`Geometry content hash mismatch for ${table.id}.`);
    if (table.object_baseline) {
      const { baseline_sha256, ...baseline } = table.object_baseline;
      const content = {
        ...baseline,
        expected: [...baseline.expected].sort(
          (a, b) => a.class_id - b.class_id,
        ),
      };
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonicalObjectJson(content)),
      );
      const actual = [...new Uint8Array(digest)]
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
      if (actual !== baseline_sha256.toLowerCase())
        fail(`Expected-object baseline content hash mismatch for ${table.id}.`);
    }
  }
}
export function validateStaffEvents(
  events: unknown,
  tableIds: Set<string>,
  duration: number,
): asserts events is StaffEvent[] {
  if (!Array.isArray(events)) fail("Staff events must be an array.");
  const ids = new Set<string>();
  for (const event of events as unknown[]) {
    if (
      !object(event) ||
      typeof event.id !== "string" ||
      !event.id ||
      ids.has(event.id)
    )
      fail("Staff event IDs must be nonempty and unique.");
    ids.add(event.id);
    if (
      !finite(event.t) ||
      event.t < 0 ||
      event.t > duration ||
      !Number.isSafeInteger(event.seq) ||
      (event.seq as number) < 0
    )
      fail("Invalid staff event time or sequence.");
    if (typeof event.table_id !== "string" || !tableIds.has(event.table_id))
      fail("Unknown table in staff event.");
    if (event.action === "force_cleaned" && event.source !== "staff")
      fail("Force clean is supported only for staff events.");
    if (
      ["force_status", "clear_status_override"].includes(
        event.action as string,
      ) &&
      event.source !== "staff"
    )
      fail("Service colour overrides are supported only for staff events.");
    if (
      event.action === "force_status"
        ? !["ready", "occupied", "needs_cleaning", "unknown"].includes(
            event.status as string,
          )
        : event.status !== undefined
    )
      fail(
        "Only force_status may carry a status, and it must specify a valid service colour.",
      );
    if (
      ![
        "confirm_cleaned",
        "needs_cleaning",
        "force_cleaned",
        "force_status",
        "clear_status_override",
      ].includes(event.action as string) ||
      !["setup", "staff"].includes(event.source as string)
    )
      fail("Invalid staff action or source.");
  }
}
export function validateBundle(value: unknown): asserts value is Bundle {
  if (
    !object(value) ||
    value.schema_version !== 2 ||
    value.policy !== "automatic_v2"
  )
    fail(
      "This recording uses an unsupported analysis format. Reprocess the original video with TurnTable to open it.",
    );
  if (
    !["real_video", "synthetic_fixture", "ai_generated_video"].includes(
      value.provenance as string,
    )
  )
    fail("Bundle provenance is missing or invalid.");
  const video = value.video;
  if (
    !object(video) ||
    !isSafeMediaPath(video.file) ||
    typeof video.sha256 !== "string" ||
    !/^[a-fA-F0-9]{64}$/.test(video.sha256)
  )
    fail("Invalid video media path or SHA-256 hash.");
  for (const key of ["width", "height", "fps", "duration_s"])
    if (!finite(video[key]) || (video[key] as number) <= 0)
      fail(`Invalid video ${key}.`);
  if (!Number.isInteger(video.width) || !Number.isInteger(video.height))
    fail("Video dimensions must be integers.");
  const duration = video.duration_s as number;
  if (value.original_scene !== null && !isSafeMediaPath(value.original_scene))
    fail("Invalid original scene path.");
  if (value.floor_plan !== undefined) {
    validateImageAsset(value.floor_plan, "Floor plan");
  }
  const rules = value.rules;
  if (
    !object(rules) ||
    !["entry_s", "exit_s", "gap_s"].every(
      (k) => finite(rules[k]) && (rules[k] as number) > 0,
    )
  )
    fail("Timing rules must be positive seconds.");
  const demoTiming = rules.demo_timing_scale !== undefined;
  if (demoTiming) {
    if (
      rules.demo_timing_scale !== 3 ||
      !["ai_generated_video", "synthetic_fixture"].includes(
        value.provenance as string,
      )
    )
      fail(
        "Accelerated timing is limited to explicitly labelled AI or synthetic demos.",
      );
    const expected = {
      entry_s: 5 / 3,
      exit_s: 5 / 3,
      assessment_separation_s: 2 / 3,
      assessment_retry_s: 5 / 3,
      gap_s: 1,
      track_grace_s: 1,
    };
    if (
      !Object.entries(expected).every(
        ([key, seconds]) =>
          finite(rules[key]) &&
          Math.abs((rules[key] as number) - seconds) <= 1e-9,
      )
    )
      fail(
        "demo_fast_3x requires its exact decision waits and unchanged frame freshness.",
      );
  }
  if (!Array.isArray(value.tables) || value.tables.length === 0)
    fail("Bundle needs at least one table.");
  if (
    !demoTiming &&
    value.tables.some(
      (table) =>
        object(table) && table.surface_method === OBJECT_SURFACE_METHOD,
    ) &&
    ((rules.entry_s as number) < 5 ||
      (rules.entry_s as number) > 10 ||
      !finite(rules.assessment_separation_s) ||
      rules.assessment_separation_s < 2 ||
      !finite(rules.assessment_retry_s) ||
      rules.assessment_retry_s > 5)
  )
    fail(
      "Normal object assessment requires 5–10s dwell and at least 2s confirmation separation; shortened waits require an explicit demo profile.",
    );
  const tableIds = new Set<string>();
  for (const table of value.tables as unknown[]) {
    if (
      !object(table) ||
      typeof table.id !== "string" ||
      !table.id ||
      tableIds.has(table.id)
    )
      fail("Table IDs must be nonempty and unique.");
    tableIds.add(table.id);
    if (
      table.monitoring_enabled !== undefined &&
      typeof table.monitoring_enabled !== "boolean"
    )
      fail(`Monitoring configuration for ${table.id} must be a boolean value.`);
    if (table.expected_objects_draft !== undefined) {
      validateExpectedObjectsDraft(table.expected_objects_draft);
    }
    if (
      table.setup_review !== undefined &&
      (!object(table.setup_review) ||
        Object.keys(table.setup_review).length !== 3 ||
        !["tabletop", "occupancy", "map"].every(
          (key) =>
            typeof (table.setup_review as Record<string, unknown>)[key] ===
            "boolean",
        ))
    )
      fail(`Invalid setup review flags for ${table.id}.`);
    if (
      typeof table.label !== "string" ||
      !box(table.video_region) ||
      !box(table.crop)
    )
      fail(`Invalid geometry for ${table.id}.`);
    if (
      table.capacity !== undefined &&
      (!Number.isSafeInteger(table.capacity) || (table.capacity as number) < 0)
    )
      fail(`Invalid capacity for ${table.id}.`);
    if (
      table.seat_regions !== undefined &&
      (!Array.isArray(table.seat_regions) ||
        !table.seat_regions.every(
          (p) => Array.isArray(p) && p.length >= 3 && p.every(point),
        ))
    )
      fail(`Invalid seating polygon for ${table.id}.`);
    if (
      table.chairs !== undefined &&
      (!Array.isArray(table.chairs) || !table.chairs.every(point))
    )
      fail(`Invalid chair coordinates for ${table.id}.`);
    if (
      !polygon(table.tabletop_polygon, true) ||
      !Array.isArray(table.occupancy_regions) ||
      !table.occupancy_regions.length ||
      !table.occupancy_regions.every((p) => polygon(p)) ||
      !hash(table.geometry_sha256)
    )
      fail(`Invalid table polygons or geometry hash for ${table.id}.`);
    const map = table.map;
    if (
      !object(map) ||
      !unit(map.x) ||
      !unit(map.y) ||
      !unit(map.w) ||
      !unit(map.h) ||
      map.w <= 0 ||
      map.h <= 0 ||
      !["rect", "round"].includes(map.shape as string)
    )
      fail(`Invalid map position for ${table.id}.`);
    if (
      map.rotation !== undefined &&
      (!finite(map.rotation) || map.rotation < 0 || map.rotation >= 360)
    )
      fail(`Invalid map rotation for ${table.id}.`);
    if (
      table.reference !== null &&
      (!object(table.reference) ||
        !isSafeMediaPath(table.reference.file) ||
        !finite(table.reference.source_t) ||
        table.reference.source_t < 0 ||
        table.reference.source_t > duration ||
        typeof table.reference.confirmed_clean !== "boolean")
    )
      fail(`Invalid reference for ${table.id}.`);
    if (object(table.reference) && !hash(table.reference.sha256))
      fail(`Missing reference content hash for ${table.id}.`);
    if (object(table.reference)) {
      validateReferenceImageSource(table.reference, {
        width: video.width as number,
        height: video.height as number,
      });
    }
    if (
      table.surface_method !== undefined &&
      table.surface_method !== OBJECT_SURFACE_METHOD
    )
      fail(`Unsupported surface method for ${table.id}.`);
    if (demoTiming && table.surface_method !== OBJECT_SURFACE_METHOD)
      fail(
        "Accelerated demo timing requires object/reference assessment tables.",
      );
    if (
      table.object_baseline !== undefined &&
      (table.surface_method !== OBJECT_SURFACE_METHOD ||
        !isObjectBaseline(table.object_baseline) ||
        table.object_baseline.geometry_sha256 !== table.geometry_sha256 ||
        !object(table.reference) ||
        table.object_baseline.reference_sha256 !== table.reference.sha256)
    )
      fail(`Invalid expected-object baseline for ${table.id}.`);
  }
  if (!Array.isArray(value.observations))
    fail("Observations must be an array.");
  let previous = -Infinity;
  for (const observation of value.observations as unknown[]) {
    if (
      !object(observation) ||
      !finite(observation.t) ||
      observation.t < 0 ||
      observation.t > duration ||
      observation.t <= previous
    )
      fail(
        "Observation timestamps must increase without duplicates and stay inside the video.",
      );
    previous = observation.t;
    if (
      !Number.isSafeInteger(observation.frame_index) ||
      (observation.frame_index as number) < 0 ||
      typeof observation.valid !== "boolean" ||
      !object(observation.tables)
    )
      fail("Invalid observation metadata.");
    if (
      Object.keys(observation.tables).length !== tableIds.size ||
      Object.keys(observation.tables).some((id) => !tableIds.has(id))
    )
      fail("Observation contains missing or unknown table IDs.");
    for (const presence of Object.values(observation.tables))
      if (!["present", "absent", "uncertain"].includes(presence as string))
        fail("Invalid presence observation.");
    if (
      !observation.valid &&
      Object.values(observation.tables).some(
        (presence) => presence !== "uncertain",
      )
    )
      fail("Invalid analysis must mark every table uncertain.");
    if (!Array.isArray(observation.detections))
      fail("Detections must be an array.");
    for (const detection of observation.detections as unknown[])
      if (
        !object(detection) ||
        !Number.isSafeInteger(detection.class_id) ||
        (detection.class_id as number) < 0 ||
        !unit(detection.score) ||
        !box(detection.box)
      )
        fail("Invalid detection coordinates or score.");
    {
      if (
        !Array.isArray(observation.tracks) ||
        !object(observation.surface) ||
        Object.keys(observation.surface).length !== tableIds.size ||
        Object.keys(observation.surface).some((id) => !tableIds.has(id))
      )
        fail("Analysis requires tracks and surface evidence for every table.");
      const trackIds = new Set<string>();
      for (const track of observation.tracks as unknown[]) {
        if (
          !object(track) ||
          typeof track.track_id !== "string" ||
          !track.track_id ||
          trackIds.has(track.track_id) ||
          !box(track.box) ||
          !unit(track.score) ||
          typeof track.observed !== "boolean" ||
          (track.table_id !== null &&
            !tableIds.has(track.table_id as string)) ||
          !Array.isArray(track.candidate_table_ids) ||
          track.candidate_table_ids.some((id) => !tableIds.has(id as string))
        )
          fail("Invalid or duplicate track evidence.");
        trackIds.add(track.track_id);
      }
      for (const evidence of Object.values(observation.surface))
        if (
          !object(evidence) ||
          ![true, false, null].includes(evidence.visible as boolean | null) ||
          typeof evidence.changed !== "boolean" ||
          (evidence.camera_moved !== undefined &&
            typeof evidence.camera_moved !== "boolean")
        )
          fail("Invalid surface visibility evidence.");
    }
  }
  validateStaffEvents(value.staff_events, tableIds, duration);
  if (!object(value.analysis)) fail("Analysis metadata must be an object.");
  if (
    demoTiming
      ? value.analysis.timing_profile !== "demo_fast_3x"
      : value.analysis.timing_profile !== undefined
  )
    fail("Demo timing metadata must match the explicit timing rules.");
  {
    for (const name of [
      "assessment_separation_s",
      "assessment_retry_s",
      "track_grace_s",
    ])
      if (
        rules[name] !== undefined &&
        (!finite(rules[name]) || rules[name] <= 0)
      )
        fail(`Invalid ${name}.`);
    if (value.assessments !== undefined) {
      if (!Array.isArray(value.assessments))
        fail("Assessments must be an array.");
      for (const assessment of value.assessments) {
        validateAssessment(assessment);
        if (
          assessment.timing_profile !==
          (demoTiming ? "demo_fast_3x" : undefined)
        )
          fail("Assessment timing profile differs from its bundle.");
      }
    }
    if (value.assessment_requests !== undefined) {
      if (!Array.isArray(value.assessment_requests))
        fail("Assessment requests must be an array.");
      const requestIds = new Set<string>();
      for (const request of value.assessment_requests as unknown[]) {
        if (
          !object(request) ||
          typeof request.id !== "string" ||
          !request.id ||
          requestIds.has(request.id)
        )
          fail("Assessment request IDs must be nonempty and unique.");
        requestIds.add(request.id);
        if (
          typeof request.table_id !== "string" ||
          !tableIds.has(request.table_id)
        )
          fail("Assessment request references an unknown table.");
        if (
          !finite(request.t) ||
          request.t < 0 ||
          request.t > duration ||
          !Number.isSafeInteger(request.frame_index) ||
          (request.frame_index as number) < 0 ||
          !Number.isSafeInteger(request.generation) ||
          (request.generation as number) < 0
        )
          fail("Invalid assessment request timestamp, frame, or generation.");
        if (
          !["video_sha256", "geometry_sha256", "reference_sha256"].every(
            (key) => hash(request[key]),
          )
        )
          fail("Invalid assessment request identity hashes.");
        validateSurfaceIdentity(request);
        const table = (value.tables as unknown as Bundle["tables"]).find(
          (table) => table.id === request.table_id,
        );
        const baseline = table?.object_baseline;
        if (
          !table ||
          table.surface_method !== OBJECT_SURFACE_METHOD ||
          !baseline?.approved ||
          request.baseline_sha256 !== baseline.baseline_sha256 ||
          request.config_sha256 !== baseline.config_sha256 ||
          request.video_sha256 !== video.sha256 ||
          request.geometry_sha256 !== table.geometry_sha256 ||
          request.reference_sha256 !== table.reference?.sha256
        )
          fail(
            "Assessment request does not match its approved table baseline and recording.",
          );
        if (
          !(value.observations as unknown as Bundle["observations"]).some(
            (observation) =>
              observation.t === request.t &&
              observation.frame_index === request.frame_index,
          )
        )
          fail("Assessment request does not match an observed source capture.");
        if (
          request.timing_profile !== (demoTiming ? "demo_fast_3x" : undefined)
        )
          fail("Assessment request timing profile differs from its bundle.");
      }
    }
  }

  for (const result of (value.assessments ?? []) as SurfaceAssessment[]) {
    const request = (
      (value.assessment_requests ?? []) as Bundle["assessment_requests"]
    )?.find((request) => request.id === result.request_id);
    const keys = [
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
    ] as const;
    if (!request || keys.some((key) => request[key] !== result[key]))
      fail("Assessment result does not match its recorded request.");
  }
}
