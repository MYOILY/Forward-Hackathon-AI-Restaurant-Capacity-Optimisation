import { useEffect, useRef, useState } from "react";
import type { SourceInfo } from "../../shared/live-contracts";
import { BrandLogo } from "./BrandLogo";
import { CalibrationEditor } from "./CalibrationEditor";
import { BrowserRecording, getStatelessRecording, listStatelessRecordings, type StatelessRecordingResult } from "./stateless/recording";
import { RecordingProcessor, type ProcessingProgress } from "./stateless/processing";
import { statelessApiUrl } from "./stateless/config";

export function StatelessInputWorkspace({ onClose, onBundle, onSourceUpdate, initialSetup, initialSection }: {
  onClose(source?: SourceInfo): void;
  onBundle(result: StatelessRecordingResult): Promise<void>;
  onSourceUpdate?(source: SourceInfo): void;
  initialSetup?: string;
  initialSection?: "references";
}) {
  const [recording, setRecording] = useState(() => initialSetup ? getStatelessRecording(initialSetup) : undefined);
  const [source, setSource] = useState<SourceInfo | undefined>(() => recording?.source);
  const [editor, setEditor] = useState(!!recording);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [fileProgress, setFileProgress] = useState<number | null>(null);
  const [progress, setProgress] = useState<ProcessingProgress | null>(null);
  const [records, setRecords] = useState(listStatelessRecordings);
  const processor = useRef<RecordingProcessor | null>(null), opening = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; opening.current?.abort(); processor.current?.cancel(); }; }, []);
  async function open(file?: File) {
    if (!file || busy) return;
    setBusy(true); setError(""); setFileProgress(-1); setProgress(null);
    const abort = new AbortController(); opening.current = abort;
    try {
      const record = await BrowserRecording.open(file, statelessApiUrl, (value) => { if (mounted.current) setFileProgress(value); }, abort.signal);
      if (!mounted.current) { record.dispose(); return; }
      setRecording(record); setSource(record.source); setRecords(listStatelessRecordings());
    } catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (mounted.current) { setBusy(false); setFileProgress(null); } opening.current = null; }
  }
  async function propose() {
    if (!recording) return;
    setBusy(true); setError("");
    try { setSource(await recording.proposeTables()); setEditor(true); }
    catch (err) { setError(`${err instanceof Error ? err.message : String(err)} You can also draw the tables manually.`); }
    finally { setBusy(false); }
  }
  async function analyze() {
    if (!recording) return;
    setBusy(true); setError("");
    const task = new RecordingProcessor(recording, (value) => { if (mounted.current) setProgress(value); }); processor.current = task;
    try {
      await task.run();
      if (mounted.current) { setSource(recording.source); onSourceUpdate?.(recording.source); await onBundle(recording.result()); }
    } catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (mounted.current) setBusy(false); processor.current = null; }
  }
  if (editor && source && recording) return <CalibrationEditor source={source} adapter={recording.adapter}
    initialSection={initialSection} onCancel={() => {
      setSource(recording.source); onSourceUpdate?.(recording.source); setEditor(false);
      if (!recording.bundle) setProgress(null);
    }}
    onSaved={(value) => { setSource(value); setEditor(false); onSourceUpdate?.(value); setProgress(null); }} />;
  return <div className="input-workspace">
    <header className="input-topbar">
      <div className="input-brand"><BrandLogo /><span>Sources & setup</span></div>
      <button className="button secondary" onClick={() => onClose(source)} disabled={busy}>Back to dashboard</button>
    </header>
    <main style={{ maxWidth: 960 }}>
      <div className="setup-heading">
        <div>
          <div className="eyebrow">YOUR VIDEO, YOUR FLOOR</div>
          <h1>Analyze a video</h1>
          <p>Your original video stays in this browser. Small image batches are sent for analysis. Keep this tab open to retain your setup and results.</p>
        </div>
      </div>
      {error && <div role="alert" className="input-error">{error}</div>}
      <section className="panel source-card">
        <h2>Upload a recording</h2>
        <p>Desktop Chrome or Edge is required. Refreshing or closing this tab ends the session.</p>
        <label className="button dark upload-label">Choose video
          <input aria-label="Choose local video" type="file" accept="video/mp4,.mp4" disabled={busy} onChange={(event) => void open(event.target.files?.[0])} />
        </label>
        <small>MP4 / H.264 · up to 1 GB · up to ten minutes</small>
      </section>
      {fileProgress !== null && <div role="status" className="panel source-card source-status">
        <p>{fileProgress < 0 ? "Connecting to analysis service… The first connection may take a moment." : "Reading video and calculating its identity…"}</p>
        <progress max={1} value={fileProgress < 0 ? undefined : fileProgress} />
        <div className="source-status-buttons"><button className="button secondary" onClick={() => opening.current?.abort()}>Cancel</button></div>
      </div>}
      {source && recording && <section className="panel source-card source-status">
        <h2>{source.label}</h2>
        <video className="camera-preview" src={source.media_url} controls preload="metadata" style={{ maxHeight: 380 }} />
        <p>{source.width} × {source.height} · {Math.round(source.duration_s)} seconds · {source.tables.length} tables</p>
        {!busy && <div className="source-status-buttons">
          {!source.tables.length && <button className="button secondary" onClick={() => void propose()}>Suggest tables</button>}
          <button className="button secondary" onClick={() => setEditor(true)}>{source.tables.length ? "Review setup" : "Set up tables manually"}</button>
          {source.calibration_confirmed && <button className="button dark" onClick={() => void analyze()}>Analyze video</button>}
          {recording.bundle && <button className="button secondary" onClick={() => void onBundle(recording.result())}>Open results</button>}
        </div>}
        {progress && <div role="status" className="source-status">
          <div className="source-status-heading"><p>{progress.paused ? "Analysis paused" : busy ? "Analyzing frames" : "Analysis finished"} · {Math.round(progress.progress * 100)}%</p></div>
          <progress max={1} value={progress.progress} />
          {progress.error && <p role="alert" className="input-error">{progress.error}</p>}
          {busy && <div className="source-status-buttons">
            <button className="button secondary" onClick={() => progress.paused ? processor.current?.resume() : processor.current?.pause()}>{progress.paused ? (progress.error ? "Retry" : "Resume") : "Pause"}</button>
            <button className="button secondary" onClick={() => processor.current?.cancel()}>Cancel analysis</button>
          </div>}
        </div>}
      </section>}
      {records.length > 0 && <section className="panel source-card source-status">
        <h2>In this tab</h2>
        <p>Recordings available in this browser session.</p>
        <div className="source-status-buttons">{records.map((record) => <button className="button secondary" key={record.id} disabled={busy}
          onClick={() => { setRecording(record); setSource(record.source); setProgress(null); setError(""); }}>{record.source.label}</button>)}</div>
      </section>}
    </main>
  </div>;
}
