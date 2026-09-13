import { useEffect, useRef, useState } from "react";
import type { CalibrationTable, SourceInfo } from "../../shared/live-contracts";
import type { Detection, ObjectBaseline, Point } from "../../shared/contracts";
import { api, assetPath, imageSource, jsonBody, validLabel } from "./api";
import { ExpectedInventory, ObjectPhoto, objectName } from "./ObjectEvidence";
import { FloorPlanEditor } from "./FloorPlanEditor";
import { contained } from "./floor-plan-geometry";
import {
  nextTableStep,
  resumeSetup,
  setupRequirements,
  STEP_LABELS,
  TABLE_STEPS,
  tableCompletion,
  type TableStep,
} from "./setup-guidance";
import "./guided-setup.css";

type Section = "references" | "tables" | "review";
type Reference = NonNullable<SourceInfo["setup_reference"]>;
type Evidence = { image: string; detections: Detection[] };
const unreviewed = { tabletop: false, occupancy: false, map: false };
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const bounds = (p: Point[]): [number, number, number, number] => [
  Math.min(...p.map((v) => v[0])),
  Math.min(...p.map((v) => v[1])),
  Math.max(...p.map((v) => v[0])),
  Math.max(...p.map((v) => v[1])),
];
const initialReference = (s: SourceInfo): Reference => {
  if (s.setup_reference) return s.setup_reference;
  const t = s.tables[0];
  const kind =
    t?.reference_source ??
    t?.reference?.source_kind ??
    (s.setup_assets?.clean_reference ? "uploaded_image" : "video_frame");
  return {
    reference_source: kind,
    reference_t:
      kind === "uploaded_image"
        ? null
        : (t?.reference_t ?? t?.reference?.source_t ?? null),
    ...(kind === "uploaded_image"
      ? {
          reference_image_sha256:
            t?.reference_image_sha256 ??
            s.setup_assets?.clean_reference?.sha256,
        }
      : {}),
    alignment_confirmed:
      t?.alignment_confirmed ?? t?.reference?.alignment_confirmed ?? false,
  };
};
const normalize = (s: SourceInfo) =>
  s.tables.map((t) => {
    const ref = initialReference(s),
      kind =
        t.reference_source ?? t.reference?.source_kind ?? ref.reference_source;
    return {
      ...t,
      setup_review: t.setup_review ?? { ...unreviewed },
      reference_source: kind,
      reference_t:
        kind === "uploaded_image"
          ? null
          : t.reference_t !== undefined
            ? t.reference_t
            : (t.reference?.source_t ?? ref.reference_t),
      reference_image_sha256:
        kind === "uploaded_image"
          ? (t.reference_image_sha256 ??
            s.setup_assets?.clean_reference?.sha256)
          : undefined,
      alignment_confirmed:
        t.alignment_confirmed ??
        t.reference?.alignment_confirmed ??
        ref.alignment_confirmed,
      reference_approved:
        t.reference_approved ?? t.reference?.confirmed_clean ?? false,
    };
  });
const geometryValid = (points?: Point[]) => {
  if (
    !points ||
    points.length !== 4 ||
    points.some((p) => p.some((n) => !Number.isFinite(n) || n < 0 || n > 1))
  )
    return false;
  const cross = points.map((a, i) => {
    const b = points[(i + 1) % 4],
      c = points[(i + 2) % 4];
    return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
  });
  return cross.every((n) => n > 0.000001) || cross.every((n) => n < -0.000001);
};

export function CalibrationEditor({
  source,
  onSaved,
  onCancel,
  onDirtyChange,
  initialSection,
}: {
  source: SourceInfo;
  initialSection?: "references";
  onSaved: (source: SourceInfo) => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [working, setWorking] = useState(source),
    [tables, setTables] = useState<CalibrationTable[]>(() => normalize(source));
  const initial = resumeSetup(source);
  const [section, setSection] = useState<Section>(
      initialSection ?? initial.section,
    ),
    [selected, setSelected] = useState(initial.tableId),
    [step, setStep] = useState<TableStep>(initial.step);
  const [reference, setReference] = useState<Reference>(() =>
      initialReference(source),
    ),
    [floorMode, setFloorMode] = useState(
      source.floor_plan_mode ??
        (source.setup_assets?.floor_plan ? "uploaded" : undefined),
    );
  const [drawings, setDrawings] = useState<Record<string, Point[]>>({}),
    [region, setRegion] = useState(0),
    [evidence, setEvidence] = useState<Record<string, Evidence>>({});
  const [frame, setFrame] = useState(
      source.frame_url ??
        (source.frame_base64 ? imageSource(source.frame_base64) : ""),
    ),
    [frameTime, setFrameTime] = useState(
      String(initialReference(source).reference_t ?? 0),
    );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [status, setStatus] = useState("Saved"),
    [leave, setLeave] = useState(false),
    [doneTable, setDoneTable] = useState<string | null>(null);
  const [cache, setCache] = useState<{
    revision: number;
    tables: CalibrationTable[];
    reference: Reference;
    floorMode?: SourceInfo["floor_plan_mode"];
    drawings: Record<string, Point[]>;
  } | null>(() => {
    try {
      return JSON.parse(
        localStorage.getItem(`tablewatch-edit-${source.id}`) ?? "null",
      );
    } catch {
      return null;
    }
  });
  const [cacheResolved, setCacheResolved] = useState(false);
  const svg = useRef<SVGSVGElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    errorBox = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    tableId: string;
    step: "tabletop" | "occupancy";
    region: number;
    index: number;
  } | null>(null);
  const revision = useRef(source.revision),
    lock = useRef(false),
    retry = useRef<null | (() => Promise<void>)>(null),
    serial = useRef(0);
  const tablesRef = useRef(tables);
  tablesRef.current = tables;
  const persistedIds = useRef(new Set(source.tables.map((t) => t.id)));
  const leaveDialog = useRef<HTMLDivElement>(null);
  const [numericCorners, setNumericCorners] = useState(false);
  const table = tables.find((t) => t.id === selected),
    drawing = drawings[selected],
    plan =
      floorMode === "uploaded" ? working.setup_assets?.floor_plan : undefined;
  const clean = working.setup_assets?.clean_reference;
  const cameraImage =
    reference.reference_source === "uploaded_image" && clean
      ? assetPath(source.id, clean.file)
      : frame;
  const viewSource: SourceInfo = {
    ...working,
    setup_mode: "guided_v1",
    setup_reference: reference,
    floor_plan_mode: floorMode,
    tables,
  };
  const requirements = setupRequirements(viewSource),
    referenceMissing = requirements.filter((r) => r.step === "references");
  const fingerprint = JSON.stringify({ tables, reference, floorMode });
  const saved = useRef(fingerprint);
  const dirty =
    fingerprint !== saved.current || Object.keys(drawings).length > 0;
  const complete = table
    ? tableCompletion(table)
    : { ...unreviewed, objects: false };
  const enabled = tables.filter((t) => t.monitoring_enabled !== false);
  const allComplete = enabled.length > 0 && requirements.length === 0;
  const width = 1000,
    height = (1000 * source.height) / source.width;
  const actionLabels = {
    tabletop: "Confirm corners & continue",
    occupancy: "Confirm people zone & continue",
    map: "Confirm position & continue",
    objects: "Approve objects & complete table",
  };
  let blocker = "";
  if (section === "references") blocker = referenceMissing[0]?.message ?? "";
  else if (section === "tables") {
    if (!table) blocker = "Add a table to begin.";
    else if (referenceMissing.length) blocker = referenceMissing[0].message;
    else if (table.monitoring_enabled === false)
      blocker =
        "Enable monitoring to review this table, or choose another table.";
    else if (drawing !== undefined && step === "tabletop")
      blocker = `Mark ${4 - drawing.length} more corner${drawing.length === 3 ? "" : "s"}.`;
    else if (step === "tabletop" && !geometryValid(table.tabletop_polygon))
      blocker = "Mark four corners in order around a non-crossing tabletop.";
    else if (
      step === "map" &&
      !contained(table.map, {
        width: plan?.width ?? 1000,
        height: plan?.height ?? 650,
      })
    )
      blocker = "Keep the entire table shape inside the floor plan.";
    else if (
      step === "occupancy" &&
      !(
        table.occupancy_regions?.length &&
        table.occupancy_regions.every((p) =>
          p.length === 4 ? geometryValid(p) : p.length >= 3,
        )
      )
    )
      blocker = "Adjust the people zone to form a valid area.";
    else {
      const earlier = TABLE_STEPS.slice(0, TABLE_STEPS.indexOf(step)).find(
        (s) => !complete[s],
      );
      if (earlier)
        blocker = `Confirm ${STEP_LABELS[earlier].toLowerCase()} first.`;
    }
    if (!blocker && step === "objects" && !table?.object_baseline)
      blocker =
        "Generate an object proposal, then inspect the reference and quantities.";
  } else if (!allComplete)
    blocker =
      requirements[0]?.message ?? "Enable at least one table before finishing.";

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    heading.current?.focus();
  }, [section, step, selected]);
  useEffect(() => {
    if (error) errorBox.current?.focus();
  }, [error]);
  useEffect(() => {
    if (!leave) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    leaveDialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [leave]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  useEffect(() => {
    if (!cacheResolved && cache) return;
    try {
      if (dirty)
        localStorage.setItem(
          `tablewatch-edit-${source.id}`,
          JSON.stringify({
            revision: revision.current,
            tables,
            reference,
            floorMode,
            drawings,
          }),
        );
      else localStorage.removeItem(`tablewatch-edit-${source.id}`);
    } catch {
      /* The unsaved-work warning remains available if storage is full. */
    }
  }, [fingerprint, drawings, dirty, cacheResolved, cache, source.id]);
  useEffect(() => {
    if (source.kind !== "video" || !(initialReference(source).reference_t! > 0))
      return;
    let alive = true;
    void api<{ url: string }>(`/sources/${source.id}/frame`, {
      method: "POST",
      body: jsonBody({ t: initialReference(source).reference_t }),
    })
      .then((r) => {
        if (alive) setFrame(r.url);
      })
      .catch((e) => {
        if (alive) setError(`Could not load the saved frame. ${e.message}`);
      });
    return () => {
      alive = false;
    };
  }, [source.id]);
  useEffect(
    () => () => {
      serial.current++;
    },
    [],
  );
  function markDirty() {
    retry.current = null;
    setStatus("Unsaved changes");
    setDoneTable(null);
  }
  function changeTable(id: string, patch: Partial<CalibrationTable>) {
    if (lock.current) return;
    markDirty();
    const geometryChanged =
      "tabletop_polygon" in patch || "occupancy_regions" in patch;
    if (geometryChanged) {
      serial.current++;
      setEvidence((old) => {
        const n = { ...old };
        delete n[id];
        return n;
      });
      setNotice(
        "Camera geometry changed. Review its geometry step and expected objects again.",
      );
    }
    setTables((old) =>
      old.map((t) =>
        t.id === id
          ? {
              ...t,
              ...(geometryChanged
                ? {
                    object_baseline: undefined,
                    expected_objects_draft: undefined,
                    reference_approved: false,
                    reference: null,
                  }
                : {}),
              ...patch,
            }
          : t,
      ),
    );
  }
  function goTable(id: string, target?: TableStep) {
    setNumericCorners(false);
    setSelected(id);
    setStep(
      target ?? nextTableStep(tables.find((t) => t.id === id)!) ?? "objects",
    );
    setSection("tables");
    setRegion(0);
    setDoneTable(null);
    setError("");
  }
  function changeReference(next: Reference) {
    markDirty();
    serial.current++;
    setReference(next);
    setEvidence({});
    setNotice(
      "Reference changed. Review the clean reference and expected objects for each table again.",
    );
    setTables((old) =>
      old.map((t) => ({
        ...t,
        ...next,
        reference: null,
        reference_approved: false,
        object_baseline: undefined,
        expected_objects_draft: undefined,
      })),
    );
  }
  async function persist(
    snapshot: CalibrationTable[] = tablesRef.current,
    after?: () => void,
    finish = false,
  ) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setStatus("Saving");
    retry.current = () => persist(snapshot, after, finish);
    try {
      const normalized = snapshot.map((t) => ({
        ...t,
        label: validLabel(
          t.label,
          snapshot.filter((o) => o.id !== t.id).map((o) => o.label),
        ),
      }));
      const result = await api<SourceInfo>(
        `/sources/${source.id}/calibration`,
        {
          method: "PUT",
          body: jsonBody({
            revision: revision.current,
            tables: normalized,
            confirmed: finish,
            setup_mode: "guided_v1",
            setup_reference: reference,
            floor_plan_mode: floorMode,
          }),
        },
      );
      revision.current = result.revision;
      setWorking(result);
      result.tables.forEach((t) => persistedIds.current.add(t.id));
      // Draft storage deliberately drops unapproved proposals; keep valid evidence in this mounted session.
      const merged = normalize(result).map((t) => {
        const prior = normalized.find((p) => p.id === t.id);
        return prior?.object_baseline &&
          !prior.object_baseline.approved &&
          evidence[t.id]
          ? {
              ...t,
              object_baseline: prior.object_baseline,
              expected_objects_draft: prior.object_baseline.expected,
            }
          : t;
      });
      setTables(merged);
      tablesRef.current = merged;
      saved.current = JSON.stringify({ tables: merged, reference, floorMode });
      setStatus(
        Object.keys(drawings).length
          ? "Saved shapes; unfinished corners remain unsaved"
          : "Saved",
      );
      retry.current = null;
      if (finish) {
        try {
          localStorage.removeItem(`tablewatch-edit-${source.id}`);
        } catch {}
        onSaved(result);
      } else after?.();
    } catch (e) {
      setStatus("Couldn’t save");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function confirmStep() {
    if (blocker || !table) return;
    const id = table.id,
      currentStep = step;
    const snapshot = tables.map((t) =>
      t.id !== id
        ? t
        : currentStep === "objects"
          ? {
              ...t,
              object_baseline: { ...t.object_baseline!, approved: true },
              reference_approved: true,
              expected_objects_draft: undefined,
            }
          : {
              ...t,
              setup_review: {
                ...(t.setup_review ?? unreviewed),
                [currentStep]: true,
              },
            },
    );
    await persist(snapshot, () => {
      if (currentStep === "objects") setDoneTable(id);
      else setStep(TABLE_STEPS[TABLE_STEPS.indexOf(currentStep) + 1]);
    });
  }
  function addTable() {
    let n = 1;
    while (
      tables.some(
        (t) => t.id === `T${n}` || t.label.toLowerCase() === `table ${n}`,
      )
    )
      n++;
    const id = `T${n}`,
      polygon: Point[] = [
        [0.35, 0.35],
        [0.65, 0.35],
        [0.65, 0.65],
        [0.35, 0.65],
      ];
    const added: CalibrationTable = {
      id,
      label: `Table ${n}`,
      monitoring_enabled: true,
      video_region: [0.25, 0.2, 0.75, 0.8],
      crop: bounds(polygon),
      tabletop_polygon: polygon,
      occupancy_regions: [
        [
          [0.25, 0.2],
          [0.75, 0.2],
          [0.75, 0.8],
          [0.25, 0.8],
        ],
      ],
      map: { x: 0.5, y: 0.5, w: 0.16, h: 0.19, shape: "rect" },
      setup_review: { ...unreviewed },
      reference: null,
      ...reference,
      reference_approved: false,
    };
    setTables((old) => [...old, added]);
    setDrawings((old) => ({ ...old, [id]: [] }));
    setSelected(id);
    setStep("tabletop");
    setSection("tables");
    markDirty();
  }
  async function uploadAsset(
    kind: "clean_reference" | "floor_plan",
    file?: File,
  ) {
    if (!file) return;
    if (
      file.size > 12 * 1024 * 1024 ||
      !["image/png", "image/jpeg"].includes(file.type)
    ) {
      setError("Choose a JPG or PNG up to 12 MB.");
      return;
    }
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    serial.current++;
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("revision", String(revision.current));
      const result = await api<SourceInfo>(
        `/sources/${source.id}/setup-assets/${kind}`,
        { method: "PUT", body },
      );
      revision.current = result.revision;
      setWorking(result);
      if (kind === "clean_reference")
        changeReference({
          reference_source: "uploaded_image",
          reference_t: null,
          reference_image_sha256: result.setup_assets?.clean_reference?.sha256,
          alignment_confirmed: false,
        });
      else {
        setFloorMode("uploaded");
        setTables((old) =>
          old.map((t) => ({
            ...t,
            setup_review: { ...(t.setup_review ?? unreviewed), map: false },
          })),
        );
        markDirty();
        setNotice("Floor plan changed. Place and review each table again.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function useFrame() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const result =
        source.kind === "video"
          ? await api<{ url: string; t: number }>(
              `/sources/${source.id}/frame`,
              { method: "POST", body: jsonBody({ t: Number(frameTime) }) },
            )
          : { url: frame, t: 0 };
      setFrame(result.url);
      changeReference({
        reference_source: "video_frame",
        reference_t: result.t,
        alignment_confirmed: false,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function propose() {
    if (!table || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const id = table.id,
      request = ++serial.current,
      rev = revision.current;
    const geometry = JSON.stringify([
      table.tabletop_polygon,
      table.occupancy_regions,
    ]);
    try {
      const result = await api<{
        baseline: ObjectBaseline;
        detections: Detection[];
        frame_base64: string;
        revision: number;
        reference_t: number;
      }>(`/sources/${source.id}/baseline-proposal`, {
        method: "POST",
        body: jsonBody({
          revision: rev,
          table_id: id,
          tabletop_polygon: table.tabletop_polygon,
          occupancy_regions: table.occupancy_regions,
          ...reference,
        }),
      });
      const current = tablesRef.current.find((t) => t.id === id);
      if (
        request !== serial.current ||
        rev !== result.revision ||
        !current ||
        JSON.stringify([
          current.tabletop_polygon,
          current.occupancy_regions,
        ]) !== geometry
      )
        throw new Error("Table changed. Generate a fresh proposal.");
      setTables((old) =>
        old.map((t) =>
          t.id === id
            ? {
                ...t,
                ...reference,
                surface_method: "objects_reference_v1",
                object_baseline: {
                  ...result.baseline,
                  expected:
                    t.expected_objects_draft ?? result.baseline.expected,
                  approved: false,
                },
                reference_approved: false,
                reference: null,
              }
            : t,
        ),
      );
      setEvidence((old) => ({
        ...old,
        [id]: {
          image: imageSource(result.frame_base64),
          detections: result.detections,
        },
      }));
      markDirty();
    } catch (e) {
      setError(
        `Could not propose expected objects. ${e instanceof Error ? e.message : String(e)} Your drawing is still here; you can retry.`,
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function pointAt(e: React.PointerEvent<SVGSVGElement>): Point | null {
    const m = e.currentTarget.getScreenCTM();
    if (!m) return null;
    const p = e.currentTarget.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    const c = p.matrixTransform(m.inverse());
    return [clamp(c.x / width), clamp(c.y / height)];
  }
  function setCorner(
    id: string,
    kind: "tabletop" | "occupancy",
    r: number,
    i: number,
    p: Point,
  ) {
    const t = tablesRef.current.find((t) => t.id === id);
    if (!t) return;
    if (kind === "tabletop") {
      const polygon = t.tabletop_polygon!.map((v, n) => (n === i ? p : v));
      changeTable(id, {
        tabletop_polygon: polygon,
        crop: bounds(polygon),
        setup_review: { ...(t.setup_review ?? unreviewed), tabletop: false },
      });
    } else {
      const zones = t.occupancy_regions!.map((poly, n) =>
        n === r ? poly.map((v, j) => (j === i ? p : v)) : poly,
      );
      changeTable(id, {
        occupancy_regions: zones,
        setup_review: { ...(t.setup_review ?? unreviewed), occupancy: false },
      });
    }
  }
  const currentPolygon =
    step === "tabletop"
      ? table?.tabletop_polygon
      : table?.occupancy_regions?.[region];
  function restoreEdits() {
    if (!cache || cache.revision !== revision.current) return;
    const restored = cache.tables.map((t) => ({
      ...t,
      ...(t.object_baseline && !t.object_baseline.approved
        ? {
            expected_objects_draft: t.object_baseline.expected,
            object_baseline: undefined,
          }
        : {}),
      ...(cache.drawings[t.id] !== undefined
        ? {
            setup_review: {
              ...(t.setup_review ?? unreviewed),
              tabletop: false,
            },
          }
        : {}),
    }));
    const next = resumeSetup({
      ...working,
      tables: restored,
      setup_reference: cache.reference,
      floor_plan_mode: cache.floorMode,
    });
    setTables(restored);
    setReference(cache.reference);
    setFloorMode(cache.floorMode);
    setDrawings(cache.drawings);
    setCacheResolved(true);
    setStatus("Unsaved changes");
    setSelected(next.tableId);
    setStep(next.step);
    setSection(next.section);
  }
  function startNumericCorners() {
    if (!table || busy) return;
    const polygon: Point[] = [
      [0.35, 0.35],
      [0.65, 0.35],
      [0.65, 0.65],
      [0.35, 0.65],
    ];
    setDrawings((old) => {
      const next = { ...old };
      delete next[selected];
      return next;
    });
    changeTable(selected, {
      tabletop_polygon: polygon,
      crop: bounds(polygon),
      setup_review: { ...(table.setup_review ?? unreviewed), tabletop: false },
    });
    setNumericCorners(true);
    setNotice(
      "A starter rectangle is ready. Enter each corner’s X and Y coordinates, then review the outline before confirming.",
    );
  }
  function editInventory(baseline: ObjectBaseline) {
    if (!table) return;
    // Keep the reviewed crop visible while quantity changes clear approval.
    if (!evidence[selected] && table.reference)
      setEvidence((old) => ({
        ...old,
        [selected]: {
          image: assetPath(source.id, table.reference!.file),
          detections: [],
        },
      }));
    changeTable(selected, {
      object_baseline: baseline,
      expected_objects_draft: baseline.expected,
      reference_approved: false,
      reference: null,
    });
  }
  function downloadEdits() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              source_id: source.id,
              revision: revision.current,
              tables,
              reference,
              floorMode,
              drawings,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    a.download = "turntable-draft.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }
  return (
    <section
      className="setup-panel guided-editor"
      data-testid="calibration-editor"
      aria-busy={busy}
    >
      <div inert={leave || undefined}>
        <header className="guided-heading">
          <div>
            <div className="eyebrow">
              RESTAURANT SETUP · ONE TABLE AT A TIME
            </div>
            <h2 ref={heading} tabIndex={-1}>
              {section === "references"
                ? "Choose your reference and floor plan."
                : section === "review"
                  ? "Review your restaurant setup."
                  : table
                    ? `Set up ${table.label}.`
                    : "Let’s mark your first table."}
            </h2>
            <p>
              {section === "tables"
                ? "Four clear steps connect each camera table to its position on your plan."
                : "Your selections stay editable. Analysis starts only when you choose it."}
            </p>
          </div>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => (dirty ? setLeave(true) : onCancel())}
          >
            Back to sources
          </button>
        </header>
        <nav className="guided-global-nav" aria-label="Restaurant setup">
          <button
            className={section === "references" ? "active" : ""}
            disabled={busy}
            onClick={() => setSection("references")}
          >
            Reference & floor plan
          </button>
          <button
            className={section === "tables" ? "active" : ""}
            disabled={busy}
            onClick={() => setSection("tables")}
          >
            Set up tables{" "}
            <span>
              {enabled.filter((t) => !nextTableStep(t)).length}/{enabled.length}{" "}
              complete
            </span>
          </button>
          <button
            className={section === "review" ? "active" : ""}
            disabled={busy}
            onClick={() => setSection("review")}
          >
            Review setup
          </button>
        </nav>
        {cache && !cacheResolved && (
          <div className="setup-recovery" role="status">
            <strong>Unsaved edits were found on this browser.</strong>
            <p>
              {cache.revision === revision.current
                ? "Restore your table edits and unfinished corners, or keep the saved source."
                : "The saved source has a different revision. Download the recovered edits before continuing; they will not overwrite newer work."}
            </p>
            {cache.revision === revision.current && (
              <button className="button secondary" onClick={restoreEdits}>
                Restore my edits
              </button>
            )}
            <button
              className="button secondary"
              onClick={() => {
                const a = document.createElement("a");
                a.href = URL.createObjectURL(
                  new Blob([JSON.stringify(cache, null, 2)], {
                    type: "application/json",
                  }),
                );
                a.download = "turntable-recovered-draft.json";
                a.click();
                URL.revokeObjectURL(a.href);
              }}
            >
              Download recovered edits
            </button>
            <button
              className="text-button"
              onClick={() => {
                setCacheResolved(true);
                setCache(null);
              }}
            >
              Keep saved source
            </button>
          </div>
        )}
        {error && (
          <div
            ref={errorBox}
            tabIndex={-1}
            className="input-error guided-error"
            role="alert"
          >
            <strong>{error}</strong>
            {retry.current && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void retry.current?.()}
              >
                Retry save
              </button>
            )}
            <button className="text-button" onClick={downloadEdits}>
              Download my edits
            </button>
            {/revision|changed|reload/i.test(error) && (
              <p>
                The saved revision may have changed. Your edits are retained
                here; download them before reopening the latest source.
              </p>
            )}
          </div>
        )}
        {notice && (
          <p className="guided-notice" role="status">
            {notice}
            <button
              className="text-button"
              aria-label="Dismiss update notice"
              onClick={() => setNotice("")}
            >
              Dismiss
            </button>
          </p>
        )}
        <fieldset className="guided-work-fields" disabled={busy}>
          {section === "references" && (
            <div className="setup-assets-grid">
              <section className="setup-asset-card">
                <h3>Clean reference</h3>
                <p>
                  Choose a reset-table photo from the same camera position.
                  You’ll review each table’s objects later.
                </p>
                <label className="setup-check">
                  <input
                    type="radio"
                    name="guided-reference-kind"
                    checked={reference.reference_source === "video_frame"}
                    onChange={() =>
                      changeReference({
                        reference_source: "video_frame",
                        reference_t: null,
                        alignment_confirmed: false,
                      })
                    }
                  />
                  {source.kind === "video"
                    ? "Select a recording frame"
                    : "Use the captured camera frame"}
                </label>
                <label className="setup-check">
                  <input
                    type="radio"
                    name="guided-reference-kind"
                    checked={reference.reference_source === "uploaded_image"}
                    onChange={() =>
                      changeReference({
                        reference_source: "uploaded_image",
                        reference_t: null,
                        reference_image_sha256: clean?.sha256,
                        alignment_confirmed: false,
                      })
                    }
                  />
                  Upload a clean photo
                </label>
                {reference.reference_source === "video_frame" ? (
                  <>
                    <div className="frame-picker">
                      {source.kind === "video" && (
                        <label>
                          Reference time (seconds)
                          <input
                            data-testid="calibration-frame-time"
                            type="number"
                            min="0"
                            max={source.duration_s}
                            step="0.1"
                            value={frameTime}
                            onChange={(e) => setFrameTime(e.target.value)}
                          />
                        </label>
                      )}
                      <button
                        className="button secondary"
                        data-testid="reference-use-frame"
                        onClick={() => void useFrame()}
                      >
                        {source.kind === "video"
                          ? "Use frame"
                          : "Use captured frame"}
                      </button>
                    </div>
                    {frame && (
                      <img
                        src={frame}
                        alt="Camera frame for clean-reference selection"
                      />
                    )}
                    <p>
                      {reference.reference_t !== null
                        ? `Frame selected at ${reference.reference_t.toFixed(2)} seconds.`
                        : "Select a clean frame to continue."}
                    </p>
                  </>
                ) : (
                  <>
                    <label className="button secondary upload-label">
                      Choose clean photo
                      <input
                        data-testid="clean-reference-upload"
                        type="file"
                        accept="image/png,image/jpeg"
                        onChange={(e) => {
                          void uploadAsset(
                            "clean_reference",
                            e.target.files?.[0],
                          );
                          e.target.value = "";
                        }}
                      />
                    </label>
                    {clean && (
                      <>
                        <img
                          src={assetPath(source.id, clean.file)}
                          alt="Uploaded clean reference"
                        />
                        {frame && (
                          <details>
                            <summary>Compare with the camera frame</summary>
                            <img
                              src={frame}
                              alt="Camera frame for checking alignment"
                            />
                          </details>
                        )}
                        <label className="setup-check">
                          <input
                            data-testid="reference-alignment-confirmed"
                            type="checkbox"
                            checked={reference.alignment_confirmed}
                            onChange={(e) =>
                              changeReference({
                                ...reference,
                                alignment_confirmed: e.target.checked,
                              })
                            }
                          />
                          This photo uses the same camera position and framing
                          as the recording or live camera.
                        </label>
                      </>
                    )}
                  </>
                )}
              </section>
              <section className="setup-asset-card">
                <h3>Floor plan</h3>
                <p>
                  Each camera table will be placed manually on this image.
                  Printed table numbers are not matched automatically.
                </p>
                <label className="button secondary upload-label">
                  Choose floor plan
                  <input
                    data-testid="floor-plan-upload"
                    type="file"
                    accept="image/png,image/jpeg"
                    onChange={(e) => {
                      void uploadAsset("floor_plan", e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
                {plan && (
                  <img
                    src={assetPath(source.id, plan.file)}
                    alt="Uploaded floor plan"
                  />
                )}
                <label className="setup-check">
                  <input
                    data-testid="schematic-floor-plan"
                    type="checkbox"
                    checked={floorMode === "schematic"}
                    onChange={(e) => {
                      setFloorMode(
                        e.target.checked
                          ? "schematic"
                          : working.setup_assets?.floor_plan
                            ? "uploaded"
                            : undefined,
                      );
                      setTables((old) =>
                        old.map((t) => ({
                          ...t,
                          setup_review: {
                            ...(t.setup_review ?? unreviewed),
                            map: false,
                          },
                        })),
                      );
                      markDirty();
                    }}
                  />
                  I do not have a plan. Arrange the tables on a schematic
                  layout.
                </label>
              </section>
            </div>
          )}
          <div hidden={section !== "tables"} className="guided-table-workspace">
            <details className="guided-table-list" open>
              <summary>
                Tables · {enabled.filter((t) => !nextTableStep(t)).length} of{" "}
                {enabled.length} complete
              </summary>
              <nav aria-label="Tables to set up">
                {tables.map((t) => {
                  const c = tableCompletion(t),
                    next = nextTableStep(t);
                  return (
                    <button
                      key={t.id}
                      data-testid={`setup-table-${t.id}`}
                      className={selected === t.id ? "active" : ""}
                      aria-current={selected === t.id ? "true" : undefined}
                      onClick={() => goTable(t.id)}
                    >
                      <strong>{t.label}</strong>
                      <span>
                        {t.monitoring_enabled === false
                          ? "Monitoring off"
                          : `${TABLE_STEPS.filter((s) => c[s]).length}/4 complete`}
                      </span>
                      <small>
                        {t.monitoring_enabled === false
                          ? "Enable to continue"
                          : next
                            ? `Next: ${STEP_LABELS[next]}`
                            : "Ready for final review"}
                      </small>
                    </button>
                  );
                })}
              </nav>
              <button
                className="button secondary"
                data-testid="calibration-add-table"
                onClick={addTable}
              >
                + Add table
              </button>
            </details>
            <div className="guided-table-main">
              <nav
                className="guided-table-steps"
                aria-label="Table setup steps"
              >
                {TABLE_STEPS.map((s, i) => (
                  <button
                    key={s}
                    data-testid={`table-step-${s}`}
                    className={step === s ? "active" : ""}
                    aria-current={step === s ? "step" : undefined}
                    onClick={() => {
                      setStep(s);
                      setError("");
                      setDoneTable(null);
                    }}
                  >
                    <span className="step-number">{i + 1}</span>
                    <span>
                      <strong>{STEP_LABELS[s]}</strong>
                      <small>
                        {step === s
                          ? "Current"
                          : complete[s]
                            ? "Complete"
                            : "Needs review"}
                        {step === s && complete[s] ? " · Complete" : ""}
                      </small>
                    </span>
                  </button>
                ))}
              </nav>
              {doneTable && (
                <div className="guided-table-done" role="status">
                  <strong>
                    {tables.find((t) => t.id === doneTable)?.label} is complete.
                  </strong>
                  <p>Your reviewed table has been saved.</p>
                  <button className="button dark" onClick={addTable}>
                    Add another table
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => setSection("review")}
                  >
                    Review setup
                  </button>
                </div>
              )}
              {!table && (
                <div className="setup-empty" data-testid="setup-no-tables">
                  <h3>No tables marked yet.</h3>
                  <p>
                    Add a table, name it, then follow the four visible steps.
                  </p>
                  <button className="button dark" onClick={addTable}>
                    Add your first table
                  </button>
                </div>
              )}
              {table && (
                <>
                  <div className="guided-table-identity">
                    <label>
                      Table name
                      <input
                        data-testid="calibration-label"
                        maxLength={40}
                        value={table.label}
                        onChange={(e) =>
                          changeTable(table.id, { label: e.target.value })
                        }
                      />
                    </label>
                    <small>
                      Stable ID: {table.id} · Use a name that identifies this
                      table on your plan.
                    </small>
                    <label className="setup-check">
                      <input
                        type="checkbox"
                        checked={table.monitoring_enabled !== false}
                        onChange={(e) =>
                          changeTable(table.id, {
                            monitoring_enabled: e.target.checked,
                          })
                        }
                      />
                      Monitor this table
                    </label>
                  </div>
                  <div hidden={step !== "map"}>
                    <FloorPlanEditor
                      tables={tables}
                      selected={selected}
                      onSelect={(id) => {
                        setSelected(id);
                        setRegion(0);
                        setDoneTable(null);
                      }}
                      onChange={(id, map) => {
                        const t = tablesRef.current.find((t) => t.id === id)!;
                        changeTable(id, {
                          map,
                          setup_review: {
                            ...(t.setup_review ?? unreviewed),
                            map: false,
                          },
                        });
                      }}
                      floorPlan={
                        plan
                          ? {
                              url: assetPath(source.id, plan.file),
                              width: plan.width,
                              height: plan.height,
                            }
                          : undefined
                      }
                      cameraImage={cameraImage}
                    />
                  </div>
                  {(step === "tabletop" || step === "occupancy") && (
                    <div className="guided-camera-workspace">
                      <div className="guided-camera-canvas">
                        <h3>
                          {step === "tabletop"
                            ? "Mark the tabletop’s four corners"
                            : "Adjust where people belong to this table"}
                        </h3>
                        <p>
                          {step === "tabletop"
                            ? "Click around one tabletop in order. Avoid crossing the outline."
                            : "Include the seating or standing area for this table. Exclude walkways and neighbouring tables where possible."}
                        </p>
                        <p className="setup-image-label">
                          {step === "tabletop" &&
                          reference.reference_source === "uploaded_image"
                            ? "Uploaded clean reference"
                            : "Camera frame"}{" "}
                          · {table.label}
                        </p>
                        <svg
                          ref={svg}
                          data-testid="calibration-canvas"
                          className="calibration-canvas"
                          viewBox={`0 0 ${width} ${height}`}
                          aria-label="Editable camera calibration polygons"
                          onPointerDown={(e) => {
                            if (
                              busy ||
                              step !== "tabletop" ||
                              drawing === undefined
                            )
                              return;
                            const p = pointAt(e);
                            if (!p) return;
                            const next = [...drawing, p];
                            markDirty();
                            if (next.length === 4) {
                              changeTable(table.id, {
                                tabletop_polygon: next,
                                crop: bounds(next),
                                setup_review: {
                                  ...(table.setup_review ?? unreviewed),
                                  tabletop: false,
                                },
                              });
                              setDrawings((old) => {
                                const n = { ...old };
                                delete n[table.id];
                                return n;
                              });
                            } else
                              setDrawings((old) => ({
                                ...old,
                                [table.id]: next,
                              }));
                          }}
                          onPointerMove={(e) => {
                            if (!drag.current || busy) return;
                            const p = pointAt(e);
                            if (p)
                              setCorner(
                                drag.current.tableId,
                                drag.current.step,
                                drag.current.region,
                                drag.current.index,
                                p,
                              );
                          }}
                          onPointerUp={(e) => {
                            if (e.currentTarget.hasPointerCapture(e.pointerId))
                              e.currentTarget.releasePointerCapture(
                                e.pointerId,
                              );
                            drag.current = null;
                          }}
                          onPointerCancel={() => {
                            drag.current = null;
                          }}
                        >
                          <rect width={width} height={height} fill="var(--canvas)" />
                          <image
                            data-testid="calibration-source-image"
                            href={
                              step === "tabletop"
                                ? cameraImage
                                : frame || cameraImage
                            }
                            width={width}
                            height={height}
                          />
                          {tables.map((t) => {
                            if (
                              t.id === selected &&
                              drawing !== undefined &&
                              step === "tabletop"
                            )
                              return null;
                            const polygons =
                              step === "tabletop"
                                ? [t.tabletop_polygon ?? []]
                                : (t.occupancy_regions ?? []);
                            return (
                              <g key={t.id}>
                                {polygons.map((poly, r) => (
                                  <g key={r}>
                                    <polygon
                                      points={poly
                                        .map(
                                          (p) =>
                                            `${p[0] * width},${p[1] * height}`,
                                        )
                                        .join(" ")}
                                      fill={
                                        t.id === selected
                                          ? "var(--selection-fill)"
                                          : "#ffffff12"
                                      }
                                      stroke={
                                        t.id === selected
                                          ? "var(--action)"
                                          : "var(--border)"
                                      }
                                      strokeWidth="3"
                                      strokeDasharray={
                                        step === "occupancy"
                                          ? "10 5"
                                          : undefined
                                      }
                                    />
                                    {t.id === selected &&
                                      (step !== "occupancy" || region === r) &&
                                      poly.map((p, i) => (
                                        <circle
                                          key={i}
                                          data-testid={`calibration-handle-${i}`}
                                          cx={p[0] * width}
                                          cy={p[1] * height}
                                          r="10"
                                          fill="white"
                                          stroke="var(--action)"
                                          strokeWidth="3"
                                          role="button"
                                          tabIndex={0}
                                          aria-label={`${step === "tabletop" ? "Table corner" : "People-zone point"} ${i + 1}. Use arrow keys to adjust.`}
                                          onKeyDown={(e) => {
                                            const d = e.shiftKey ? 0.01 : 0.001;
                                            if (!e.key.startsWith("Arrow"))
                                              return;
                                            e.preventDefault();
                                            setCorner(t.id, step, r, i, [
                                              clamp(
                                                p[0] +
                                                  (e.key === "ArrowRight"
                                                    ? d
                                                    : e.key === "ArrowLeft"
                                                      ? -d
                                                      : 0),
                                              ),
                                              clamp(
                                                p[1] +
                                                  (e.key === "ArrowDown"
                                                    ? d
                                                    : e.key === "ArrowUp"
                                                      ? -d
                                                      : 0),
                                              ),
                                            ]);
                                          }}
                                          onPointerDown={(e) => {
                                            if (busy) return;
                                            e.stopPropagation();
                                            drag.current = {
                                              tableId: t.id,
                                              step,
                                              region: r,
                                              index: i,
                                            };
                                            svg.current?.setPointerCapture(
                                              e.pointerId,
                                            );
                                          }}
                                        />
                                      ))}
                                  </g>
                                ))}
                              </g>
                            );
                          })}
                          {step === "tabletop" && drawing !== undefined && (
                            <g>
                              <polyline
                                points={drawing
                                  .map(
                                    (p) => `${p[0] * width},${p[1] * height}`,
                                  )
                                  .join(" ")}
                                fill="none"
                                stroke="var(--action)"
                                strokeWidth="4"
                              />
                              {drawing.map((p, i) => (
                                <g key={i}>
                                  <circle
                                    cx={p[0] * width}
                                    cy={p[1] * height}
                                    r="10"
                                    fill="white"
                                    stroke="var(--action)"
                                    strokeWidth="3"
                                  />
                                  <text
                                    x={p[0] * width + 14}
                                    y={p[1] * height - 12}
                                    fontSize="22"
                                    fill="white"
                                    stroke="var(--brand-navy)"
                                    strokeWidth=".5"
                                  >
                                    {i + 1}
                                  </text>
                                </g>
                              ))}
                            </g>
                          )}
                        </svg>
                      </div>
                      <aside className="guided-camera-tools">
                        <h3>
                          {step === "tabletop"
                            ? "Table corners"
                            : "People zone"}
                        </h3>
                        {step === "tabletop" ? (
                          <>
                            <p className="drawing-progress" role="status">
                              {drawing !== undefined
                                ? `${drawing.length} of 4 corners marked`
                                : "4 corners marked · review the outline"}
                            </p>
                            <button
                              data-testid="draw-tabletop"
                              className="button secondary"
                              onClick={() => {
                                setDrawings((old) => ({
                                  ...old,
                                  [selected]: [],
                                }));
                                changeTable(selected, {
                                  setup_review: {
                                    ...(table.setup_review ?? unreviewed),
                                    tabletop: false,
                                  },
                                });
                              }}
                            >
                              Mark four corners
                            </button>
                            <button
                              className="button secondary"
                              data-testid="numeric-tabletop"
                              onClick={startNumericCorners}
                            >
                              Start rectangle & enter coordinates
                            </button>
                            {drawing !== undefined && (
                              <>
                                <button
                                  className="button secondary"
                                  disabled={!drawing.length}
                                  onClick={() => {
                                    setDrawings((old) => ({
                                      ...old,
                                      [selected]: drawing.slice(0, -1),
                                    }));
                                    markDirty();
                                  }}
                                >
                                  Undo last corner
                                </button>
                                <button
                                  className="text-button"
                                  onClick={() =>
                                    setDrawings((old) => {
                                      const n = { ...old };
                                      delete n[selected];
                                      return n;
                                    })
                                  }
                                >
                                  Cancel drawing
                                </button>
                              </>
                            )}
                          </>
                        ) : (
                          <>
                            <label>
                              Zone
                              <select
                                value={region}
                                onChange={(e) =>
                                  setRegion(Number(e.target.value))
                                }
                              >
                                {table.occupancy_regions?.map((_, i) => (
                                  <option key={i} value={i}>
                                    Zone {i + 1}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <button
                              className="button secondary"
                              onClick={() => {
                                const zones = [
                                  ...(table.occupancy_regions ?? []),
                                  [
                                    [0.2, 0.2],
                                    [0.8, 0.2],
                                    [0.8, 0.8],
                                    [0.2, 0.8],
                                  ] as Point[],
                                ];
                                changeTable(selected, {
                                  occupancy_regions: zones,
                                  setup_review: {
                                    ...(table.setup_review ?? unreviewed),
                                    occupancy: false,
                                  },
                                });
                                setRegion(zones.length - 1);
                              }}
                            >
                              Add people zone
                            </button>
                            {(table.occupancy_regions?.length ?? 0) > 1 && (
                              <button
                                className="text-button"
                                onClick={() => {
                                  changeTable(selected, {
                                    occupancy_regions:
                                      table.occupancy_regions?.filter(
                                        (_, i) => i !== region,
                                      ),
                                    setup_review: {
                                      ...(table.setup_review ?? unreviewed),
                                      occupancy: false,
                                    },
                                  });
                                  setRegion(0);
                                }}
                              >
                                Remove this zone
                              </button>
                            )}
                          </>
                        )}
                        {(drawing === undefined || step === "occupancy") && (
                          <details
                            className="corner-numbers"
                            open={numericCorners || undefined}
                          >
                            <summary>Adjust points with numbers</summary>
                            <p>Percent of camera width and height.</p>
                            {currentPolygon?.map((p, i) => (
                              <div key={i}>
                                <span>Point {i + 1}</span>
                                {(["X", "Y"] as const).map((axis, a) => (
                                  <label key={axis}>
                                    {axis}
                                    <input
                                      type="number"
                                      min="0"
                                      max="100"
                                      step="0.1"
                                      aria-label={`Point ${i + 1} ${axis} percent`}
                                      value={Number((p[a] * 100).toFixed(2))}
                                      onChange={(e) => {
                                        if (
                                          e.target.value === "" ||
                                          !Number.isFinite(
                                            Number(e.target.value),
                                          ) ||
                                          Number(e.target.value) < 0 ||
                                          Number(e.target.value) > 100
                                        )
                                          return;
                                        const next: Point = [...p];
                                        next[a] = Number(e.target.value) / 100;
                                        setCorner(
                                          selected,
                                          step as "tabletop" | "occupancy",
                                          region,
                                          i,
                                          next,
                                        );
                                      }}
                                    />
                                  </label>
                                ))}
                              </div>
                            ))}
                          </details>
                        )}
                      </aside>
                    </div>
                  )}
                  {step === "objects" && (
                    <div className="guided-objects">
                      <div className="guided-object-photo">
                        <h3>Check the reset-table photo</h3>
                        {evidence[selected] ? (
                          <ObjectPhoto
                            image={evidence[selected].image}
                            detections={evidence[selected].detections}
                            label={`${table.label} proposed reset reference`}
                          />
                        ) : table.reference ? (
                          <img
                            src={assetPath(source.id, table.reference.file)}
                            alt={`${table.label} approved reset reference`}
                          />
                        ) : (
                          <div className="guided-proposal-placeholder">
                            <p>
                              Generate a proposal to see this tabletop crop and
                              its detected objects.
                            </p>
                            <p>
                              Your corners and floor-plan position are already
                              saved when confirmed.
                            </p>
                          </div>
                        )}
                      </div>
                      <aside>
                        <h3>Expected objects</h3>
                        <p>
                          Review what should remain on this table after it is
                          reset.
                        </p>
                        <button
                          className="button secondary"
                          data-testid="baseline-propose"
                          disabled={
                            referenceMissing.length > 0 ||
                            !complete.tabletop ||
                            !complete.occupancy ||
                            !complete.map
                          }
                          onClick={() => void propose()}
                        >
                          {busy
                            ? "Working…"
                            : table.object_baseline
                              ? "Regenerate proposal"
                              : "Propose expected objects"}
                        </button>
                        {(!complete.tabletop ||
                          !complete.occupancy ||
                          !complete.map) && (
                          <p>
                            Complete the three geometry steps before proposing
                            objects.
                          </p>
                        )}
                        {table.object_baseline ? (
                          <>
                            <ExpectedInventory
                              baseline={table.object_baseline}
                              onChange={editInventory}
                            />
                            <p className="guided-approval-copy">
                              By choosing “Approve objects & complete table”,
                              you confirm this reference is reset and these
                              objects and quantities are correct.
                            </p>
                          </>
                        ) : (
                          <>
                            {table.expected_objects_draft && (
                              <p data-testid="saved-inventory-draft">
                                Saved draft quantities:{" "}
                                {table.expected_objects_draft.length
                                  ? table.expected_objects_draft
                                      .map(
                                        (o) =>
                                          `${objectName(o.class_id)} × ${o.count}`,
                                      )
                                      .join(", ")
                                  : "no objects"}
                                . Generate a fresh proposal to review and
                                approve them.
                              </p>
                            )}
                          </>
                        )}
                      </aside>
                    </div>
                  )}
                  <div className="guided-table-maintenance">
                    <button
                      className="text-button"
                      data-testid="calibration-delete-table"
                      disabled={persistedIds.current.has(selected)}
                      onClick={() => {
                        if (persistedIds.current.has(selected)) return;
                        const next = tables.filter((t) => t.id !== selected);
                        setTables(next);
                        setDrawings((old) => {
                          const n = { ...old };
                          delete n[selected];
                          return n;
                        });
                        setSelected(next[0]?.id ?? "");
                        setStep(
                          next[0]
                            ? (nextTableStep(next[0]) ?? "objects")
                            : "tabletop",
                        );
                        markDirty();
                      }}
                    >
                      Remove draft table
                    </button>
                    {persistedIds.current.has(selected) && (
                      <small>
                        Saved table IDs remain stable. Turn off monitoring to
                        exclude this table.
                      </small>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
          {section === "review" && (
            <div className="guided-review">
              <h3>
                {allComplete
                  ? "Your setup is ready to finish."
                  : "Continue the unfinished steps."}
              </h3>
              <p>
                {enabled.filter((t) => !nextTableStep(t)).length} of{" "}
                {enabled.length} monitored tables complete.
              </p>
              {requirements.length ? (
                <ul>
                  {requirements.map((r, i) => (
                    <li key={i}>
                      <button
                        className="text-button"
                        onClick={() => {
                          if (r.step === "references") setSection("references");
                          else if (r.tableId) goTable(r.tableId, r.step);
                          else addTable();
                        }}
                      >
                        {r.message} →
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  Finishing saves your reviewed setup. Choose analysis or live
                  monitoring separately afterward.
                </p>
              )}
              {tables.map((t) => (
                <div className="review-table-row" key={t.id}>
                  <strong>{t.label}</strong>
                  <span>
                    {t.monitoring_enabled === false
                      ? "Monitoring off"
                      : nextTableStep(t)
                        ? `Needs ${STEP_LABELS[nextTableStep(t)!].toLowerCase()}`
                        : "Complete"}
                  </span>
                  <button className="text-button" onClick={() => goTable(t.id)}>
                    Edit table
                  </button>
                </div>
              ))}
              <button className="button secondary" onClick={addTable}>
                Add another table
              </button>
            </div>
          )}
        </fieldset>
        <footer className="guided-footer">
          <div>
            <span
              className="save-state"
              role="status"
              data-testid="draft-save-status"
            >
              {busy
                ? status === "Saving"
                  ? "Saving…"
                  : "Working…"
                : dirty && status === "Saved"
                  ? "Unsaved changes"
                  : status}
            </span>
            <p>
              {Object.keys(drawings).length
                ? "Unfinished corners remain in this browser until all four are marked."
                : "Confirming a step saves your draft. Analysis stays off."}
            </p>
          </div>
          <div className="guided-footer-actions">
            <button
              className="button secondary"
              data-testid="calibration-save-draft"
              disabled={busy}
              onClick={() => void persist()}
            >
              Save draft
            </button>
            <button
              className="button dark"
              data-testid={
                section === "review" ? "calibration-save" : "setup-next"
              }
              disabled={
                busy || !!blocker || (!!doneTable && section === "tables")
              }
              aria-describedby="guided-next-reason"
              onClick={() => {
                if (section === "references")
                  void persist(tables, () => {
                    const next = resumeSetup(viewSource);
                    setSelected(next.tableId);
                    setStep(next.step);
                    setSection("tables");
                  });
                else if (section === "review")
                  void persist(tables, undefined, true);
                else void confirmStep();
              }}
            >
              {busy && status === "Saving"
                ? "Saving…"
                : section === "references"
                  ? "Save & set up tables"
                  : section === "review"
                    ? "Finish reviewed setup"
                    : actionLabels[step]}
            </button>
            <p id="guided-next-reason">
              {busy
                ? "Please wait for the current request."
                : doneTable && section === "tables"
                  ? "Table complete. Add another table or review setup."
                  : blocker}
            </p>
          </div>
        </footer>
      </div>
      {leave && (
        <>
          <div
            aria-hidden="true"
            style={{ position: "fixed", inset: 0, zIndex: 999 }}
          />
          <div
            ref={leaveDialog}
            className="guided-leave"
            role="alertdialog"
            aria-modal="true"
            aria-label="Unsaved setup changes"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setLeave(false);
                return;
              }
              if (event.key !== "Tab") return;
              const controls = Array.from(
                leaveDialog.current?.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ) ?? [],
              );
              const first = controls[0],
                last = controls[controls.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
          >
            <h3>Keep your setup progress?</h3>
            <p>
              Your latest changes have not all been saved to the source.
              Unfinished corners can be recovered in this browser.
            </p>
            <button className="button dark" onClick={() => setLeave(false)}>
              Keep editing
            </button>
            <button
              className="button secondary"
              onClick={() => {
                setLeave(false);
                void persist(tables, () => onCancel());
              }}
            >
              Save draft & leave
            </button>
            <button className="text-button" onClick={onCancel}>
              Leave with browser recovery
            </button>
          </div>
        </>
      )}
    </section>
  );
}
