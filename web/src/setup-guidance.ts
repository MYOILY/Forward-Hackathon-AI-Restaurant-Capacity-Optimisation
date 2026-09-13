import type { CalibrationTable, SourceInfo } from "../../shared/live-contracts";

export const TABLE_STEPS = ["tabletop", "occupancy", "map", "objects"] as const;
export type TableStep = (typeof TABLE_STEPS)[number];
export const STEP_LABELS: Record<TableStep, string> = {
  tabletop: "Table corners",
  occupancy: "People zone",
  map: "Floor-plan position",
  objects: "Expected objects",
};
export type SetupRequirement = {
  tableId?: string;
  step: TableStep | "references";
  message: string;
};
export function tableCompletion(
  table: CalibrationTable,
): Record<TableStep, boolean> {
  return {
    tabletop: !!table.setup_review?.tabletop,
    occupancy: !!table.setup_review?.occupancy,
    map: !!table.setup_review?.map,
    objects:
      !!table.object_baseline?.approved &&
      !!(table.reference_approved || table.reference?.confirmed_clean),
  };
}
export function nextTableStep(table: CalibrationTable): TableStep | undefined {
  const complete = tableCompletion(table);
  return TABLE_STEPS.find((step) => !complete[step]);
}
export function setupRequirements(
  source: SourceInfo,
  tables: CalibrationTable[] = source.tables,
  detectionOnly = false,
): SetupRequirement[] {
  const missing: SetupRequirement[] = [];
  const add = (
    step: SetupRequirement["step"],
    message: string,
    tableId?: string,
  ) => missing.push({ step, message, tableId });
  if (!tables.length) add("tabletop", "Add a table and give it a name.");
  if (source.setup_mode === "guided_v1") {
    const reference = source.setup_reference;
    if (
      reference?.reference_source === "uploaded_image" &&
      (!source.setup_assets?.clean_reference || !reference.alignment_confirmed)
    )
      add(
        "references",
        "Upload a clean reference and confirm the camera framing matches.",
      );
    else if (
      reference?.reference_source === "video_frame" &&
      reference.reference_t == null
    )
      add("references", "Select a clean reference frame.");
    else if (
      !reference &&
      !tables.some(
        (table) =>
          table.reference ||
          table.reference_t != null ||
          (table.reference_source === "uploaded_image" &&
            table.alignment_confirmed),
      )
    )
      add(
        "references",
        "Select a clean reference frame or upload a clean photo.",
      );
    if (
      !source.floor_plan_mode ||
      (source.floor_plan_mode === "uploaded" &&
        !source.setup_assets?.floor_plan)
    )
      add("references", "Upload a floor plan or choose a schematic layout.");
    for (const table of tables.filter(
      (item) => item.monitoring_enabled !== false,
    )) {
      const complete = tableCompletion(table);
      if (!complete.tabletop)
        add(
          "tabletop",
          `${table.label}: mark and review the four tabletop corners.`,
          table.id,
        );
      if (!complete.occupancy)
        add("occupancy", `${table.label}: review the people zones.`, table.id);
      if (!complete.map)
        add(
          "map",
          `${table.label}: place and review its floor-plan position.`,
          table.id,
        );
      if (
        table.reference_source === "uploaded_image" &&
        !table.alignment_confirmed
      )
        add(
          "references",
          `${table.label}: confirm the uploaded reference uses the same camera framing.`,
          table.id,
        );
    }
  }
  if (!detectionOnly)
    for (const table of tables.filter(
      (item) => item.monitoring_enabled !== false,
    )) {
      if (!tableCompletion(table).objects)
        add(
          "objects",
          `${table.label}: review and approve expected objects and the clean reference.`,
          table.id,
        );
    }
  return missing;
}
/** Existing analysis consumers keep the same string interface. */
export function missingSetup(
  source: SourceInfo,
  tables: CalibrationTable[] = source.tables,
  detectionOnly = false,
): string[] {
  return setupRequirements(source, tables, detectionOnly).map(
    (item) => item.message,
  );
}
export function resumeSetup(source: SourceInfo): {
  section: "references" | "tables" | "review";
  tableId: string;
  step: TableStep;
} {
  const enabled = source.tables.filter(
    (table) => table.monitoring_enabled !== false,
  );
  const table =
    enabled.find((table) => nextTableStep(table)) ??
    enabled[0] ??
    source.tables[0];
  return {
    section: setupRequirements(source).some(
      (item) => item.step === "references",
    )
      ? "references"
      : table && !enabled.some((item) => nextTableStep(item))
        ? "review"
        : "tables",
    tableId: table?.id ?? "",
    step: table ? (nextTableStep(table) ?? "objects") : "tabletop",
  };
}
