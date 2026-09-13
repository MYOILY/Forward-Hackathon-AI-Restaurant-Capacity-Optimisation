import { createHash } from "node:crypto";
import type {
  AssessmentRequest,
  Bundle,
  Observation,
  SurfaceAssessment,
  TrackEvidence,
} from "../../shared/contracts";

export const FRAME_HASH = "c".repeat(64);

export function replayFixture(
  duration = 40,
  change?: (observation: Observation) => void,
  tableCount = 1,
): Bundle {
  const tables = Array.from({ length: tableCount }, (_, index) => {
    const polygon: [number, number][] = [
      [0.2, 0.2],
      [0.8, 0.2],
      [0.8, 0.8],
      [0.2, 0.8],
    ];
    const regions = [
      [
        [0.1, 0.1],
        [0.9, 0.1],
        [0.9, 0.9],
        [0.1, 0.9],
      ],
    ] as [number, number][][];
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          occupancy_regions: regions,
          tabletop_polygon: polygon,
        }),
      )
      .digest("hex");
    return {
      id: `T${index + 1}`,
      label: `Table ${index + 1}`,
      video_region: [0.2, 0.2, 0.8, 0.8] as [number, number, number, number],
      crop: [0.2, 0.2, 0.8, 0.8] as [number, number, number, number],
      tabletop_polygon: polygon,
      occupancy_regions: regions,
      geometry_sha256: digest,
      map: {
        x: ((index % 5) + 0.5) / 5,
        y: (Math.floor(index / 5) + 0.5) / Math.ceil(tableCount / 5),
        w: 0.12,
        h: 0.12,
        shape: "rect" as const,
      },
      reference: {
        file: `references/T${index + 1}.png`,
        source_t: 0,
        confirmed_clean: true,
        sha256: "b".repeat(64),
        reviewed_by: "independent synthetic fixture",
      },
    };
  });
  const observations: Observation[] = Array.from(
    { length: duration * 10 + 1 },
    (_, index) => {
      const observation: Observation = {
        t: index / 10,
        frame_index: index,
        valid: true,
        detections: [],
        tables: Object.fromEntries(tables.map((table) => [table.id, "absent"])),
        tracks: [],
        surface: Object.fromEntries(
          tables.map((table) => [table.id, { visible: true, changed: false }]),
        ),
      };
      change?.(observation);
      return observation;
    },
  );
  return {
    schema_version: 2,
    policy: "automatic_v2",
    provenance: "synthetic_fixture",
    video: {
      file: "video.mp4",
      sha256: "a".repeat(64),
      width: 640,
      height: 360,
      fps: 10,
      duration_s: duration,
    },
    original_scene: "original.png",
    tables,
    observations,
    staff_events: [],
    assessment_requests: [],
    assessments: [],
    rules: {
      entry_s: 5,
      exit_s: 5,
      gap_s: 1,
      assessment_separation_s: 2,
      assessment_retry_s: 5,
      track_grace_s: 1,
    },
    analysis: { sample_hz: 10, fixture_only: true },
  };
}

export function person(
  observation: Observation,
  id = "clip:person-1",
  tableId = "T1",
  observed = true,
): void {
  const track: TrackEvidence = {
    track_id: id,
    box: [0.3, 0.1, 0.6, 0.8],
    score: 0.9,
    observed,
    table_id: tableId,
    candidate_table_ids: [tableId],
  };
  observation.tracks!.push(track);
  if (observed) {
    observation.tables[tableId] = "present";
    observation.detections.push({ class_id: 0, score: 0.9, box: track.box });
  }
}

export function assessment(
  request: AssessmentRequest,
  outcome: SurfaceAssessment["outcome"] = "cleared_reset",
  overrides: Partial<SurfaceAssessment> = {},
): SurfaceAssessment {
  return {
    id: `assessment-${request.id}`,
    request_id: request.id,
    table_id: request.table_id,
    t: request.t,
    frame_index: request.frame_index,
    generation: request.generation,
    video_sha256: request.video_sha256,
    geometry_sha256: request.geometry_sha256,
    reference_sha256: request.reference_sha256,
    crop_sha256: FRAME_HASH,
    crop_file: `surface/${request.table_id}-${request.frame_index}.png`,
    outcome,
    valid: true,
    reason:
      "Hand-authored synthetic surface evidence; never real model validation.",
    model: "synthetic_fixture",
    ...(request.surface_method
      ? {
          surface_method: request.surface_method,
          baseline_sha256: request.baseline_sha256,
          config_sha256: request.config_sha256,
          object_evidence: {
            detections: [
              {
                class_id: 41,
                score: 0.9,
                box: [0.1, 0.1, 0.4, 0.4] as [number, number, number, number],
              },
            ],
            reference: {
              observable: outcome !== "unobservable",
              brightness_offset: 0,
              changed_fraction: outcome === "not_reset" ? 0.2 : 0,
              largest_change_fraction: 0,
              edge_mismatch: null,
            },
          },
        }
      : { prompt_version: "synthetic-surface" }),
    ...overrides,
  };
}
