import { ObjectEvidence } from "./ObjectEvidence";
import { BrandLogo } from "./BrandLogo";
import {
  REFERENCE_CLEANING_THRESHOLD,
  usesObjectSurface,
} from "./object-surface";
import { surfaceStabilityTiming } from "./surface-stability";
import { OriginalScene, uploadedOriginal } from "./OriginalScene";
import { TableOverlayLabel } from "./TableOverlayLabel";
import { tableOverlayGeometry } from "./table-overlay-geometry";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Download,
  Eye,
  Flag,
  FolderOpen,
  ImageIcon,
  LayoutGrid,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  ScanLine,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import type {
  Bundle,
  StaffEvent,
  Status,
  TableState,
} from "../../shared/contracts";
import { createReplaySession } from "./engine";
import { FloorMap } from "./FloorMap";
import { validateBundle, verifyBundleGeometry } from "./validation";
import { sha256Blob, verifyBundleAssets } from "./assets";
import { fetchSourceAsset } from "./source-assets";
import { createCurrentCropRenderer } from "./cropRenderer";
import { monitoringKey, saveMonitoring, withMonitoring } from "./monitoring";
import { COLOURS, ServiceControls } from "./ServiceControls";
import { InputWorkspace } from "./InputWorkspace";
import { StatelessInputWorkspace } from "./StatelessInputWorkspace";
import { isStatelessMode } from "./stateless/config";
import { getStatelessRecording, renameStatelessTable } from "./stateless/recording";
import type { SourceInfo } from "../../shared/live-contracts";
import { api, jsonBody, validLabel } from "./api";
type Loaded = {
  bundle: Bundle;
  asset: (path: string | null | undefined) => string | undefined;
  urls: string[];
  name: string;
  source?: SourceInfo;
};
const PLAYBACK_SPEEDS = ["0.5", "1", "2", "3"] as const;
function speedFromUrl(): string {
  const value = new URLSearchParams(window.location.search).get("speed");
  return value && PLAYBACK_SPEEDS.some((speed) => speed === value)
    ? value
    : "1";
}
function sourceFromUrl(): string | null {
  if (isStatelessMode) return null;
  return new URLSearchParams(window.location.search).get("source") || null;
}
const STATUS: Record<
  Status,
  {
    label: string;
    short: string;
    color: string;
    pale: string;
  }
> = {
  ready: {
    label: "Empty & cleaned",
    short: "Ready to serve",
    color: "#188455",
    pale: "#eaf6ee",
  },
  occupied: {
    label: "Occupied",
    short: "Occupied",
    color: "#bb830c",
    pale: "#fff7dc",
  },
  needs_cleaning: {
    label: "Needs cleaning",
    short: "Needs cleaning",
    color: "#d24a43",
    pale: "#fff0ed",
  },
  unknown: {
    label: "Check table",
    short: "Check table",
    color: "#7b8389",
    pale: "#f3f4f5",
  },
};
const stamp = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
const labelKey = (bundle: Bundle, id: string) =>
  `tablewatch:label:v1:${bundle.video.sha256}:${encodeURIComponent(id)}`;
function restoreLabels(bundle: Bundle): Bundle {
  if (bundle.video.source_kind === "browser_file") return bundle;
  return {
    ...bundle,
    tables: bundle.tables.map((table) => {
      try {
        const label = localStorage.getItem(labelKey(bundle, table.id));
        return label
          ? {
              ...table,
              label: validLabel(
                label,
                bundle.tables
                  .filter((item) => item.id !== table.id)
                  .map((item) => item.label),
              ),
            }
          : table;
      } catch {
        return table;
      }
    }),
  };
}
function StatusPill({ state }: { state: TableState }) {
  const cfg = STATUS[state.status];
  return (
    <span className={`status-pill ${state.status}`}>
      <span className="status-dot" />
      {state.monitoring_enabled === false
        ? "Disabled"
        : state.manual_override && state.status === "unknown"
          ? "Grey · Manual override"
          : state.status === "unknown"
            ? "Verifying"
            : state.status === "ready"
              ? "Ready to serve"
              : cfg.label}
      {state.manual_override && state.status !== "unknown" && " · Manual"}
    </span>
  );
}
export default function App() {
  const [sourceToOpen, setSourceToOpen] = useState(sourceFromUrl);
  const [loaded, setLoaded] = useState<Loaded | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(!!sourceFromUrl());
  const [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(speedFromUrl);
  const [selected, setSelected] = useState("T1"),
    [staffEvents, setStaffEvents] = useState<StaffEvent[]>([]),
    [overlays, setOverlays] = useState(true);
  const [originalOpen, setOriginalOpen] = useState(false),
    [infoOpen, setInfoOpen] = useState(false),
    [videoError, setVideoError] = useState(""),
    [referenceError, setReferenceError] = useState(false);
  const [cropError, setCropError] = useState("");
  const [monitoringChoices, setMonitoringChoices] = useState<
    Record<string, boolean>
  >({});
  const [inputsOpen, setInputsOpen] = useState(() => !sourceFromUrl()),
    [tableName, setTableName] = useState(""),
    [savingName, setSavingName] = useState(false);
  const video = useRef<HTMLVideoElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    upload = useRef<HTMLInputElement>(null),
    initialTime = useRef(0);
  const cropRenderer = useRef<ReturnType<
    typeof createCurrentCropRenderer
  > | null>(null);
  if (!cropRenderer.current) cropRenderer.current = createCurrentCropRenderer();
  const bundle = useMemo(
    () =>
      loaded ? withMonitoring(loaded.bundle, monitoringChoices) : undefined,
    [loaded, monitoringChoices],
  );
  const replaySession = useMemo(
    () => (bundle ? createReplaySession(bundle, staffEvents) : null),
    [bundle, staffEvents],
  );
  const snapshot = useMemo(
    () =>
      bundle && replaySession
        ? replaySession.advanceTo(Math.min(time, bundle.video.duration_s))
        : null,
    [bundle, replaySession, time],
  );
  const table =
    bundle?.tables.find((t) => t.id === selected) ?? bundle?.tables[0];
  const state = table && snapshot?.tables[table.id];
  useEffect(() => {
    setTableName(table?.label ?? "");
  }, [table?.id, table?.label]);
  const currentObservation = useMemo(() => {
    if (!bundle) return undefined;
    let low = 0,
      high = bundle.observations.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (bundle.observations[mid].t <= time) low = mid + 1;
      else high = mid;
    }
    const result = bundle.observations[low - 1];
    return result && time - result.t <= bundle.rules.gap_s ? result : undefined;
  }, [bundle, time]);
  const trackAliases = useMemo(() => {
    const aliases = new Map<string, string>();
    for (const observation of bundle?.observations ?? [])
      for (const track of observation.tracks ?? []) {
        if (!aliases.has(track.track_id))
          aliases.set(track.track_id, `P${aliases.size + 1}`);
      }
    return aliases;
  }, [bundle]);
  useEffect(() => {
    if (!sourceToOpen) return;
    const controller = new AbortController();
    setBusy(true);
    setError("");
    (async () => {
      try {
        const source = isStatelessMode ? getStatelessRecording(sourceToOpen)?.source : await api<SourceInfo>(
          `/sources/${encodeURIComponent(sourceToOpen)}`,
          { signal: controller.signal },
        );
        if (!source) throw new Error("This recording session has ended. Select the video again.");
        await openProcessedSource(source, controller.signal);
      } catch (err) {
        if (!controller.signal.aborted)
          setError(
            err instanceof TypeError &&
              /fetch|network|load failed/i.test(err.message)
              ? "Could not reach the TurnTable service. Check the connection and reload to try again."
              : err instanceof Error
                ? err.message
                : String(err),
          );
      } finally {
        if (!controller.signal.aborted) {
          setBusy(false);
          setSourceToOpen(null);
        }
      }
    })();
    return () => controller.abort();
  }, [sourceToOpen]);
  useEffect(
    () => () => {
      loaded?.urls.forEach((url) => URL.revokeObjectURL(url));
    },
    [loaded?.urls],
  );
  useEffect(() => {
    setReferenceError(false);
  }, [selected, loaded]);
  useEffect(() => {
    if (!originalOpen && !infoOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOriginalOpen(false);
        setInfoOpen(false);
      }
      if (event.key === "Tab") {
        const buttons = [
          ...document.querySelectorAll<HTMLElement>(
            '.modal button, .modal a[href], .modal [tabindex="0"]',
          ),
        ];
        const first = buttons[0],
          last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [originalOpen, infoOpen]);
  const drawCrop = useCallback(
    (frameTime?: number) => {
      const media = video.current,
        target = canvas.current;
      if (!media || !target || !table || media.readyState < 2) return;
      try {
        cropRenderer.current!(
          media,
          target,
          table,
          bundle!.video.fps,
          frameTime,
          bundle!.video.source_kind === "browser_file",
        );
        setCropError("");
      } catch (err) {
        target.getContext("2d")?.clearRect(0, 0, target.width, target.height);
        setCropError(
          err instanceof Error
            ? err.message
            : "Current tabletop picture unavailable.",
        );
      }
    },
    [table, bundle],
  );
  useEffect(() => {
    drawCrop();
  }, [drawCrop]);
  useEffect(() => {
    if (!playing) return;
    const media = video.current;
    if (!media) return;
    let frame = 0;
    const update = (frameTime?: number) => {
      setTime(media.currentTime);
      drawCrop(frameTime);
    };
    if ("requestVideoFrameCallback" in media) {
      const tick = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        update(metadata.mediaTime);
        frame = media.requestVideoFrameCallback(tick);
      };
      frame = media.requestVideoFrameCallback(tick);
      return () => media.cancelVideoFrameCallback(frame);
    }
    const tick = () => {
      update();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, drawCrop]);
  /** Both saved sources and imported folders start a fresh playback session. */
  function displayRecording(next: Loaded, playbackSpeed = "1") {
    video.current?.pause();
    initialTime.current = 0;
    setTime(0);
    setPlaying(false);
    setStaffEvents([]);
    setSelected(next.bundle.tables[0].id);
    setVideoError("");
    setReferenceError(false);
    setOriginalOpen(false);
    setInfoOpen(false);
    setSpeed(playbackSpeed);
    setLoaded(next);
    setError("");
    setBusy(false);
    setInputsOpen(false);
  }

  async function loadFolder(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError("");
    try {
      const list = [...files];
      const manifests = list.filter((file) => file.name === "bundle.json");
      if (manifests.length !== 1)
        throw new Error(
          "Select one bundle folder containing exactly one bundle.json.",
        );
      const manifest = manifests[0];
      const value: unknown = JSON.parse(await manifest.text());
      validateBundle(value);
      await verifyBundleGeometry(value);
      const relative = manifest.webkitRelativePath || manifest.name;
      const prefix = relative.slice(0, -"bundle.json".length);
      const paths = new Map(
        list.map((file) => [
          (file.webkitRelativePath || file.name).slice(prefix.length),
          file,
        ]),
      );
      const source = paths.get(value.video.file);
      if (!source)
        throw new Error(`Source video is missing: ${value.video.file}`);
      if ((await sha256Blob(source)) !== value.video.sha256.toLowerCase())
        throw new Error(
          "Video SHA-256 does not match its analysis bundle. Choose the original analyzed video.",
        );
      await verifyBundleAssets(value, async (path) => paths.get(path) ?? null);
      const urls = new Map<string, string>();
      paths.forEach((file, path) => {
        if (path !== "bundle.json") urls.set(path, URL.createObjectURL(file));
      });
      const url = new URL(window.location.href);
      for (const key of ["source", "setup", "step", "sample"])
        url.searchParams.delete(key);
      window.history.replaceState(null, "", url);
      setSourceToOpen(null);
      displayRecording({
        bundle: restoreLabels(value),
        asset: (path) => (path ? urls.get(path) : undefined),
        urls: [...urls.values()],
        name: source.name,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (upload.current) upload.current.value = "";
    }
  }
  async function togglePlay() {
    if (!video.current) return;
    if (video.current.paused) {
      try {
        await video.current.play();
      } catch {
        setVideoError(
          "This browser could not play the video. Use a browser-compatible MP4.",
        );
      }
    } else video.current.pause();
  }
  function restart() {
    if (video.current) {
      video.current.pause();
      video.current.currentTime = 0;
    }
    setPlaying(false);
    setTime(0);
    setStaffEvents([]);
  }
  function staffAction(action: StaffEvent["action"], status?: Status) {
    if (!table || !bundle) return;
    const sourceTime = Math.min(
      video.current?.currentTime ?? time,
      bundle.video.duration_s,
    );
    setStaffEvents((events) => [
      ...events,
      {
        id: `staff-${crypto.randomUUID()}`,
        t: sourceTime,
        table_id: table.id,
        action,
        ...(status !== undefined ? { status } : {}),
        source: "staff",
        seq:
          Math.max(
            -1,
            ...bundle.staff_events.map((event) => event.seq),
            ...events.map((event) => event.seq),
          ) + 1,
      },
    ]);
  }
  function setMonitoring(enabled: boolean) {
    if (!bundle || !table) return;
    const key = monitoringKey(bundle, table);
    if (bundle.video.source_kind !== "browser_file") saveMonitoring(key, enabled);
    setMonitoringChoices((choices) => ({ ...choices, [key]: enabled }));
    setStaffEvents((events) =>
      events.filter((event) => event.table_id !== table.id),
    );
  }
  function mergeSource(source: SourceInfo) {
    setLoaded((current) => {
      if (current?.source?.id !== source.id) return current;
      // A changed browser setup needs fresh observations and assessments.
      // Keeping the previous bundle would also keep tables removed in setup.
      if (
        current.bundle.video.source_kind === "browser_file" &&
        source.revision !== current.bundle.analysis.setup_revision
      ) {
        return null;
      }
      return {
        ...current,
        source,
        bundle: {
          ...current.bundle,
          floor_plan:
            source.floor_plan_mode === "uploaded"
              ? source.setup_assets?.floor_plan
              : source.floor_plan_mode === "schematic"
                ? undefined
                : current.bundle.floor_plan,
          tables: current.bundle.tables.map((table) => {
            const fresh = source.tables.find(
              (item) => item.id === table.id,
            );
            return fresh
              ? { ...table, label: fresh.label, map: fresh.map }
              : table;
          }),
        },
      };
    });
  }
  async function renameTable() {
    if (!loaded || !bundle || !table || savingName) return;
    setSavingName(true);
    try {
      const label = validLabel(
        tableName,
        bundle.tables
          .filter((item) => item.id !== table.id)
          .map((item) => item.label),
      );
      if (label !== table.label) {
        if (bundle.video.source_kind === "browser_file" && loaded.source) {
          mergeSource(renameStatelessTable(loaded.source.id, table.id, label));
        } else if (loaded.source) {
          const source = loaded.source;
          const result = await api<SourceInfo>(
            `/sources/${source.id}/calibration`,
            {
              method: "PUT",
              body: jsonBody({
                revision: source.revision,
                confirmed: true,
                tables: source.tables.map((item) =>
                  item.id === table.id ? { ...item, label } : item,
                ),
              }),
            },
          );
          mergeSource(result);
        } else {
          try {
            if (bundle.video.source_kind !== "browser_file") localStorage.setItem(labelKey(bundle, table.id), label);
          } catch {
            /* Metadata still updates in this session. */
          }
          setLoaded((current) =>
            current
              ? {
                  ...current,
                  bundle: {
                    ...current.bundle,
                    tables: current.bundle.tables.map((item) =>
                      item.id === table.id ? { ...item, label } : item,
                    ),
                  },
                }
              : current,
          );
        }
      }
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingName(false);
    }
  }
  async function openProcessedSource(source: SourceInfo, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (isStatelessMode) {
      const recording = getStatelessRecording(source.id);
      if (!recording) throw new Error("This recording session has ended. Select the video again.");
      const next = recording.result();
      validateBundle(next.bundle);
      await verifyBundleGeometry(next.bundle);
      displayRecording(next, speedFromUrl());
      return;
    }
    if (source.status !== "completed" || !source.manifest_url)
      throw new Error(
        source.error || "This job has no completed analysis bundle yet.",
      );
    const manifest = new URL(source.manifest_url, location.href),
      manifestBlob = await fetchSourceAsset(manifest, signal);
    if (!manifestBlob)
      throw new Error("The completed bundle could not be loaded.");
    const value: unknown = JSON.parse(await manifestBlob.text());
    validateBundle(value);
    await verifyBundleGeometry(value);
    const blobs = new Map<string, Blob>();
    const read = async (path: string): Promise<Blob | null> => {
      if (blobs.has(path)) return blobs.get(path)!;
      const blob = await fetchSourceAsset(
        new URL(path.split("/").map(encodeURIComponent).join("/"), manifest),
        signal,
      );
      if (blob) blobs.set(path, blob);
      return blob;
    };
    const sourceVideo = await read(value.video.file);
    if (
      !sourceVideo ||
      (await sha256Blob(sourceVideo)) !== value.video.sha256.toLowerCase()
    )
      throw new Error("Completed video SHA-256 does not match its analysis.");
    await verifyBundleAssets(value, read);
    signal?.throwIfAborted();
    const url = new URL(window.location.href);
    url.searchParams.set("source", source.id);
    url.searchParams.delete("setup");
    url.searchParams.delete("step");
    url.searchParams.delete("sample");
    window.history.replaceState(null, "", url);
    const urls = new Map(
      [...blobs].map(([path, blob]) => [path, URL.createObjectURL(blob)]),
    );
    displayRecording(
      {
        source,
        bundle: value,
        asset: (path) =>
          path
            ? (urls.get(path) ??
              new URL(
                path.split("/").map(encodeURIComponent).join("/"),
                manifest,
              ).href)
            : undefined,
        urls: [...urls.values()],
        name: source.label,
      },
      speedFromUrl(),
    );
  }
  function openVideoSelection() {
    video.current?.pause();
    setPlaying(false);
    setSourceToOpen(null);
    setBusy(false);
    setOriginalOpen(false);
    setInfoOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("source");
    url.searchParams.delete("sample");
    url.searchParams.delete("step");
    url.searchParams.set("setup", "new");
    window.history.replaceState(null, "", url);
    setInputsOpen(true);
  }
  function changeReferencePhoto() {
    if (!loaded?.source) return;
    video.current?.pause();
    setSourceToOpen(null);
    setBusy(false);
    setOriginalOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("source");
    url.searchParams.delete("sample");
    url.searchParams.set("setup", loaded.source.id);
    url.searchParams.set("step", "references");
    window.history.replaceState(null, "", url);
    setInputsOpen(true);
  }
  function downloadEvents() {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            video_sha256: bundle?.video.sha256,
            monitoring: bundle?.tables.map((table) => ({
              table_id: table.id,
              geometry_sha256: table.geometry_sha256,
              monitoring_enabled: table.monitoring_enabled ?? true,
            })),
            staff_events: staffEvents,
            events: snapshot?.events,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = "turntable-replay-events.json";
    link.click();
    URL.revokeObjectURL(url);
  }
  const reference = table?.reference
    ? loaded?.asset(table.reference.file)
    : undefined;
  const floorPlanUrl = loaded?.asset(bundle?.floor_plan?.file);
  const floorPlan =
    bundle?.floor_plan && floorPlanUrl
      ? { ...bundle.floor_plan, url: floorPlanUrl }
      : undefined;
  const uploadedPhoto = loaded?.asset(
    uploadedOriginal(bundle, table?.id)?.file,
  );
  const openingFrame = loaded?.asset(bundle?.original_scene);
  const originalSceneSource = bundle?.analysis.original_scene_source_t;
  const originalSceneTime =
    typeof originalSceneSource === "number" &&
    Number.isFinite(originalSceneSource) &&
    originalSceneSource >= 0 &&
    originalSceneSource <= (bundle?.video.duration_s ?? 0)
      ? originalSceneSource
      : null;
  const originalSceneTimeLabel =
    originalSceneTime === null
      ? null
      : `${stamp(originalSceneTime)}.${Math.floor(
          (originalSceneTime % 1) * 1000 + 1e-6,
        )
          .toString()
          .padStart(3, "0")}`;
  const synthetic = bundle?.provenance === "synthetic_fixture";
  const aiGenerated = bundle?.provenance === "ai_generated_video";
  const counts = Object.values(snapshot?.tables ?? {}).reduce(
    (all, item) => {
      if (item.monitoring_enabled !== false) all[item.status] += 1;
      return all;
    },
    { ready: 0, occupied: 0, needs_cleaning: 0, unknown: 0 },
  );
  const disabledCount =
    bundle?.tables.filter((table) => table.monitoring_enabled === false)
      .length ?? 0;
  const manualGrey = Object.values(snapshot?.tables ?? {}).some(
    (item) => item.manual_override?.status === "unknown",
  );
  const objectStability = bundle?.tables.some(usesObjectSurface)
    ? surfaceStabilityTiming(bundle.rules)
    : null;
  const waitLabel = (seconds: number) => Number(seconds.toFixed(2));
  if (inputsOpen && isStatelessMode)
    return <StatelessInputWorkspace
      initialSetup={new URLSearchParams(window.location.search).get("setup") ?? "new"}
      initialSection={new URLSearchParams(window.location.search).get("step") === "references" ? "references" : undefined}
      onClose={() => {
        const url = new URL(window.location.href);
        for (const key of ["source", "setup", "step"]) url.searchParams.delete(key);
        window.history.replaceState(null, "", url);
        setInputsOpen(false);
      }}
      onSourceUpdate={mergeSource}
      onBundle={async (next) => {
        validateBundle(next.bundle);
        await verifyBundleGeometry(next.bundle);
        const url = new URL(window.location.href);
        for (const key of ["source", "setup", "step"]) url.searchParams.delete(key);
        window.history.replaceState(null, "", url);
        displayRecording(next);
      }}
    />;
  if (inputsOpen)
    return (
      <InputWorkspace
        initialSetup={
          new URLSearchParams(window.location.search).get("setup") ?? "new"
        }
        initialSection={
          new URLSearchParams(window.location.search).get("step") ===
          "references"
            ? "references"
            : undefined
        }
        onClose={(source) => {
          const url = new URL(window.location.href);
          url.searchParams.delete("setup");
          url.searchParams.delete("step");
          const returnSource =
            loaded?.source ??
            (source?.status === "completed" ? source : undefined);
          if (returnSource) {
            url.searchParams.set("source", returnSource.id);
            if (!loaded) {
              setSourceToOpen(returnSource.id);
            }
          }
          window.history.replaceState(null, "", url);
          setInputsOpen(false);
        }}
        onBundle={openProcessedSource}
        onSourceUpdate={mergeSource}
      />
    );
  return (
    <div className="app-shell">
      <header className="topbar">
        <a
          href="#"
          className="brand"
          onClick={(event) => event.preventDefault()}
          aria-label="TurnTable home"
        >
          <BrandLogo />
        </a>
        <div className="topbar-right">
          <span className="local-badge">
            <span />
            Workspace
          </span>
          <button
            className="icon-button"
            onClick={() => setInfoOpen(true)}
            aria-label="How TurnTable works"
          >
            <CircleHelp size={19} />
          </button>
        </div>
      </header>
      <main>
        <nav className="dashboard-navigation" aria-label="Recording navigation">
          <button
            data-testid="open-inputs"
            className="button secondary"
            onClick={openVideoSelection}
          >
            <ArrowLeft size={16} />
            Back to video selection
          </button>
        </nav>
        <div className="page-heading">
          <div>
            <div className="eyebrow">RESTAURANT OPERATIONS</div>
            <h1>
              A clear view of every table<span>.</span>
            </h1>
            <p>
              From the camera to the floor. Know what’s ready, occupied, and
              next to clean.
            </p>
          </div>
          <div className="heading-actions">
            <button
              className="button secondary"
              onClick={() => setOriginalOpen(true)}
              disabled={!uploadedPhoto && !openingFrame}
            >
              <ImageIcon size={16} />
              Original scene
            </button>
            <button
              className="button dark"
              onClick={() => upload.current?.click()}
              disabled={busy}
            >
              <FolderOpen size={16} />
              Open bundle
            </button>
          </div>
        </div>
        <input
          ref={upload}
          data-testid="bundle-upload"
          className="visually-hidden"
          type="file"
          multiple
          {...({ webkitdirectory: "" } as Record<string, string>)}
          onChange={(event) => void loadFolder(event.target.files)}
          aria-label="Open analyzed bundle folder"
        />
        {error && (
          <div className="error-banner" data-testid="bundle-error" role="alert">
            <CircleHelp size={18} />
            <span>{error}</span>
            <button onClick={() => setError("")} aria-label="Dismiss error">
              <X size={16} />
            </button>
          </div>
        )}
        {busy && !loaded ? (
          <div className="loading-panel">
            <LoaderCircle className="spin" />
            <h2>Preparing your floor view</h2>
            <p>Checking the video and analysis bundle.</p>
          </div>
        ) : !bundle || !snapshot || !table || !state ? (
          <div className="loading-panel">
            <FolderOpen size={34} />
            <h2>{isStatelessMode ? "Set up your video for analysis" : "Start with an analyzed video"}</h2>
            <p>
              {isStatelessMode
                ? "Choose a video or return to a recording in this tab, review its tables, then analyze it to see results."
                : "Open the folder containing bundle.json, its video, and reference pictures."}
            </p>
            <button
              className="button dark"
              onClick={() => isStatelessMode ? openVideoSelection() : upload.current?.click()}
            >
              {isStatelessMode ? "Set up or analyze a video" : "Open bundle folder"}
            </button>
          </div>
        ) : (
          <>
            <section
              className="summary-row automatic-summary"
              aria-label="Floor summary"
            >
              <div className="summary-intro">
                <span className="live-icon">
                  <LayoutGrid size={20} />
                </span>
                <div>
                  <strong>Floor overview</strong>
                  <span>{`${bundle.tables.length - disabledCount} monitored · ${bundle.tables.length} tables`}</span>
                  {disabledCount > 0 && (
                    <small className="disabled-total">
                      <span data-testid="count-disabled">{disabledCount}</span>{" "}
                      disabled
                    </small>
                  )}
                </div>
              </div>
              <div className="summary-stat ready">
                <span className="stat-icon">
                  <Check size={18} />
                </span>
                <strong data-testid="count-ready">{counts.ready}</strong>
                <span>Ready to serve</span>
              </div>
              <div className="summary-stat occupied">
                <span className="stat-icon">
                  <Users size={18} />
                </span>
                <strong data-testid="count-occupied">{counts.occupied}</strong>
                <span>Occupied</span>
              </div>
              <div className="summary-stat needs_cleaning">
                <span className="stat-icon">
                  <Sparkles size={18} />
                </span>
                <strong data-testid="count-needs_cleaning">
                  {counts.needs_cleaning}
                </strong>
                <span>Needs cleaning</span>
              </div>
              {
                <div
                  className="summary-stat unknown"
                  data-testid="verifying-count"
                >
                  <span className="stat-icon">
                    <CircleHelp size={18} />
                  </span>
                  <strong data-testid="count-unknown">{counts.unknown}</strong>
                  <span>{manualGrey ? "Grey / verifying" : "Verifying"}</span>
                </div>
              }
              <div className="summary-time">
                <Clock3 size={16} />
                <span>
                  Video time <strong>{stamp(time)}</strong>
                </span>
                {counts.unknown > 0 && (
                  <small>
                    {counts.unknown}{" "}
                    {manualGrey ? "grey / verifying" : "verifying"}
                  </small>
                )}
              </div>
            </section>
            <div className="workspace-grid">
              <section className="panel video-panel">
                <div className="panel-heading">
                  <div className="panel-title">
                    <span className="square-icon">
                      <ScanLine size={17} />
                    </span>
                    <h2>{aiGenerated ? "Video view" : "Camera view"}</h2>
                    <span className="subtle-chip">
                      {aiGenerated ? "AI CLIP" : "CAM 01"}
                    </span>
                  </div>
                  <button
                    className={`text-button ${overlays ? "active" : ""}`}
                    onClick={() => setOverlays(!overlays)}
                    aria-pressed={overlays}
                  >
                    <Eye size={15} />
                    Overlays{" "}
                    <span className={`toggle ${overlays ? "on" : ""}`} />
                  </button>
                </div>
                <div
                  className="video-wrapper"
                  style={{
                    aspectRatio: `${bundle.video.width} / ${bundle.video.height}`,
                  }}
                >
                  <video
                    ref={video}
                    key={loaded?.asset(bundle.video.file)}
                    data-testid="video"
                    src={loaded?.asset(bundle.video.file)}
                    preload="auto"
                    playsInline
                    muted
                    onLoadedMetadata={() => {
                      if (video.current) {
                        video.current.currentTime = initialTime.current;
                        video.current.playbackRate = Number(speed);
                      }
                    }}
                    onLoadedData={() => drawCrop()}
                    onTimeUpdate={() => {
                      if (video.current) setTime(video.current.currentTime);
                      if (video.current?.paused) drawCrop();
                    }}
                    onSeeked={() => {
                      if (video.current) setTime(video.current.currentTime);
                      drawCrop();
                    }}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onEnded={() => setPlaying(false)}
                    onError={() =>
                      setVideoError(
                        "Video unavailable or unsupported. Open a bundle with a browser-compatible MP4.",
                      )
                    }
                  />
                  {overlays && (
                    <svg
                      className="video-overlay"
                      viewBox={`0 0 ${bundle.video.width} ${bundle.video.height}`}
                      aria-label="Source-coordinate video overlays"
                    >
                      {bundle.tables
                        .filter((item) => item.monitoring_enabled !== false)
                        .map((item) => {
                          const geometry = tableOverlayGeometry(
                            item,
                            bundle.video.width,
                            bundle.video.height,
                          );
                          if (!geometry) return null;
                          const cfg = STATUS[snapshot.tables[item.id].status];
                          return (
                            <g
                              key={item.id}
                              data-testid={`video-table-${item.id}`}
                              onClick={() => setSelected(item.id)}
                              className="video-region"
                            >
                              <polygon
                                points={geometry.points}
                                fill={cfg.color}
                                fillOpacity={selected === item.id ? ".08" : "0"}
                                stroke={cfg.color}
                                strokeWidth={selected === item.id ? 3 : 2}
                                strokeDasharray={
                                  snapshot.tables[item.id].status === "unknown"
                                    ? "8 6"
                                    : undefined
                                }
                              />
                              <TableOverlayLabel
                                table={item}
                                width={bundle.video.width}
                                height={bundle.video.height}
                                color={cfg.color}
                              />
                            </g>
                          );
                        })}
                      {currentObservation?.valid &&
                        (currentObservation.tracks ?? [])
                          .filter(
                            (track) =>
                              !track.table_id ||
                              snapshot.tables[track.table_id]
                                ?.monitoring_enabled !== false,
                          )
                          .map((track) => {
                            const [x1, y1, x2, y2] = track.box;
                            return (
                              <g
                                key={track.track_id}
                                data-track-id={track.track_id}
                                data-track-state={
                                  track.observed ? "observed" : "predicted"
                                }
                              >
                                <title>{`Track ${track.track_id} · ${track.observed ? "observed" : "predicted — not new presence evidence"}`}</title>
                                <rect
                                  x={x1 * bundle.video.width}
                                  y={y1 * bundle.video.height}
                                  width={(x2 - x1) * bundle.video.width}
                                  height={(y2 - y1) * bundle.video.height}
                                  rx="4"
                                  fill="none"
                                  stroke={
                                    track.observed ? "#e6b43d" : "#90a8a0"
                                  }
                                  strokeWidth="2"
                                  strokeDasharray={
                                    track.observed ? undefined : "7 5"
                                  }
                                  opacity={track.observed ? 1 : 0.65}
                                />
                                <text
                                  x={x1 * bundle.video.width + 4}
                                  y={Math.max(14, y1 * bundle.video.height - 5)}
                                  fontSize="13"
                                  fill={track.observed ? "#936c09" : "#627d71"}
                                >
                                  {trackAliases.get(track.track_id)}
                                  {track.observed ? "" : " · predicted"}
                                </text>
                              </g>
                            );
                          })}
                    </svg>
                  )}
                  <div className="video-caption">
                    <span
                      className={
                        playing ? "play-indicator playing" : "play-indicator"
                      }
                    />
                    {playing
                      ? "Playing"
                      : time >= bundle.video.duration_s
                        ? "Playback ended"
                        : "Paused"}
                    <span className="caption-separator" />
                    {stamp(time)} / {stamp(bundle.video.duration_s)}
                  </div>
                  {videoError && (
                    <div className="video-error" role="alert">
                      <ImageIcon />
                      <p>{videoError}</p>
                    </div>
                  )}
                </div>
                <div className="playback-bar">
                  <button
                    data-testid="play-toggle"
                    className="play-button"
                    onClick={() => void togglePlay()}
                    aria-label={playing ? "Pause video" : "Play video"}
                  >
                    {playing ? (
                      <Pause size={17} fill="currentColor" />
                    ) : (
                      <Play size={17} fill="currentColor" />
                    )}
                  </button>
                  <button
                    data-testid="restart"
                    className="icon-button"
                    onClick={restart}
                    aria-label="Restart playback"
                  >
                    <RotateCcw size={17} />
                  </button>
                  <span className="playback-time">
                    {stamp(time)}{" "}
                    <span>/ {stamp(bundle.video.duration_s)}</span>
                  </span>
                  <input
                    data-testid="playback-seek"
                    className="playback-seek"
                    type="range"
                    min="0"
                    max={bundle.video.duration_s}
                    step="0.1"
                    value={time}
                    aria-label="Seek video"
                    aria-valuetext={stamp(time)}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (video.current) video.current.currentTime = next;
                      setTime(next);
                    }}
                  />
                  <label className="speed-label">
                    <span className="visually-hidden">Playback speed</span>
                    <select
                      data-testid="playback-speed"
                      value={speed}
                      onChange={(event) => {
                        setSpeed(event.target.value);
                        if (video.current)
                          video.current.playbackRate = Number(
                            event.target.value,
                          );
                      }}
                    >
                      {PLAYBACK_SPEEDS.map((value) => (
                        <option key={value} value={value}>
                          {value}×
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={13} />
                  </label>
                </div>
                <div
                  data-testid="source-provenance"
                  className={`provenance ${synthetic || aiGenerated ? "synthetic" : ""}`}
                >
                  <span className="tiny-dot" />
                  <span>
                    {synthetic
                      ? "Synthetic workflow demo — not detection evidence"
                      : aiGenerated
                        ? "AI-generated video · Precomputed model detections"
                        : "Prerecorded video · Precomputed detections"}
                  </span>
                  <span className="local-processing">Local playback</span>
                </div>
                {bundle.analysis.timing_profile === "demo_fast_3x" && (
                  <div
                    className="analysis-note"
                    data-testid="timing-profile-notice"
                  >
                    <Clock3 size={13} />
                    <span>Fast demo · decision waits ÷3 · video {speed}×</span>
                  </div>
                )}
                {(bundle.analysis.surface_analysis_complete === false ||
                  bundle.analysis.surface_model_skipped === true) && (
                  <div
                    className="analysis-note"
                    data-testid="surface-analysis-notice"
                  >
                    <CircleHelp size={13} />
                    <span>
                      {bundle.analysis.surface_model_skipped === true
                        ? "Tracking-only diagnostic. Surface checks have not run; automatic readiness is unavailable for this recording."
                        : "Surface analysis is incomplete. Readiness uses only the assessment evidence included in this recording."}
                    </span>
                  </div>
                )}
              </section>
              <section className="panel map-panel">
                <div className="panel-heading">
                  <div className="panel-title">
                    <span className="square-icon">
                      <LayoutGrid size={17} />
                    </span>
                    <h2>Floor plan</h2>
                  </div>
                  <span className="synced">
                    <span />
                    Video synced
                  </span>
                </div>
                <div className="map-context">
                  <span>MAIN DINING ROOM</span>
                  <span>
                    {floorPlan ? "Uploaded plan" : "Schematic"} ·{" "}
                    {bundle.tables.length} tables
                  </span>
                </div>
                <FloorMap
                  key={bundle.video.sha256}
                  tables={bundle.tables}
                  states={snapshot.tables}
                  selected={table.id}
                  onSelect={setSelected}
                  floorPlan={floorPlan}
                />
                <div className="map-legend">
                  <span>
                    <i className="ready" />
                    Ready
                  </span>
                  <span>
                    <i className="occupied" />
                    Occupied
                  </span>
                  <span>
                    <i className="needs_cleaning" />
                    Needs cleaning
                  </span>
                  {counts.unknown > 0 && (
                    <span>
                      <i className="unknown" />
                      {manualGrey ? "Grey / verifying" : "Verifying"}
                    </span>
                  )}
                  {disabledCount > 0 && (
                    <span>
                      <i className="disabled-key" />
                      Disabled
                    </span>
                  )}
                  <span className="legend-hint">Select a table to inspect</span>
                </div>
              </section>
            </div>
            <div className="detail-grid">
              <section
                className="panel detail-panel"
                data-testid="table-detail"
              >
                <div className="panel-heading">
                  <div className="panel-title">
                    <span className="selected-table-icon">{table.id}</span>
                    <h2>Table details</h2>
                    {
                      <span className="subtle-text">
                        {state.monitoring_enabled === false
                          ? "Monitoring off"
                          : "Monitoring"}
                      </span>
                    }
                  </div>
                  <span data-testid="selected-status">
                    <StatusPill state={state} />
                  </span>
                </div>
                <div className="table-label-editor">
                  <label>
                    Table name
                    <input
                      data-testid="table-label"
                      value={tableName}
                      onChange={(event) => setTableName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void renameTable();
                      }}
                    />
                  </label>
                  <button
                    data-testid="table-label-save"
                    className="button secondary compact"
                    disabled={savingName || tableName === table.label}
                    onClick={() => void renameTable()}
                  >
                    {savingName ? "Saving…" : "Save name"}
                  </button>
                  <small>ID {table.id}</small>
                </div>
                {
                  <ServiceControls
                    state={state}
                    onAction={staffAction}
                    onMonitoring={setMonitoring}
                  />
                }
                {
                  <div className="parallel-states">
                    <div data-testid="people-state">
                      <span>People</span>
                      <strong>
                        {
                          {
                            vacant: "Vacant",
                            pending_arrival: "Arrival pending",
                            occupied: "Occupied",
                            pending_departure: "Departure pending",
                            uncertain: "Uncertain",
                          }[state.people_state ?? "uncertain"]
                        }
                      </strong>
                      <p>{state.people_reason}</p>
                    </div>
                    <div data-testid="surface-state">
                      <span>Surface</span>
                      <strong>
                        {
                          {
                            cleared_reset: "Cleared & reset",
                            needs_reset: "Needs reset",
                            unverified: "Unverified",
                          }[state.surface_state ?? "unverified"]
                        }
                      </strong>
                      <p>{state.surface_reason}</p>
                      {state.readiness_source === "staff_override" && (
                        <small
                          data-testid="readiness-provenance"
                          className="override-provenance"
                        >
                          Staff override ·{" "}
                          {stamp(state.surface_evidence_t ?? time)}
                        </small>
                      )}
                      {state.last_assessment && (
                        <small>
                          Last assessment {stamp(state.last_assessment.t)} ·{" "}
                          {state.last_assessment.generation === state.generation
                            ? "current generation"
                            : "historical evidence"}
                        </small>
                      )}
                    </div>
                  </div>
                }
                <div className="comparison">
                  <figure>
                    <div className="figure-title">
                      <span>
                        <ImageIcon size={14} />
                        {table.reference?.source_kind === "uploaded_image"
                          ? "Uploaded clean photo"
                          : table.reference?.confirmed_clean
                            ? "Original / clean reference"
                            : "Original reference"}
                      </span>
                      <span>
                        {table.reference?.source_kind === "uploaded_image"
                          ? "Photo"
                          : table.reference
                            ? stamp(table.reference.source_t)
                            : "—"}
                      </span>
                    </div>
                    <div className="crop-frame">
                      {reference && !referenceError ? (
                        <img
                          data-testid="reference-image"
                          src={reference}
                          onError={() => setReferenceError(true)}
                          alt={`${table.id} ${table.reference?.source_kind === "uploaded_image" ? "uploaded clean photo" : table.reference?.confirmed_clean ? "original clean reference" : "original reference — cleaning unconfirmed"}${table.reference?.source_kind === "uploaded_image" ? "" : synthetic ? " — synthetic illustration" : aiGenerated ? " — frame from AI-generated video" : ""}`}
                        />
                      ) : (
                        <div className="image-placeholder">
                          <ImageIcon size={24} />
                          <span>No clean reference supplied</span>
                        </div>
                      )}
                      <span className="image-table-tag">{table.id}</span>
                      {table.reference && (
                        <span
                          className="image-note"
                          title={
                            table.reference.reviewed_by
                              ? `Reference reviewed by ${table.reference.reviewed_by}`
                              : undefined
                          }
                          aria-label={
                            table.reference.reviewed_by
                              ? `Reference reviewed by ${table.reference.reviewed_by}`
                              : undefined
                          }
                        >
                          {table.reference.confirmed_clean ? (
                            <>
                              <Check size={12} />
                              {table.reference.source_kind === "uploaded_image"
                                ? "Staff-confirmed photo"
                                : synthetic
                                  ? "Illustrated reference"
                                  : aiGenerated
                                    ? "Confirmed reference · AI video"
                                    : "Staff-confirmed reference"}
                            </>
                          ) : (
                            <>
                              <CircleHelp size={12} />
                              Unconfirmed reference
                            </>
                          )}
                        </span>
                      )}
                    </div>
                  </figure>
                  <div className="comparison-arrow">
                    <ArrowUpRight size={17} />
                  </div>
                  <figure>
                    <div className="figure-title">
                      <span>
                        <ScanLine size={14} />
                        Current video frame
                      </span>
                      <span>{stamp(time)}</span>
                    </div>
                    <div className="crop-frame">
                      <canvas
                        ref={canvas}
                        data-testid="current-crop"
                        aria-label={`${table.id} current video crop at ${stamp(time)}`}
                      />
                      {cropError && (
                        <div className="video-error" role="alert">
                          <ImageIcon />
                          <p>{cropError}</p>
                        </div>
                      )}
                      <span className="image-table-tag">{table.id}</span>
                      <span className={`image-note ${state.status}`}>
                        <span className="tiny-dot" />
                        {state.monitoring_enabled === false
                          ? "Disabled"
                          : state.manual_override
                            ? `${COLOURS[state.status]} · Manual`
                            : state.status === "unknown"
                              ? "Verifying"
                              : STATUS[state.status].short}
                      </span>
                    </div>
                  </figure>
                </div>
                <ObjectEvidence
                  table={table}
                  assessment={state.last_assessment}
                  image={loaded?.asset(state.last_assessment?.crop_file)}
                />
                <div className="table-action-row">
                  <div>
                    <strong>
                      {state.monitoring_enabled === false
                        ? "Monitoring is disabled."
                        : state.manual_override
                          ? `Chosen service colour: ${COLOURS[state.status]}.`
                          : state.status === "needs_cleaning"
                            ? "Cleaning or reset confirmation is needed."
                            : state.status === "occupied"
                              ? "People are using this table."
                              : state.status === "ready"
                                ? "Ready for the next guests."
                                : "Readiness is being verified."}
                    </strong>
                    <p>
                      {state.monitoring_enabled === false
                        ? "Enable this table to resume monitoring and staff controls."
                        : state.manual_override
                          ? "This is a manual service colour. Check the independent people and surface states above."
                          : state.status === "needs_cleaning"
                            ? "After cleaning, repeated matching captures confirm green. Red stays on while the visible reset is being confirmed."
                            : state.status === "occupied"
                              ? "Readiness can be confirmed once the table is vacant."
                              : state.status === "ready"
                                ? state.readiness_source === "staff_override"
                                  ? "Staff override bypassed tabletop verification; occupancy still applies."
                                  : state.readiness_source === "staff"
                                    ? "Readiness was explicitly confirmed by staff."
                                    : "Repeated source captures confirmed this vacant table."
                                : state.reason}
                    </p>
                  </div>
                  <div className="staff-controls automatic-controls">
                    <button
                      data-testid="needs-cleaning"
                      className="button secondary compact"
                      disabled={state.monitoring_enabled === false}
                      onClick={() => staffAction("needs_cleaning")}
                    >
                      <Flag size={14} />
                      Needs cleaning
                    </button>
                    <button
                      data-testid="confirm-cleaned"
                      className="button confirm compact"
                      disabled={!state.can_confirm_cleaned}
                      title={
                        !state.can_confirm_cleaned
                          ? "Requires stable vacancy and valid observations."
                          : "Confirm this empty table is cleaned and ready."
                      }
                      onClick={() => staffAction("confirm_cleaned")}
                    >
                      <Check size={16} />
                      Confirm cleaned
                    </button>
                    {
                      <>
                        <button
                          data-testid="force-cleaned"
                          className="button secondary compact force-clean-button"
                          disabled={!state.can_force_cleaned}
                          title={
                            state.can_force_cleaned
                              ? "Override tabletop verification; occupancy still applies."
                              : "Requires stable, valid vacancy. Occupied, pending or uncertain people evidence cannot be overridden."
                          }
                          aria-describedby="force-clean-note"
                          onClick={() => staffAction("force_cleaned")}
                        >
                          <Sparkles size={14} />
                          Force clean
                        </button>
                        <small id="force-clean-note" className="override-note">
                          Override tabletop verification; occupancy still
                          applies.
                        </small>
                      </>
                    }
                  </div>
                </div>
              </section>
              <section className="panel activity-panel">
                <div className="panel-heading">
                  <div className="panel-title">
                    <Clock3 size={17} />
                    <h2>Recent activity</h2>
                  </div>
                  <button
                    className="icon-button small"
                    onClick={downloadEvents}
                    aria-label="Download replay events"
                  >
                    <Download size={16} />
                  </button>
                </div>
                <ol className="event-log" data-testid="event-log">
                  {snapshot.events
                    .slice(-4)
                    .reverse()
                    .map((event, index) => (
                      <li
                        key={`${event.t}-${event.table_id}-${event.kind}-${index}`}
                      >
                        <span className={`event-dot ${event.status}`}>
                          {event.kind === "staff_rejected" ? (
                            <X size={12} />
                          ) : event.status === "ready" ? (
                            <Check size={12} />
                          ) : event.status === "occupied" ? (
                            <Users size={12} />
                          ) : (
                            <Sparkles size={12} />
                          )}
                        </span>
                        <div>
                          <strong>
                            {event.table_id}
                            <span>
                              {event.kind === "staff_rejected"
                                ? "Confirmation blocked"
                                : event.kind === "staff_accepted"
                                  ? "Staff action recorded"
                                  : event.reason.startsWith("Manual override:")
                                    ? "Manual colour set"
                                    : event.status === "unknown"
                                      ? "Verifying"
                                      : STATUS[event.status].short}
                            </span>
                          </strong>
                          <p>{event.reason}</p>
                        </div>
                        <time>{stamp(event.t)}</time>
                      </li>
                    ))}
                  {snapshot.events.length === 0 && (
                    <li className="empty-events">
                      <Clock3 size={22} />
                      <p>Activity will appear as the video plays.</p>
                    </li>
                  )}
                </ol>
                <div className="activity-footnote">
                  <span className="tiny-dot" />
                  Changes use video time, including staff actions.
                </div>
              </section>
            </div>
            <footer>
              <span>
                <span className="footer-mark">
                  <LayoutGrid size={13} />
                </span>
                Built for a smoother service.
              </span>
              <span>
                {
                  "Occupancy and visual readiness are estimated from camera evidence."
                }
                <button onClick={() => setInfoOpen(true)}>
                  How it works <ArrowUpRight size={12} />
                </button>
              </span>
            </footer>
          </>
        )}
      </main>
      {(originalOpen || infoOpen) && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setOriginalOpen(false);
            setInfoOpen(false);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <h2 id="dialog-title">
                {originalOpen
                  ? "Original restaurant scene"
                  : "How TurnTable works"}
              </h2>
              <button
                className="icon-button"
                autoFocus
                onClick={() => {
                  setOriginalOpen(false);
                  setInfoOpen(false);
                }}
                aria-label="Close dialog"
              >
                <X size={20} />
              </button>
            </div>
            {originalOpen ? (
              <OriginalScene
                uploadedPhoto={uploadedPhoto}
                openingFrame={openingFrame}
                openingTime={originalSceneTimeLabel}
                provenance={bundle?.provenance}
                sourceId={loaded?.source?.id}
                onChangeReference={changeReferencePhoto}
              />
            ) : (
              <div className="how-it-works">
                <p>
                  A fixed-camera recording is analyzed once. Saved person
                  observations are associated with each table’s calibrated
                  camera zones, then replayed using the video clock.
                </p>
                <div>
                  <span className="status-dot ready" />
                  <strong>Green</strong>
                  <p>
                    {objectStability ? (
                      <>
                        Initially, {bundle!.rules.exit_s} seconds of confirmed
                        vacancy and two matching captures at least{" "}
                        {bundle!.rules.assessment_separation_s ?? 2} seconds
                        apart. After red, at least{" "}
                        {objectStability.clean_confirmation_captures} matching
                        captures spanning{" "}
                        {waitLabel(objectStability.clean_confirmation_s)}{" "}
                        seconds confirm green. Staff can also confirm or
                        override readiness.
                      </>
                    ) : (
                      "Vacant, with two qualifying surface assessments, an explicit staff confirmation or a recorded Force clean override."
                    )}
                  </p>
                </div>
                <div>
                  <span className="status-dot occupied" />
                  <strong>Yellow</strong>
                  <p>
                    The same tracked person must be in the table’s zone for{" "}
                    {bundle?.rules.entry_s ?? 2} seconds.{" "}
                    {
                      "Pending presence shows grey; confirmed occupancy stays yellow."
                    }
                  </p>
                </div>
                <div>
                  <span className="status-dot needs_cleaning" />
                  <strong>Red</strong>
                  <p>
                    {objectStability ? (
                      <>
                        After {waitLabel(objectStability.early_dirty_vacancy_s)}{" "}
                        second of valid vacancy and{" "}
                        {waitLabel(objectStability.unobstructed_s)} second with
                        a visible tabletop, a difference above{" "}
                        {REFERENCE_CLEANING_THRESHOLD * 100}% can turn the table
                        red. An object-only mismatch or change in framing
                        correction needs a follow-up check. Regular checks
                        repeat every {waitLabel(objectStability.recheck_s)}{" "}
                        seconds.
                      </>
                    ) : (
                      <>
                        A visible table, vacant for {bundle?.rules.exit_s ?? 5}{" "}
                        seconds, needs cleaning when its surface assessment
                        finds it has not been reset. Yellow takes priority while
                        occupied.
                      </>
                    )}
                  </p>
                </div>
                <p>
                  {objectStability ? (
                    "Grey means person or tabletop evidence is still being checked. Without confirmed occupancy, blocked or ambiguous evidence shows grey. A confirmed cleaning need stays red during unobstructed reset or follow-up checks."
                  ) : (
                    <>
                      Grey “Verifying” is the starting state and stays on during
                      the {bundle?.rules.entry_s ?? 5}-second arrival and{" "}
                      {bundle?.rules.exit_s ?? 5}-second vacancy waits. Green
                      requires confirmed vacancy and passing tabletop checks.
                    </>
                  )}
                </p>
                <p>
                  All waits use video time.{" "}
                  {Number(speed) !== 1 && (
                    <>
                      At {speed}× playback, {bundle?.rules.entry_s ?? 5} video
                      seconds take about{" "}
                      {Number(
                        ((bundle?.rules.entry_s ?? 5) / Number(speed)).toFixed(
                          1,
                        ),
                      )}{" "}
                      seconds on screen.
                    </>
                  )}
                </p>
                <p>
                  Each table ID links its calibrated camera zones to a
                  separately configured floor-plan position. Changing the camera
                  or layout requires a new setup.
                </p>
                {
                  <p>
                    Each table’s four tabletop corners straighten its comparison
                    pictures. Force clean overrides tabletop verification after
                    stable vacancy and records a staff override at the current
                    video time.
                  </p>
                }
                {
                  <p>
                    The Red, Yellow, Green and Grey buttons hold a chosen
                    service colour until Auto or Restart. Disable a table to
                    exclude it from counts and analysis requests; this choice is
                    remembered for this video and calibration.
                  </p>
                }
                {synthetic && (
                  <p className="demo-note">
                    This recording uses diagram footage and hand-authored
                    observations to demonstrate the workflow. Load a processed
                    real video to inspect actual detection results.
                  </p>
                )}
                {aiGenerated && (
                  <p className="demo-note">
                    This recording uses actual model detections on AI-generated
                    video. It tests the processing and playback workflow, but
                    does not establish accuracy on real restaurant footage.
                    Reference frames are not confirmed clean unless explicitly
                    recorded as such.
                  </p>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
