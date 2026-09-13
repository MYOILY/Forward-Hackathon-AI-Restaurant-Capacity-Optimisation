import { useEffect, useRef, useState } from "react";
import type { CalibrationTable } from "../../shared/live-contracts";
import {
  contained,
  directions,
  moveMap,
  resizeMap,
  type Handle,
  type Point,
} from "./floor-plan-geometry";
import "./floor-plan-editor.css";
type Map = CalibrationTable["map"];
type Props = {
  tables: CalibrationTable[];
  selected: string;
  onSelect: (id: string) => void;
  onChange: (id: string, map: Map) => void;
  floorPlan?: { url: string; width: number; height: number };
  cameraImage?: string;
};
export function FloorPlanEditor({
  tables,
  selected,
  onSelect,
  onChange,
  floorPlan,
  cameraImage,
}: Props) {
  const size = {
    width: floorPlan?.width ?? 1000,
    height: floorPlan?.height ?? 650,
  };
  const table = tables.find((t) => t.id === selected),
    map = table?.map;
  const svg = useRef<SVGSVGElement>(null),
    hist = useRef<Record<string, { past: Map[]; future: Map[] }>>({});
  const drag = useRef<{
    id: string;
    start: Point;
    map: Map;
    kind: "move" | "rotate" | Handle;
    latest: Map;
  } | null>(null);
  const [displayScale, setDisplayScale] = useState(1);
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const matrix = el.getScreenCTM();
      if (matrix) setDisplayScale(1 / Math.hypot(matrix.a, matrix.b));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [size.width, size.height]);
  const [lock, setLock] = useState(false),
    [error, setError] = useState(""),
    [, render] = useState(0);
  const [fields, setFields] = useState({ width: "", height: "", rotation: "" });
  useEffect(() => {
    if (map)
      setFields({
        width: String(Math.round(map.w * size.width * 100) / 100),
        height: String(Math.round(map.h * size.height * 100) / 100),
        rotation: String(Math.round((map.rotation ?? 0) * 100) / 100),
      });
  }, [map, size.width, size.height]);
  useEffect(() => setError(""), [selected]);
  useEffect(() => {
    hist.current = {};
    render((n) => n + 1);
  }, [floorPlan?.url, size.width, size.height]);
  const history = () =>
    hist.current[selected] ??
    (hist.current[selected] = { past: [], future: [] });
  function commit(next: Map) {
    if (!map || JSON.stringify(map) === JSON.stringify(next)) return;
    history().past.push({ ...map });
    history().future = [];
    onChange(selected, next);
    setError("");
    render((n) => n + 1);
  }
  function undo(redo = false) {
    if (!map) return;
    const h = history(),
      from = redo ? h.future : h.past,
      to = redo ? h.past : h.future,
      next = from.pop();
    if (next) {
      to.push({ ...map });
      onChange(selected, next);
      setError("");
      render((n) => n + 1);
    }
  }
  function point(event: React.PointerEvent): Point {
    const p = new DOMPoint(event.clientX, event.clientY),
      matrix = svg.current?.getScreenCTM();
    return matrix ? p.matrixTransform(matrix.inverse()) : { x: 0, y: 0 };
  }
  function start(
    event: React.PointerEvent,
    id: string,
    kind: "move" | "rotate" | Handle,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const current = tables.find((t) => t.id === id)!.map;
    onSelect(id);
    drag.current = {
      id,
      start: point(event),
      map: { ...current },
      latest: { ...current },
      kind,
    };
    svg.current?.setPointerCapture(event.pointerId);
  }
  function finish() {
    const d = drag.current;
    if (d && JSON.stringify(d.latest) !== JSON.stringify(d.map)) {
      const h =
        hist.current[d.id] ?? (hist.current[d.id] = { past: [], future: [] });
      h.past.push(d.map);
      h.future = [];
      render((n) => n + 1);
    }
    drag.current = null;
  }
  function numeric(key: "width" | "height" | "rotation", value: string) {
    setFields((f) => ({ ...f, [key]: value }));
    if (!map) return;
    const n = Number(value);
    if (value.trim() === "" || !Number.isFinite(n)) {
      setError("Enter a valid number. The last valid shape is unchanged.");
      return;
    }
    let next = { ...map };
    if (key === "rotation") next.rotation = ((n % 360) + 360) % 360;
    else {
      next[key === "width" ? "w" : "h"] =
        n / (key === "width" ? size.width : size.height);
      if (lock) {
        if (key === "width") next.h = (map.h * next.w) / map.w;
        else next.w = (map.w * next.h) / map.h;
      }
    }
    if (!contained(next, size)) {
      setError(
        "Use a positive size of at least 1 pixel and keep the entire rotated shape inside the plan.",
      );
      return;
    }
    setError("");
    if (key === "rotation")
      setFields((f) => ({ ...f, rotation: String(next.rotation) }));
    commit(next);
  }
  const h = hist.current[selected];
  const scale = displayScale;
  const radius = 6 * scale;
  return (
    <section className="floor-editor" aria-label="Floor-plan position editor">
      <div className="floor-editor-main">
        <div className="floor-editor-toolbar">
          <strong>{table?.label ?? "Select a table"}</strong>
          <span>
            {floorPlan ? "Uploaded floor plan" : "Schematic layout"} · sizes in
            image pixels
          </span>
          <button
            type="button"
            onClick={() => undo()}
            disabled={!h?.past.length}
          >
            Undo
          </button>
          <button
            type="button"
            onClick={() => undo(true)}
            disabled={!h?.future.length}
          >
            Redo
          </button>
        </div>
        <svg
          ref={svg}
          className="floor-editor-canvas"
          data-testid="floor-plan-editor"
          viewBox={`0 0 ${size.width} ${size.height}`}
          style={{ aspectRatio: `${size.width}/${size.height}` }}
          tabIndex={0}
          role="group"
          aria-label="Editable floor plan. Select a table, drag to move, or use arrow keys. Shift moves ten pixels."
          onKeyDown={(event) => {
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key.toLowerCase() === "z"
            ) {
              event.preventDefault();
              undo(event.shiftKey);
              return;
            }
            if (!map) return;
            const moves: Record<string, Point> = {
              ArrowLeft: { x: -1, y: 0 },
              ArrowRight: { x: 1, y: 0 },
              ArrowUp: { x: 0, y: -1 },
              ArrowDown: { x: 0, y: 1 },
            };
            const delta = moves[event.key];
            if (delta) {
              event.preventDefault();
              const step = event.shiftKey ? 10 : 1;
              commit(
                moveMap(
                  map,
                  { x: delta.x * step, y: delta.y * step },
                  size,
                ) as Map,
              );
            }
          }}
          onPointerMove={(event) => {
            const d = drag.current;
            if (!d) return;
            const p = point(event),
              delta = { x: p.x - d.start.x, y: p.y - d.start.y };
            let next: Map;
            if (d.kind === "move") next = moveMap(d.map, delta, size) as Map;
            else if (d.kind === "rotate") {
              const cx = d.map.x * size.width,
                cy = d.map.y * size.height;
              const change =
                ((Math.atan2(p.y - cy, p.x - cx) -
                  Math.atan2(d.start.y - cy, d.start.x - cx)) *
                  180) /
                Math.PI;
              next = {
                ...d.map,
                rotation:
                  (((Math.round(((d.map.rotation ?? 0) + change) * 10) / 10) %
                    360) +
                    360) %
                  360,
              };
              if (!contained(next, size)) {
                setError(
                  "This rotation would extend outside the plan. Move the table inward or reduce its size.",
                );
                return;
              }
            } else next = resizeMap(d.map, d.kind, delta, size, lock) as Map;
            d.latest = next;
            onChange(d.id, next);
            setError("");
          }}
          onPointerUp={finish}
          onPointerCancel={finish}
          onLostPointerCapture={finish}
        >
          <rect width={size.width} height={size.height} fill="var(--canvas)" />
          {floorPlan && (
            <image
              data-testid="floor-plan-background"
              href={floorPlan.url}
              width={size.width}
              height={size.height}
            />
          )}
          {tables.map((t) => {
            const m = t.map,
              w = m.w * size.width,
              ht = m.h * size.height,
              active = t.id === selected;
            return (
              <g
                key={t.id}
                transform={`translate(${m.x * size.width} ${m.y * size.height}) rotate(${m.rotation ?? 0})`}
              >
                <g
                  role="button"
                  tabIndex={0}
                  aria-label={`Select ${t.label}`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(t.id);
                      svg.current?.focus();
                    }
                  }}
                  onPointerDown={(e) => start(e, t.id, "move")}
                  className="floor-editor-shape"
                >
                  {m.shape === "round" ? (
                    <ellipse
                      rx={w / 2}
                      ry={ht / 2}
                      fill={active ? "var(--selection-fill-strong)" : "#ffffffb8"}
                      stroke="var(--action)"
                      strokeWidth={2 * scale}
                    />
                  ) : (
                    <rect
                      x={-w / 2}
                      y={-ht / 2}
                      width={w}
                      height={ht}
                      fill={active ? "var(--selection-fill-strong)" : "#ffffffb8"}
                      stroke="var(--action)"
                      strokeWidth={2 * scale}
                    />
                  )}
                  <text
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={Math.min(
                      14 * scale,
                      Math.max(
                        8 * scale,
                        (w / Math.max(4, t.label.length)) * 1.5,
                      ),
                    )}
                    fill="var(--text)"
                    style={{ pointerEvents: "none" }}
                  >
                    {t.label}
                  </text>
                </g>
                {active && (
                  <>
                    <rect
                      x={-w / 2}
                      y={-ht / 2}
                      width={w}
                      height={ht}
                      fill="none"
                      stroke="var(--action)"
                      strokeWidth={scale}
                      strokeDasharray={`${4 * scale} ${3 * scale}`}
                      pointerEvents="none"
                    />
                    <path
                      d={`M 0 ${-ht / 2} V ${-ht / 2 - 30 * scale}`}
                      stroke="var(--action)"
                      strokeWidth={scale}
                    />
                    {(Object.keys(directions) as Handle[]).map((handle) => {
                      const [sx, sy] = directions[handle];
                      return (
                        <circle
                          key={handle}
                          data-testid={`resize-${handle}`}
                          cx={(sx * w) / 2}
                          cy={(sy * ht) / 2}
                          r={radius}
                          fill="white"
                          stroke="var(--action)"
                          strokeWidth={2 * scale}
                          style={{ cursor: `${handle}-resize` }}
                          onPointerDown={(e) => start(e, t.id, handle)}
                        >
                          <title>{`Resize ${handle}`}</title>
                        </circle>
                      );
                    })}
                    <circle
                      data-testid="rotate-handle"
                      cx={0}
                      cy={-ht / 2 - 30 * scale}
                      r={radius + scale}
                      fill="var(--action)"
                      stroke="white"
                      strokeWidth={2 * scale}
                      style={{ cursor: "grab" }}
                      onPointerDown={(e) => start(e, t.id, "rotate")}
                    >
                      <title>Rotate table</title>
                    </circle>
                  </>
                )}
              </g>
            );
          })}
        </svg>
        <p className="floor-editor-hint">
          Drag to move. Use the eight white handles to resize and the teal
          handle to rotate. Arrow keys move 1 pixel; Shift + arrow moves 10.
        </p>
      </div>
      {map && (
        <aside className="floor-editor-properties">
          <h3>{table?.label}</h3>
          {cameraImage && (
            <img
              src={cameraImage}
              alt={`Camera reference for matching ${table?.label}`}
              className="floor-editor-reference"
            />
          )}
          <p>Match this table to its position on the plan.</p>
          <label>
            Shape
            <select
              value={map.shape ?? "rect"}
              onChange={(e) =>
                commit({ ...map, shape: e.target.value as "rect" | "round" })
              }
            >
              <option value="rect">Rectangle</option>
              <option value="round">Round / oval</option>
            </select>
          </label>
          {(["width", "height", "rotation"] as const).map((key) => (
            <label key={key}>
              {key === "width"
                ? "Width (px)"
                : key === "height"
                  ? "Height (px)"
                  : "Rotation (°)"}
              <input
                type="number"
                step="any"
                aria-invalid={!!error}
                aria-describedby="floor-editor-error"
                value={fields[key]}
                onChange={(e) => numeric(key, e.target.value)}
              />
            </label>
          ))}
          <label className="floor-editor-lock">
            <input
              type="checkbox"
              checked={lock}
              onChange={(e) => setLock(e.target.checked)}
            />
            Lock aspect ratio
          </label>
          <p
            id="floor-editor-error"
            role="status"
            className="floor-editor-error"
          >
            {error}
          </p>
          <small>
            Dimensions use the original plan image: {size.width} × {size.height}{" "}
            pixels.
          </small>
        </aside>
      )}
    </section>
  );
}
export default FloorPlanEditor;
