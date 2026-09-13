import { describe, expect, it } from "vitest";
import type { CalibrationTable, SourceInfo } from "../../shared/live-contracts";
import { objectBundle } from "./object-fixtures";
import {
  missingSetup,
  nextTableStep,
  resumeSetup,
  setupRequirements,
  tableCompletion,
} from "../../web/src/setup-guidance";
function source(): SourceInfo {
  const table: CalibrationTable = {
    ...objectBundle().tables[0],
    setup_review: { tabletop: true, occupancy: true, map: true },
  };
  return {
    id: "progress",
    kind: "video",
    label: "Fixture",
    status: "needs_setup",
    phase: "setup",
    progress: 1,
    revision: 0,
    calibration_confirmed: false,
    width: 640,
    height: 360,
    fps: 10,
    duration_s: 40,
    tables: [table],
    setup_mode: "guided_v1",
    setup_reference: {
      reference_source: "video_frame",
      reference_t: 0,
      alignment_confirmed: false,
    },
    floor_plan_mode: "schematic",
  };
}
describe("shared guided progress", () => {
  it("requires both approved inventory and approved reference", () => {
    const s = source(),
      t = s.tables[0];
    expect(tableCompletion(t).objects).toBe(true);
    t.reference = null;
    expect(tableCompletion(t).objects).toBe(false);
    t.reference_approved = true;
    expect(tableCompletion(t).objects).toBe(true);
    t.object_baseline!.approved = false;
    expect(tableCompletion(t).objects).toBe(false);
  });
  it("resumes the first unfinished monitored table at its first missing step", () => {
    const s = source();
    s.tables.push({
      ...structuredClone(s.tables[0]),
      id: "T2",
      setup_review: { tabletop: true, occupancy: false, map: false },
    });
    expect(resumeSetup(s)).toEqual({
      section: "tables",
      tableId: "T2",
      step: "occupancy",
    });
    s.tables[1].monitoring_enabled = false;
    expect(resumeSetup(s).section).toBe("review");
  });
  it("reports actionable identity and keeps string checklist in sync", () => {
    const s = source();
    s.tables[0].setup_review!.map = false;
    expect(nextTableStep(s.tables[0])).toBe("map");
    const requirements = setupRequirements(s);
    expect(requirements).toEqual([
      {
        tableId: s.tables[0].id,
        step: "map",
        message: expect.stringContaining("floor-plan position"),
      },
    ]);
    expect(missingSetup(s)).toEqual(requirements.map((r) => r.message));
  });
  it("prioritizes missing restaurant reference over table steps", () => {
    const s = source();
    s.setup_reference = {
      reference_source: "uploaded_image",
      reference_t: null,
      alignment_confirmed: false,
    };
    expect(resumeSetup(s).section).toBe("references");
    expect(setupRequirements(s)[0].step).toBe("references");
  });
  it("detection-only skips inventory but retains geometry review", () => {
    const s = source();
    s.tables[0].object_baseline = undefined;
    s.tables[0].setup_review!.map = false;
    expect(setupRequirements(s, s.tables, true).map((r) => r.step)).toEqual([
      "map",
    ]);
    expect(setupRequirements(s).map((r) => r.step)).toEqual(["map", "objects"]);
  });
  it("empty drafts lead to adding a table", () => {
    const s = source();
    s.tables = [];
    expect(resumeSetup(s)).toEqual({
      section: "tables",
      tableId: "",
      step: "tabletop",
    });
    expect(setupRequirements(s)[0].message).toContain("Add a table");
  });
});
