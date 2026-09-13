import { missingSetup } from "./setup-guidance";
import { BrandLogo } from "./BrandLogo";
import { useEffect, useRef, useState } from "react";
import type { SourceInfo } from "../../shared/live-contracts";
import { api, jsonBody } from "./api";
import { CalibrationEditor } from "./CalibrationEditor";
import { LiveDashboard, type LiveConnection } from "./LiveDashboard";

type Health = {
  available: boolean;
  models: {
    detector: { available: boolean; reason?: string };
    surface: { available: boolean; reason?: string };
  };
  limits: { upload_bytes: number; duration_s: number; frame_bytes: number };
};
export function InputWorkspace({
  onClose,
  onBundle,
  onSourceUpdate,
  initialSetup,
  initialSection,
}: {
  initialSetup?: string;
  initialSection?: "references";
  onClose: (source?: SourceInfo) => void;
  onBundle: (source: SourceInfo) => Promise<void>;
  onSourceUpdate: (source: SourceInfo) => void;
}) {
  const [health, setHealth] = useState<Health | null>(null),
    [sources, setSources] = useState<SourceInfo[]>([]),
    [source, setSource] = useState<SourceInfo | null>(null),
    [editor, setEditor] = useState(false);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [uploadProgress, setUploadProgress] = useState<number | null>(null),
    [detectionOnly, setDetectionOnly] = useState(true),
    [cameraReviewed, setCameraReviewed] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [device, setDevice] = useState(""),
    [stream, setStream] = useState<MediaStream | null>(null),
    [connection, setConnection] = useState<LiveConnection | null>(null),
    [previewReady, setPreviewReady] = useState(false);
  const preview = useRef<HTMLVideoElement>(null),
    activeStream = useRef<MediaStream | null>(null),
    upload = useRef<XMLHttpRequest | null>(null);
  const mounted = useRef(false);
  const [guided, setGuided] = useState(initialSetup === "new");
  const [manualSetup, setManualSetup] = useState(false);
  const [setupDirty, setSetupDirty] = useState(false);
  useEffect(() => {
    if (!initialSetup || initialSetup === "new") return;
    let alive = true;
    setBusy(true);
    void api<SourceInfo>(`/sources/${encodeURIComponent(initialSetup)}`)
      .then((value) => {
        if (!alive) return;
        setSource(value);
        setGuided(value.setup_mode === "guided_v1");
        if (value.kind === "camera" && value.device_key)
          setDevice(value.device_key);
        setEditor(
          value.status === "needs_setup" ||
            (initialSection === "references" && value.status === "completed"),
        );
      })
      .catch((err) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [initialSetup, initialSection]);
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    void api<Health>("/health")
      .then((value) => {
        if (alive) {
          setHealth(value);
          if (value.models.surface.available) setDetectionOnly(false);
        }
      })
      .catch((err) => {
        if (alive)
          setError(
            `TurnTable service unavailable. ${err.message} Check the server connection, then reload to try again.`,
          );
      });
    const refresh = () => {
      void Promise.allSettled([
        api<SourceInfo[]>("/jobs"),
        api<SourceInfo[]>("/cameras"),
      ]).then((results) => {
        if (!alive) return;
        const available = results.flatMap((result) =>
          result.status === "fulfilled" ? result.value : [],
        );
        if (results.some((result) => result.status === "fulfilled"))
          setSources([
            ...new Map(available.map((item) => [item.id, item])).values(),
          ]);
      });
    };
    refresh();
    const interval = window.setInterval(refresh, 1500);
    return () => {
      alive = false;
      mounted.current = false;
      clearInterval(interval);
      upload.current?.abort();
      activeStream.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);
  useEffect(() => {
    if (
      !source ||
      !["preparing", "analyzing", "uploading"].includes(source.status)
    )
      return;
    let alive = true;
    const poll = window.setInterval(() => {
      void api<SourceInfo>(`/jobs/${source.id}`)
        .then((value) => {
          if (!alive) return;
          setSource(value);
          if (value.status === "needs_setup" && !value.calibration_confirmed)
            setEditor(true);
        })
        .catch((err) => {
          if (alive) setError(err.message);
        });
    }, 700);
    return () => {
      alive = false;
      clearInterval(poll);
    };
  }, [source?.id, source?.status]);
  useEffect(() => {
    if (preview.current && stream && !connection) {
      setPreviewReady(false);
      preview.current.srcObject = stream;
      void preview.current
        .play()
        .catch(() => setError("Camera preview could not start."));
    }
  }, [stream, connection, editor]);
  async function rawUpload(file?: File) {
    if (!file) return;
    if (file.size > (health?.limits.upload_bytes ?? 1_000_000_000)) {
      setError("This video exceeds the upload size limit.");
      return;
    }
    setBusy(true);
    setError("");
    setUploadProgress(0);
    setEditor(false);
    try {
      const value = await new Promise<SourceInfo>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        upload.current = xhr;
        xhr.open("POST", "/api/videos");
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable)
            setUploadProgress(event.loaded / event.total);
        };
        xhr.onload = () => {
          let result: SourceInfo & { detail?: string };
          try {
            result = JSON.parse(xhr.responseText);
          } catch {
            reject(new Error("The service returned an invalid upload reply."));
            return;
          }
          if (xhr.status >= 200 && xhr.status < 300) resolve(result);
          else
            reject(
              new Error(result.detail ?? `Upload failed (${xhr.status}).`),
            );
        };
        xhr.onerror = () => reject(new Error("Upload connection failed."));
        xhr.onabort = () => reject(new Error("Upload cancelled."));
        const body = new FormData();
        body.append("file", file);
        if (manualSetup) body.append("manual_setup", "true");
        xhr.send(body);
      });
      setSource(value);
      if (value.status === "needs_setup") setEditor(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setUploadProgress(null);
      upload.current = null;
    }
  }
  async function openSource(id: string) {
    setBusy(true);
    setError("");
    setCameraReviewed(false);
    activeStream.current?.getTracks().forEach((track) => track.stop());
    activeStream.current = null;
    setStream(null);
    setPreviewReady(false);
    try {
      const value = await api<SourceInfo>(`/sources/${id}`);
      setSource(value);
      setGuided(value.setup_mode === "guided_v1");
      if (value.kind === "camera" && value.device_key)
        setDevice(value.device_key);
      setEditor(value.status === "needs_setup" && !value.calibration_confirmed);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }
  async function cameraPreview() {
    setBusy(true);
    setError("");
    setPreviewReady(false);
    setCameraReviewed(false);
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error(
          "Camera capture requires localhost or a secure browser context.",
        );
      activeStream.current?.getTracks().forEach((track) => track.stop());
      const media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          ...(device && device !== "default"
            ? { deviceId: { exact: device } }
            : {}),
        },
      });
      if (!mounted.current) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      activeStream.current = media;
      setStream(media);
      const found = await navigator.mediaDevices.enumerateDevices();
      if (!mounted.current) return;
      setDevices(found.filter((item) => item.kind === "videoinput"));
      setDevice(media.getVideoTracks()[0]?.getSettings().deviceId ?? device);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function captureSetup() {
    if (!preview.current || preview.current.readyState < 2) {
      setError("Wait for a visible camera preview first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const video = preview.current,
        scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight),
        canvas = document.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas
        .getContext("2d")!
        .drawImage(video, 0, 0, canvas.width, canvas.height);
      const value = await api<SourceInfo>("/cameras", {
        method: "POST",
        body: jsonBody({
          device_key: device || "default",
          label:
            devices.find((item) => item.deviceId === device)?.label ||
            "Restaurant camera",
          image_base64: canvas.toDataURL("image/jpeg", 0.9).split(",")[1],
        }),
      });
      setSource(value);
      setEditor(value.status === "needs_setup");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function analyze() {
    if (!source) return;
    const missing = missingSetup(source, source.tables, detectionOnly);
    if (source.setup_mode === "guided_v1" && missing.length) {
      setError("Complete the missing setup details below before analysis.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      setSource(
        await api<SourceInfo>(`/sources/${source.id}/analyze`, {
          method: "POST",
          body: jsonBody({ detection_only: detectionOnly }),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function startLive() {
    if (!source || !stream || !stream.active) {
      setError("Start this camera’s preview before monitoring.");
      return;
    }
    if (
      source.setup_mode === "guided_v1" &&
      missingSetup(source, source.tables, detectionOnly).length
    ) {
      setError("Complete the missing setup details below before monitoring.");
      return;
    }
    if (!cameraReviewed) {
      setError(
        "Review this camera view against the saved table setup before monitoring.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      setConnection(
        await api<LiveConnection>("/live", {
          method: "POST",
          body: jsonBody({
            source_id: source.id,
            detection_only: detectionOnly,
          }),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (upload.current) {
      upload.current.abort();
      return;
    }
    if (!source) return;
    setBusy(true);
    try {
      const value = await api<SourceInfo>(`/jobs/${source.id}/cancel`, {
        method: "POST",
      });
      setSource(
        value?.id
          ? value
          : { ...source, status: "cancelled", phase: "cancelled" },
      );
      setEditor(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }
  function saved(value: SourceInfo) {
    setSource(value);
    setEditor(false);
    setCameraReviewed(value.kind === "camera");
    onSourceUpdate(value);
    setSources((items) => [
      value,
      ...items.filter((item) => item.id !== value.id),
    ]);
  }
  async function openCompleted() {
    if (!source) return;
    setBusy(true);
    setError("");
    try {
      await onBundle(source);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }
  return (
    <div className="input-workspace">
      <header className="input-topbar">
        <div className="input-brand">
          <BrandLogo />
          <span>Sources & setup</span>
        </div>
        <button
          className="button secondary"
          onClick={() => {
            if (
              !setupDirty ||
              window.confirm(
                "Your latest setup edits are not saved. They can be recovered in this browser. Leave setup?",
              )
            )
              onClose(source ?? undefined);
          }}
        >
          Back to dashboard
        </button>
      </header>
      <main>
        {connection && source && stream ? (
          <LiveDashboard
            key={connection.session_id}
            source={source}
            connection={connection}
            stream={stream}
            onStopped={() => {
              setConnection(null);
              setStream(null);
              setCameraReviewed(false);
              setPreviewReady(false);
              activeStream.current = null;
            }}
          />
        ) : editor && source ? (
          <CalibrationEditor
            key={source.id}
            source={source}
            initialSection={
              source.id === initialSetup ? initialSection : undefined
            }
            onDirtyChange={setSetupDirty}
            onSaved={saved}
            onCancel={() => setEditor(false)}
          />
        ) : (
          <>
            <div className="setup-heading">
              <div>
                <div className="eyebrow">
                  {guided
                    ? "STEP 1 OF 4 · YOUR RECORDING OR CAMERA"
                    : "YOUR VIDEO, YOUR FLOOR"}
                </div>
                <h1>
                  {guided
                    ? "Start with your restaurant."
                    : "Add a video or camera."}
                </h1>
                <p>
                  Choose a recording or camera. Next, provide a clean reference
                  and floor plan, mark the tables, and approve their expected
                  objects.
                </p>
              </div>
            </div>
            {error && (
              <p className="input-error" role="alert">
                {error}
              </p>
            )}
            {health && !health.models.detector.available && (
              <p
                className="input-error"
                role="status"
                data-testid="model-availability"
              >
                Automatic analysis is unavailable:{" "}
                {health.models.detector.reason ??
                  "CPU models are not installed"}
                . You can choose “Draw tables manually” and prepare your setup.
              </p>
            )}
            <div className="source-actions">
              <section className="panel source-card">
                <h2>Upload a recording</h2>
                <p>
                  A fixed camera works best. Uploads are processed on the
                  TurnTable server.
                </p>
                <label className="setup-check">
                  <input
                    data-testid="manual-setup-upload"
                    type="checkbox"
                    checked={manualSetup}
                    disabled={busy}
                    onChange={(event) => setManualSetup(event.target.checked)}
                  />
                  Draw tables manually · skip table detection
                </label>
                <label className="button dark upload-label">
                  Choose video
                  <input
                    data-testid="source-upload"
                    type="file"
                    accept="video/*"
                    disabled={busy || !health?.available}
                    onChange={(event) => {
                      void rawUpload(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                  />
                </label>
                <small>
                  Up to {Math.round((health?.limits.upload_bytes ?? 1e9) / 1e6)}{" "}
                  MB · up to{" "}
                  {Math.round((health?.limits.duration_s ?? 600) / 60)} minutes
                </small>
              </section>
              <section className="panel source-card">
                <h2>Use a live camera</h2>
                <p>
                  Start a preview, then capture a frame to calibrate the tables.
                  Monitoring sends camera frames to the TurnTable server.
                </p>
                {devices.length > 0 && (
                  <label>
                    Camera
                    <select
                      data-testid="camera-device"
                      value={device}
                      onChange={(event) => setDevice(event.target.value)}
                    >
                      {devices.map((item) => (
                        <option key={item.deviceId} value={item.deviceId}>
                          {item.label || "Camera"}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="source-card-buttons">
                  <button
                    className="button secondary"
                    data-testid="camera-preview-start"
                    disabled={busy}
                    onClick={() => void cameraPreview()}
                  >
                    {stream?.active
                      ? "Restart preview"
                      : "Start camera preview"}
                  </button>
                  {stream?.active && (
                    <button
                      className="button dark"
                      data-testid="camera-setup-save"
                      disabled={busy || !previewReady}
                      onClick={() => void captureSetup()}
                    >
                      Capture setup frame
                    </button>
                  )}
                </div>
                {stream && (
                  <video
                    ref={preview}
                    data-testid="camera-preview"
                    onLoadedData={() => setPreviewReady(true)}
                    autoPlay
                    muted
                    playsInline
                    className="camera-preview"
                  />
                )}
              </section>
            </div>
            {guided && !source && (
              <p className="setup-next-prompt" data-testid="fresh-setup-prompt">
                Choose a video or start your camera. Your tables, reference
                image, and layout will be reviewed in the following steps.
              </p>
            )}
            {(source || uploadProgress !== null) && (
              <section className="panel source-status">
                <div className="source-status-heading">
                  <div>
                    <h2>{source?.label ?? "Uploading video"}</h2>
                    <p>
                      {uploadProgress !== null
                        ? "Uploading video to the TurnTable server"
                        : source?.phase.replaceAll("_", " ")}
                    </p>
                  </div>
                  <span className="subtle-chip">
                    {source?.status ?? "uploading"}
                  </span>
                </div>
                <progress
                  data-testid="job-progress"
                  max="1"
                  value={uploadProgress ?? source?.progress ?? 0}
                />
                {source?.error && (
                  <p className="input-error" role="alert">
                    {source.error}
                  </p>
                )}
                <div className="processing-choice">
                  <label className="setup-check">
                    <input
                      data-testid="detection-only"
                      type="checkbox"
                      checked={detectionOnly}
                      onChange={(event) =>
                        setDetectionOnly(event.target.checked)
                      }
                    />
                    Detection only
                  </label>
                  <p>
                    {detectionOnly
                      ? "Tracks people. Automatic clean-table verification is off."
                      : health?.models.surface.available
                        ? "Tracks people and compares tabletop objects and appearance with approved setups."
                        : `Full surface analysis unavailable: ${health?.models.surface.reason ?? "CPU detector unavailable"}. Choose detection only to continue.`}
                  </p>
                </div>
                {source?.setup_mode === "guided_v1" &&
                  missingSetup(source, source.tables, detectionOnly).length >
                    0 && (
                    <div
                      className="setup-missing"
                      data-testid="setup-missing-details"
                    >
                      <strong>
                        Still needed before{" "}
                        {source.kind === "video" ? "analysis" : "monitoring"}
                      </strong>
                      <ul>
                        {missingSetup(source, source.tables, detectionOnly).map(
                          (item, index) => (
                            <li key={index}>{item}</li>
                          ),
                        )}
                      </ul>
                      <button
                        className="button secondary"
                        onClick={() => setEditor(true)}
                      >
                        Continue setup
                      </button>
                    </div>
                  )}
                {!detectionOnly &&
                  source?.calibration_confirmed &&
                  source.tables.some(
                    (table) =>
                      table.monitoring_enabled !== false &&
                      !table.object_baseline?.approved,
                  ) && (
                    <p
                      className="baseline-needed"
                      data-testid="missing-baseline-notice"
                    >
                      Some tables have no approved object inventory. Open table
                      setup to review expected objects; those tables will remain
                      Verifying.
                    </p>
                  )}
                {source?.kind === "camera" && source.calibration_confirmed && (
                  <label className="setup-check camera-reuse-review">
                    <input
                      data-testid="camera-reuse-confirmed"
                      type="checkbox"
                      checked={cameraReviewed}
                      disabled={!previewReady || busy}
                      onChange={(event) =>
                        setCameraReviewed(event.target.checked)
                      }
                    />
                    I checked that this camera view and furniture still match
                    the saved table setup.
                  </label>
                )}
                {source?.kind === "video" &&
                  (source.status === "cancelled" ||
                    (source.status === "failed" && !source.media_url)) && (
                    <p className="source-reupload-note">
                      This source has no recording available for analysis.
                      Upload the video again to continue.
                    </p>
                  )}
                <div className="source-status-buttons">
                  {source &&
                    !["preparing", "analyzing", "cancelled", "failed"].includes(
                      source.status,
                    ) && (
                      <button
                        className="button secondary"
                        onClick={() => setEditor(true)}
                      >
                        Edit table setup
                      </button>
                    )}
                  {source?.kind === "video" &&
                    source.calibration_confirmed &&
                    source.media_url &&
                    ["needs_setup", "completed", "failed"].includes(
                      source.status,
                    ) && (
                      <button
                        data-testid="analyze-source"
                        className="button dark"
                        disabled={
                          busy ||
                          (!detectionOnly &&
                            !health?.models.surface.available) ||
                          !health?.models.detector.available
                        }
                        onClick={() => void analyze()}
                      >
                        Analyze recording
                      </button>
                    )}
                  {source?.kind === "camera" &&
                    source.calibration_confirmed && (
                      <button
                        className="button dark"
                        data-testid="live-start"
                        disabled={
                          busy ||
                          !stream?.active ||
                          !cameraReviewed ||
                          !previewReady ||
                          (!detectionOnly &&
                            !health?.models.surface.available) ||
                          !health?.models.detector.available
                        }
                        onClick={() => void startLive()}
                      >
                        Start live monitoring
                      </button>
                    )}
                  {source?.status === "completed" && source.manifest_url && (
                    <button
                      data-testid="open-completed"
                      className="button dark"
                      disabled={busy}
                      onClick={() => void openCompleted()}
                    >
                      Open analyzed video
                    </button>
                  )}
                  {(uploadProgress !== null ||
                    (source &&
                      ["preparing", "analyzing"].includes(source.status))) && (
                    <button
                      data-testid="job-cancel"
                      className="button secondary"
                      onClick={() => void cancel()}
                    >
                      Cancel job
                    </button>
                  )}
                </div>
              </section>
            )}
            <section className="panel saved-source-panel">
              <div className="panel-heading">
                <h2>Saved sources & jobs</h2>
                <span className="subtle-text">This computer</span>
              </div>
              <div data-testid="saved-sources" className="saved-source-list">
                {sources.map((item) => (
                  <button
                    key={item.id}
                    data-testid={`source-open-${item.id}`}
                    onClick={() => void openSource(item.id)}
                  >
                    <span>
                      <strong>{item.label}</strong>
                      <small>
                        {item.kind === "camera" ? "Camera" : "Video"} ·{" "}
                        {item.status}
                      </small>
                    </span>
                    <span>Open →</span>
                  </button>
                ))}
                {sources.length === 0 && (
                  <p>
                    Your uploaded videos and saved camera setups will appear
                    here.
                  </p>
                )}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
