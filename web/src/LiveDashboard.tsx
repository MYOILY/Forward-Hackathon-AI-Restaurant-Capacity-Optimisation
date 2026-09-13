import { ObjectEvidence } from "./ObjectEvidence";
import { TableOverlayLabel } from "./TableOverlayLabel";
import { tableOverlayGeometry } from "./table-overlay-geometry";
import { useEffect, useRef, useState } from "react";
import type {
  Observation,
  StaffEvent,
  Status,
  Table,
} from "../../shared/contracts";
import type {
  LiveConfig,
  LiveSnapshot,
  SourceInfo,
} from "../../shared/live-contracts";
import { api, assetPath, imageSource, validLabel } from "./api";
import { FloorMap } from "./FloorMap";
import { COLOURS, ServiceControls, STATE_LABELS } from "./ServiceControls";
import {
  createRectificationPlan,
  rectifyRgba,
  type RectificationPlan,
} from "./rectification";

export interface LiveConnection {
  session_id: string;
  epoch: number;
  config: LiveConfig;
  ws_url: string;
}
type AnalyzedFrame = {
  seq: number;
  captured_t: number;
  image_base64: string;
  width: number;
  height: number;
};
type Update = {
  type: string;
  snapshot?: LiveSnapshot;
  t?: number;
  stats?: Record<string, number>;
  frame?: AnalyzedFrame;
  observation?: Observation;
  tables?: Table[];
  message?: string;
  client_t?: number;
};

export function LiveDashboard({
  source,
  connection,
  stream,
  onStopped,
}: {
  source: SourceInfo;
  connection: LiveConnection;
  stream: MediaStream;
  onStopped: () => void;
}) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null),
    [tables, setTables] = useState(connection.config.tables),
    [selected, setSelected] = useState(connection.config.tables[0].id);
  const [frame, setFrame] = useState<AnalyzedFrame | null>(null),
    [observation, setObservation] = useState<Observation | undefined>(),
    [stats, setStats] = useState<Record<string, number>>({}),
    [error, setError] = useState(""),
    [connected, setConnected] = useState(false),
    [overlays, setOverlays] = useState(true),
    [name, setName] = useState("");
  const [rawPreview, setRawPreview] = useState(false),
    [clientNow, setClientNow] = useState(() => performance.now() / 1000),
    [stopPending, setStopPending] = useState(false);
  const cropCache = useRef<{
    key: string;
    plan: RectificationPlan;
    source: HTMLCanvasElement;
    output: ImageData;
  } | null>(null);
  const camera = useRef<HTMLVideoElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    socket = useRef<WebSocket | null>(null),
    stopping = useRef(false);
  const clockOffset = useRef<number | null>(null),
    lifetime = useRef(0),
    stopRequest = useRef<Promise<unknown> | null>(null);
  const table = tables.find((item) => item.id === selected) ?? tables[0],
    state = snapshot?.tables[table.id];
  useEffect(() => {
    setName(table.label);
  }, [table.label, table.id]);
  useEffect(() => {
    const timer = window.setInterval(
      () => setClientNow(performance.now() / 1000),
      250,
    );
    return () => clearInterval(timer);
  }, []);
  function requestStop() {
    if (!stopRequest.current)
      stopRequest.current = api(`/live/${connection.session_id}`, {
        method: "DELETE",
      }).catch((err) => {
        stopRequest.current = null;
        throw err;
      });
    return stopRequest.current;
  }
  useEffect(() => {
    const generation = ++lifetime.current;
    let alive = true;
    let releaseSocket = () => {};
    // Only the committed mount may claim the server's exclusive WebSocket session.
    const connectTimer = window.setTimeout(() => {
      if (!alive) return;
      const media = camera.current!;
      media.srcObject = stream;
      void media
        .play()
        .catch(() => setError("Camera preview could not start."));
      const url = new URL(connection.ws_url, location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      socket.current = ws;
      let sequence = 0,
        lastCapture = -1;
      const capture = document.createElement("canvas");
      const synchronize = () => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify({
              type: "sync",
              client_t: performance.now() / 1000,
            }),
          );
      };
      ws.onopen = () => {
        setConnected(true);
        synchronize();
      };
      ws.onmessage = (event) => {
        if (!alive) return;
        try {
          const update: Update = JSON.parse(event.data);
          if (
            update.type === "clock" &&
            clockOffset.current === null &&
            typeof update.t === "number" &&
            Number.isFinite(update.t) &&
            typeof update.client_t === "number" &&
            Number.isFinite(update.client_t)
          )
            clockOffset.current =
              update.t - (update.client_t + performance.now() / 1000) / 2;
          if (update.type === "update") {
            if (update.snapshot) setSnapshot(update.snapshot);
            if (update.stats) setStats(update.stats);
            if (update.tables) setTables(update.tables);
            if (update.frame) {
              setFrame(update.frame);
              setObservation(update.observation);
            }
          }
          if (update.type === "error")
            setError(update.message ?? "Live processing failed.");
          if (update.type === "stopped") {
            if (update.snapshot) setSnapshot(update.snapshot);
            setConnected(false);
            stream.getTracks().forEach((track) => track.stop());
          }
        } catch {
          setError("The live service sent an invalid message.");
        }
      };
      ws.onerror = () => {
        setConnected(false);
        setError(
          "The live connection failed. Stop and start a new session to reconnect.",
        );
      };
      ws.onclose = () => {
        if (alive) {
          setConnected(false);
          if (!stopping.current)
            setError(
              "Live connection closed. The last analyzed image is retained; start a new session to reconnect.",
            );
        }
      };
      const clock = window.setInterval(synchronize, 2000);
      const sender = window.setInterval(
        () => {
          if (
            clockOffset.current === null ||
            ws.readyState !== WebSocket.OPEN ||
            ws.bufferedAmount > 512 * 1024 ||
            media.readyState < 2 ||
            stopping.current
          )
            return;
          const scale = Math.min(
            1,
            1280 / media.videoWidth,
            720 / media.videoHeight,
          );
          const width = Math.round(media.videoWidth * scale),
            height = Math.round(media.videoHeight * scale);
          if (!width || !height) return;
          capture.width = width;
          capture.height = height;
          capture.getContext("2d")!.drawImage(media, 0, 0, width, height);
          const captured_t = Math.max(
            0,
            performance.now() / 1000 + clockOffset.current,
          );
          if (captured_t <= lastCapture) return;
          const image_base64 = capture
            .toDataURL("image/jpeg", 0.76)
            .split(",")[1];
          if (image_base64.length > 2 * 1024 * 1024 - 512) return;
          lastCapture = captured_t;
          ws.send(
            JSON.stringify({
              type: "frame",
              session_id: connection.session_id,
              epoch: connection.epoch,
              seq: sequence++,
              captured_t,
              image_base64,
            }),
          );
        },
        1000 / Math.min(15, connection.config.sample_hz),
      );
      releaseSocket = () => {
        clearInterval(clock);
        clearInterval(sender);
        ws.close();
        media.srcObject = null;
      };
    }, 0);
    return () => {
      alive = false;
      clearTimeout(connectTimer);
      releaseSocket();
      // StrictMode replays effects on mount; release the shared camera only on a genuine unmount.
      queueMicrotask(() => {
        if (lifetime.current !== generation) return;
        stream.getTracks().forEach((track) => track.stop());
        void requestStop().catch(() => undefined);
      });
    };
  }, [connection, stream]);
  useEffect(() => {
    if (!frame || !table.tabletop_polygon || !canvas.current) return;
    let alive = true;
    const image = new Image();
    image.src = imageSource(frame.image_base64);
    image.onload = () => {
      if (!alive || !canvas.current) return;
      try {
        const target = canvas.current,
          targetContext = target.getContext("2d")!,
          key = `${table.id}:${table.geometry_sha256}:${image.naturalWidth}:${image.naturalHeight}`;
        if (cropCache.current?.key !== key) {
          const plan = createRectificationPlan(
              table.tabletop_polygon!,
              image.naturalWidth,
              image.naturalHeight,
            ),
            sourceCanvas = document.createElement("canvas");
          sourceCanvas.width = image.naturalWidth;
          sourceCanvas.height = image.naturalHeight;
          cropCache.current = {
            key,
            plan,
            source: sourceCanvas,
            output: targetContext.createImageData(plan.width, plan.height),
          };
        }
        const { plan, source: sourceCanvas, output } = cropCache.current,
          context = sourceCanvas.getContext("2d", {
            willReadFrequently: true,
          })!;
        context.drawImage(image, 0, 0);
        if (target.width !== plan.width || target.height !== plan.height) {
          target.width = plan.width;
          target.height = plan.height;
        }
        rectifyRgba(
          plan,
          context.getImageData(0, 0, image.naturalWidth, image.naturalHeight)
            .data,
          output.data,
        );
        targetContext.putImageData(output, 0, 0);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    return () => {
      alive = false;
    };
  }, [frame?.seq, frame?.image_base64, table.id, table.geometry_sha256]);
  function send(value: unknown) {
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify(value));
    else setError("The camera session is disconnected.");
  }
  function staff(action: StaffEvent["action"], status?: Status) {
    send({
      type: "staff",
      action,
      ...(status ? { status } : {}),
      table_id: table.id,
    });
  }
  async function stop() {
    if (stopPending) return;
    stopping.current = true;
    setStopPending(true);
    stream.getTracks().forEach((track) => track.stop());
    try {
      await requestStop();
      onStopped();
    } catch (err) {
      setError(
        `Camera capture stopped, but the service has not confirmed cleanup. Retry Stop. ${String(err)}`,
      );
      setStopPending(false);
    }
  }
  function rename() {
    try {
      const label = validLabel(
        name,
        tables.filter((item) => item.id !== table.id).map((item) => item.label),
      );
      if (label !== table.label)
        send({ type: "rename", table_id: table.id, label });
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  const age = frame
    ? Math.max(
        0,
        stats.frame_age_s ?? 0,
        (clockOffset.current === null
          ? (snapshot?.t ?? frame.captured_t)
          : clientNow + clockOffset.current) - frame.captured_t,
      )
    : null;
  const unavailable = !connected
    ? "Connection unavailable"
    : age === null || age > connection.config.rules.gap_s
      ? "Current evidence unavailable"
      : undefined;
  // This is a transport freshness mask, not a second state machine. Raw server evidence is retained below.
  const displayStates = Object.fromEntries(
    Object.entries(snapshot?.tables ?? {}).map(([id, item]) => [
      id,
      unavailable && !item.manual_override && item.monitoring_enabled !== false
        ? { ...item, status: "unknown" as Status }
        : item,
    ]),
  );
  const enabled = tables.filter((item) => item.monitoring_enabled !== false),
    counts = Object.values(displayStates)
      .filter((item) => item.monitoring_enabled !== false)
      .reduce(
        (all, item) => ({ ...all, [item.status]: all[item.status] + 1 }),
        { ready: 0, occupied: 0, needs_cleaning: 0, unknown: 0 },
      );
  const colors: Record<Status, string> = {
    ready: "#188455",
    occupied: "#bb830c",
    needs_cleaning: "#d24a43",
    unknown: "#7b8389",
  };
  const floorPlan =
    source.floor_plan_mode !== "schematic"
      ? source.setup_assets?.floor_plan
      : undefined;
  const aliases = useRef(new Map<string, string>()),
    nextAlias = useRef(1);
  for (const track of observation?.tracks ?? [])
    if (!aliases.current.has(track.track_id)) {
      aliases.current.set(track.track_id, `P${nextAlias.current++}`);
      if (aliases.current.size > 512)
        aliases.current.delete(aliases.current.keys().next().value!);
    }
  return (
    <section className="live-dashboard">
      <div className="setup-heading">
        <div>
          <div className="eyebrow">
            LIVE CAMERA ·{" "}
            {connection.config.detection_only
              ? "DETECTION ONLY"
              : "LOCAL SURFACE CHECKS"}
          </div>
          <h2>{source.label}</h2>
          <p data-testid="live-connection-status">
            {unavailable ?? "Connected"} · {enabled.length} monitored tables ·
            No ongoing camera video is recorded.
          </p>
        </div>
        <button
          className="button dark"
          data-testid="live-stop"
          disabled={stopPending}
          onClick={() => void stop()}
        >
          {stopPending ? "Stopping…" : "Stop camera"}
        </button>
      </div>
      {error && (
        <p className="input-error" role="alert">
          {error}
        </p>
      )}
      <div className="live-summary">
        {Object.entries(counts).map(([status, count]) => (
          <span key={status}>
            <i style={{ background: colors[status as Status] }} />
            <strong data-testid={`count-${status}`}>{count}</strong>{" "}
            {status === "unknown" &&
            (unavailable ||
              Object.values(displayStates).some(
                (item) => item.manual_override?.status === "unknown",
              ))
              ? unavailable
                ? "Grey / unavailable"
                : "Grey / verifying"
              : STATE_LABELS[status as Status]}
          </span>
        ))}
        <span>{tables.length - enabled.length} disabled</span>
      </div>
      <div className="workspace-grid">
        <section className="panel">
          <div className="panel-heading">
            <h2>
              {rawPreview ? "Raw camera preview" : "Analyzed camera frame"}
            </h2>
            <div className="live-frame-tools">
              <button
                data-testid="raw-preview-toggle"
                className="text-button"
                aria-pressed={rawPreview}
                onClick={() => setRawPreview(!rawPreview)}
              >
                {rawPreview ? "Show analyzed frame" : "Raw preview"}
              </button>
              <button
                className="text-button"
                disabled={rawPreview}
                aria-pressed={overlays}
                onClick={() => setOverlays(!overlays)}
              >
                Overlays {overlays ? "on" : "off"}
              </button>
            </div>
          </div>
          <div
            className="live-frame"
            style={{
              aspectRatio: `${frame?.width ?? connection.config.width}/${frame?.height ?? connection.config.height}`,
            }}
          >
            <video
              ref={camera}
              data-testid="live-raw-preview"
              muted
              playsInline
              className={rawPreview ? "live-raw-preview" : "capture-video"}
              aria-hidden={!rawPreview}
            />
            {!rawPreview &&
              (frame ? (
                <img
                  data-testid="live-analyzed-frame"
                  src={imageSource(frame.image_base64)}
                  alt={`Analyzed camera frame ${frame.seq}, captured at ${frame.captured_t.toFixed(2)} seconds`}
                />
              ) : (
                <div className="live-wait">
                  Waiting for the first analyzed frame…
                </div>
              ))}
            {!rawPreview && !unavailable && overlays && frame && snapshot && (
              <svg
                className="video-overlay"
                viewBox={`0 0 ${frame.width} ${frame.height}`}
              >
                {enabled.map((item) => {
                  const geometry = tableOverlayGeometry(
                    item,
                    frame.width,
                    frame.height,
                  );
                  if (!geometry) return null;
                  return (
                    <g
                      key={item.id}
                      className="video-region"
                      onClick={() => setSelected(item.id)}
                    >
                      <polygon
                        points={geometry.points}
                        fill="none"
                        stroke={colors[snapshot.tables[item.id].status]}
                        strokeWidth="3"
                      />
                      <TableOverlayLabel
                        table={item}
                        width={frame.width}
                        height={frame.height}
                        color={colors[snapshot.tables[item.id].status]}
                      />
                    </g>
                  );
                })}
                {observation?.tracks
                  ?.filter(
                    (track) =>
                      !track.table_id ||
                      snapshot.tables[track.table_id]?.monitoring_enabled !==
                        false,
                  )
                  .map((track) => {
                    const [x1, y1, x2, y2] = track.box;
                    return (
                      <g
                        key={track.track_id}
                        data-track-id={track.track_id}
                        data-observed={track.observed}
                      >
                        <title>{track.track_id}</title>
                        <rect
                          x={x1 * frame.width}
                          y={y1 * frame.height}
                          width={(x2 - x1) * frame.width}
                          height={(y2 - y1) * frame.height}
                          stroke="#c39527"
                          strokeWidth="2"
                          strokeDasharray={track.observed ? undefined : "7 5"}
                          fill="none"
                        />
                        <text
                          x={x1 * frame.width}
                          y={Math.max(14, y1 * frame.height - 4)}
                          fill="#a07e29"
                          fontSize="13"
                        >
                          {aliases.current.get(track.track_id) ??
                            track.track_id.slice(-12)}
                          {track.observed ? "" : " · predicted"}
                        </text>
                      </g>
                    );
                  })}
              </svg>
            )}
          </div>
          {rawPreview && (
            <p className="live-preview-note">
              Unanalyzed camera preview. Detection overlays are shown only on
              the matching analyzed frame.
            </p>
          )}
          <div className="live-metrics">
            <span data-testid="live-frame-age">
              {age === null
                ? "No analyzed frame"
                : `Frame age ${age.toFixed(2)} s${age > connection.config.rules.gap_s ? " · stale" : ""}`}
            </span>
            <span>
              {Number(stats.analyzed_fps ?? 0).toFixed(1)} analyzed fps
            </span>
            <span>
              {Number(stats.inference_ms ?? 0).toFixed(0)} ms inference
            </span>
            <span>{stats.dropped_frames ?? 0} dropped</span>
          </div>
        </section>
        <section className="panel map-panel">
          <div className="panel-heading">
            <h2>Floor plan</h2>
            <span className="subtle-text">{unavailable ?? "Live state"}</span>
          </div>
          {snapshot ? (
            <FloorMap
              tables={tables}
              states={displayStates}
              selected={table.id}
              onSelect={setSelected}
              unavailable={unavailable}
              floorPlan={
                floorPlan
                  ? {
                      url: assetPath(source.id, floorPlan.file),
                      width: floorPlan.width,
                      height: floorPlan.height,
                    }
                  : undefined
              }
            />
          ) : (
            <p className="live-wait">Waiting for session state…</p>
          )}
        </section>
      </div>
      {state && (
        <section className="panel live-detail" data-testid="table-detail">
          <div className="panel-heading">
            <label className="inline-table-name">
              Table name
              <input
                data-testid="live-table-label"
                disabled={!connected || stopPending}
                value={name}
                onChange={(event) => setName(event.target.value)}
                onBlur={rename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") rename();
                }}
              />
            </label>
            <span
              data-testid="selected-status"
              className={`status-pill ${displayStates[table.id].status}`}
            >
              {state.monitoring_enabled === false
                ? "Disabled"
                : state.manual_override
                  ? `${COLOURS[state.status]} · Manual override`
                  : (unavailable ?? STATE_LABELS[state.status])}
            </span>
          </div>
          <ServiceControls
            state={state}
            disabled={!connected || stopPending}
            unavailable={!!unavailable}
            onAction={staff}
            onMonitoring={(enabled) =>
              send({ type: "monitoring", table_id: table.id, enabled })
            }
          />
          {unavailable && (
            <p className="live-preview-note">
              Last received people and surface evidence is historical. Automatic
              readiness is unavailable until fresh analyzed frames return.
            </p>
          )}
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
              {state.last_assessment && (
                <small>
                  Capture {state.last_assessment.t.toFixed(2)} s · result
                  available {state.last_assessment.available_t.toFixed(2)} s
                </small>
              )}
            </div>
          </div>
          <ObjectEvidence
            table={table}
            assessment={state.last_assessment}
            image={
              (state.last_assessment as { crop_base64?: string } | null)
                ?.crop_base64
            }
          />
          <div className="comparison">
            <figure>
              <div className="figure-title">
                {table.reference?.source_kind === "uploaded_image"
                  ? "Uploaded clean photo"
                  : "Original reference"}
                {table.reference
                  ? table.reference.confirmed_clean
                    ? " · approved"
                    : " · unconfirmed"
                  : ""}
              </div>
              <div className="crop-frame">
                {table.reference ? (
                  <img
                    src={assetPath(source.id, table.reference.file)}
                    alt={`${table.label} ${table.reference.confirmed_clean ? "approved" : "unconfirmed"} setup reference`}
                    title={`${table.reference.source_kind === "uploaded_image" ? "Uploaded clean photo · framing confirmed" : `Setup source frame ${table.reference.source_t.toFixed(2)} s`}${table.reference.reviewed_by ? ` · reviewed by ${table.reference.reviewed_by}` : ""}`}
                  />
                ) : (
                  <div className="image-placeholder">
                    No approved reference supplied
                  </div>
                )}
              </div>
            </figure>
            <div className="comparison-arrow">→</div>
            <figure>
              <div className="figure-title">
                Latest analyzed tabletop · {frame?.captured_t.toFixed(2) ?? "—"}{" "}
                s
              </div>
              <div className="crop-frame">
                <canvas
                  ref={canvas}
                  data-testid="current-crop"
                  aria-label={`${table.label} latest analyzed tabletop`}
                />
              </div>
            </figure>
          </div>
          <div className="table-action-row">
            <p>
              Colour overrides and tabletop confirmations remain separate from
              observed people.
            </p>
            <div className="staff-controls automatic-controls">
              <button
                className="button secondary compact"
                data-testid="needs-cleaning"
                disabled={
                  !connected ||
                  stopPending ||
                  state.monitoring_enabled === false
                }
                onClick={() => staff("needs_cleaning")}
              >
                Needs cleaning
              </button>
              <button
                className="button confirm compact"
                data-testid="confirm-cleaned"
                disabled={
                  !!unavailable || stopPending || !state.can_confirm_cleaned
                }
                onClick={() => staff("confirm_cleaned")}
              >
                Confirm cleaned
              </button>
              <button
                className="button secondary compact"
                data-testid="force-cleaned"
                disabled={
                  !!unavailable || stopPending || !state.can_force_cleaned
                }
                onClick={() => staff("force_cleaned")}
              >
                Force clean
              </button>
            </div>
          </div>
        </section>
      )}
      <section className="panel live-activity">
        <div className="panel-heading">
          <h2>Recent activity</h2>
        </div>
        <ol className="event-log" data-testid="event-log">
          {snapshot?.events
            .slice(-5)
            .reverse()
            .map((event, index) => (
              <li key={`${event.event_id}-${event.t}-${index}`}>
                <time>{event.t.toFixed(2)} s</time>
                <div>
                  <strong>
                    {tables.find((item) => item.id === event.table_id)?.label ??
                      event.table_id}
                  </strong>
                  <p>{event.reason}</p>
                </div>
              </li>
            ))}
        </ol>
      </section>
    </section>
  );
}
