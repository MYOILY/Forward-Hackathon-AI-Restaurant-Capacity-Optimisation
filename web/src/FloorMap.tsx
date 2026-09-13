import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minus, Plus, Search } from "lucide-react";
import type { Table, TableState } from "../../shared/contracts";
import { COLOURS } from "./ServiceControls";
const colors = {
  ready: ["#188455", "#eaf6ee"],
  occupied: ["#bb830c", "#fff7dc"],
  needs_cleaning: ["#d24a43", "#fff0ed"],
  unknown: ["#7b8389", "#f3f4f5"],
};
export function FloorMap({
  tables,
  states,
  selected,
  onSelect,
  unavailable,
  floorPlan,
}: {
  tables: Table[];
  states: Record<string, Omit<TableState, "last_assessment">>;
  selected: string;
  onSelect: (id: string) => void;
  unavailable?: string;
  floorPlan?: {
    url: string;
    width: number;
    height: number;
  };
}) {
  const worldWidth = 1000,
    worldHeight = floorPlan
      ? (worldWidth * floorPlan.height) / floorPlan.width
      : 650;
  const fit = useMemo(() => {
    if (floorPlan || tables.length === 0)
      return { x: -20, y: -20, w: worldWidth + 40, h: worldHeight + 40 };
    const bounds = tables.map((table) => {
      const angle = ((table.map.rotation ?? 0) * Math.PI) / 180;
      const width = table.map.w * worldWidth,
        height = table.map.h * worldHeight;
      const halfWidth =
        (Math.abs(width * Math.cos(angle)) +
          Math.abs(height * Math.sin(angle))) /
        2;
      const halfHeight =
        (Math.abs(width * Math.sin(angle)) +
          Math.abs(height * Math.cos(angle))) /
        2;
      return {
        x: table.map.x * worldWidth,
        y: table.map.y * worldHeight,
        halfWidth,
        halfHeight,
      };
    });
    const left = Math.min(...bounds.map((b) => b.x - b.halfWidth)) - 55,
      right = Math.max(...bounds.map((b) => b.x + b.halfWidth)) + 55;
    const top = Math.min(...bounds.map((b) => b.y - b.halfHeight)) - 65,
      bottom = Math.max(...bounds.map((b) => b.y + b.halfHeight)) + 65;
    const w = Math.max(480, right - left),
      h = Math.max(330, bottom - top);
    return { x: (left + right - w) / 2, y: (top + bottom - h) / 2, w, h };
  }, [tables, floorPlan?.url, worldHeight]);
  const [view, setView] = useState(fit),
    [query, setQuery] = useState("");
  const [failedPlan, setFailedPlan] = useState<string | null>(null);
  const planIdentity = floorPlan
    ? `${floorPlan.url}:${floorPlan.width}:${floorPlan.height}`
    : "";
  const previousPlan = useRef(planIdentity);
  useEffect(() => {
    if (previousPlan.current !== planIdentity) {
      previousPlan.current = planIdentity;
      setView(fit);
      setFailedPlan(null);
    }
  }, [planIdentity, fit]);
  const svg = useRef<SVGSVGElement>(null),
    drag = useRef<{
      x: number;
      y: number;
      view: typeof fit;
      moved: boolean;
      tableId: string | null;
    } | null>(null);
  const labels = {
    ready: "Ready to serve",
    occupied: "Occupied",
    needs_cleaning: "Needs cleaning",
    unknown: "Verifying",
  };
  const label = (state: Omit<TableState, "last_assessment">) =>
    state.monitoring_enabled === false
      ? "Disabled"
      : state.manual_override
        ? `${COLOURS[state.status]} · Manual`
        : (unavailable ?? labels[state.status]);
  const filtered = tables.filter((table) =>
    `${table.id} ${table.label}`.toLowerCase().includes(query.toLowerCase()),
  );
  function zoom(factor: number) {
    setView((current) => {
      const w = Math.min(fit.w * 2, Math.max(fit.w / 8, current.w * factor)),
        h = (current.h * w) / current.w;
      return {
        x: current.x + (current.w - w) / 2,
        y: current.y + (current.h - h) / 2,
        w,
        h,
      };
    });
  }
  function select(table: Table, reveal = false) {
    onSelect(table.id);
    if (reveal)
      setView((current) => ({
        ...current,
        x: table.map.x * worldWidth - current.w / 2,
        y: table.map.y * worldHeight - current.h / 2,
      }));
  }
  return (
    <div className="map-workspace">
      {floorPlan && failedPlan === floorPlan.url && (
        <p className="input-error" role="alert">
          The uploaded floor plan could not load. Table positions still refer to
          that image; reopen setup to check the file.
        </p>
      )}
      <div className="map-tools">
        <label className="table-search">
          <Search size={13} />
          <input
            data-testid="table-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a table"
            aria-label="Find a table"
          />
        </label>
        <div className="map-navigation">
          <button
            data-testid="map-zoom-out"
            className="icon-button small"
            onClick={() => zoom(1.25)}
            aria-label="Zoom out"
          >
            <Minus size={14} />
          </button>
          <button
            data-testid="map-zoom-in"
            className="icon-button small"
            onClick={() => zoom(0.8)}
            aria-label="Zoom in"
          >
            <Plus size={14} />
          </button>
          <button
            data-testid="map-fit-all"
            className="fit-button"
            onClick={() => setView(fit)}
          >
            <Maximize2 size={12} />
            Fit all
          </button>
        </div>
      </div>
      <svg
        ref={svg}
        className="floor-map scalable-map"
        data-testid="floor-map"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        role="group"
        tabIndex={0}
        aria-label={`Restaurant ${floorPlan ? "uploaded" : "schematic"} floor plan. Drag to pan; use plus, minus, arrows, or zero to fit.`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            view,
            moved: false,
            tableId:
              (event.target as Element)
                .closest("[data-table-id]")
                ?.getAttribute("data-table-id") ?? null,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current || !svg.current) return;
          const dx = event.clientX - drag.current.x,
            dy = event.clientY - drag.current.y;
          if (Math.abs(dx) + Math.abs(dy) > 4) drag.current.moved = true;
          if (!drag.current.moved) return;
          const rect = svg.current.getBoundingClientRect();
          const units = Math.max(
            drag.current.view.w / rect.width,
            drag.current.view.h / rect.height,
          );
          setView({
            ...drag.current.view,
            x: drag.current.view.x - dx * units,
            y: drag.current.view.y - dy * units,
          });
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          const interaction = drag.current;
          drag.current = null;
          if (interaction && !interaction.moved) {
            const table = tables.find((t) => t.id === interaction.tableId);
            if (table) select(table);
          }
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "+" || event.key === "=") zoom(0.8);
          else if (event.key === "-") zoom(1.25);
          else if (event.key === "0") setView(fit);
          else if (event.key.startsWith("Arrow"))
            setView((v) => ({
              ...v,
              x:
                v.x +
                (event.key === "ArrowRight"
                  ? 1
                  : event.key === "ArrowLeft"
                    ? -1
                    : 0) *
                  v.w *
                  0.1,
              y:
                v.y +
                (event.key === "ArrowDown"
                  ? 1
                  : event.key === "ArrowUp"
                    ? -1
                    : 0) *
                  v.h *
                  0.1,
            }));
          else return;
          event.preventDefault();
        }}
      >
        <defs>
          <pattern
            id="map-dots"
            width="24"
            height="24"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="2" cy="2" r="1.2" fill="#dfe4e2" />
          </pattern>
        </defs>
        <rect
          x={view.x}
          y={view.y}
          width={view.w}
          height={view.h}
          fill="url(#map-dots)"
        />
        {floorPlan && (
          <image
            data-testid="floor-plan-image"
            href={floorPlan.url}
            x={0}
            y={0}
            width={worldWidth}
            height={worldHeight}
            preserveAspectRatio="none"
            onError={() => setFailedPlan(floorPlan.url)}
            onLoad={() => setFailedPlan(null)}
          />
        )}
        {tables.map((table) => {
          const state = states[table.id],
            disabled = state.monitoring_enabled === false,
            [color, pale] = disabled
              ? ["#a1a6a3", "#eeeeeb"]
              : colors[state.status],
            x = table.map.x * worldWidth,
            y = table.map.y * worldHeight,
            w = table.map.w * worldWidth,
            h = table.map.h * worldHeight,
            active = selected === table.id;
          return (
            <g
              key={table.id}
              data-table-id={table.id}
              data-testid={`table-${table.id}`}
              data-monitoring={disabled ? "disabled" : "enabled"}
              role="button"
              tabIndex={0}
              aria-label={`${table.id}, ${table.label}, ${label(state)}`}
              aria-pressed={active}
              className={`map-table ${disabled ? "monitoring-disabled" : ""}`}
              onClick={(event) => {
                if (event.detail === 0) select(table);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  select(table);
                }
              }}
            >
              <title>{`${table.label} (${table.id}): ${label(state)}`}</title>
              <g
                transform={`rotate(${table.map.rotation ?? 0} ${x} ${y})`}
                data-testid={`table-shape-${table.id}`}
              >
                {active &&
                  (table.map.shape === "round" ? (
                    <ellipse
                      cx={x}
                      cy={y}
                      rx={w / 2 + 11}
                      ry={h / 2 + 11}
                      fill="none"
                      stroke={color}
                      strokeOpacity=".4"
                      strokeWidth="2"
                      strokeDasharray="6 5"
                    />
                  ) : (
                    <rect
                      x={x - w / 2 - 11}
                      y={y - h / 2 - 11}
                      width={w + 22}
                      height={h + 22}
                      rx={17}
                      fill="none"
                      stroke={color}
                      strokeOpacity=".4"
                      strokeWidth="2"
                      strokeDasharray="6 5"
                    />
                  ))}
                {table.map.shape === "round" ? (
                  <ellipse
                    cx={x}
                    cy={y}
                    rx={w / 2}
                    ry={h / 2}
                    fill={pale}
                    stroke={color}
                    strokeWidth={active ? 3 : 2}
                    strokeDasharray={
                      state.status === "unknown" ? "7 5" : undefined
                    }
                  />
                ) : (
                  <rect
                    x={x - w / 2}
                    y={y - h / 2}
                    width={w}
                    height={h}
                    rx={Math.min(15, h / 5)}
                    fill={pale}
                    stroke={color}
                    strokeWidth={active ? 3 : 2}
                    strokeDasharray={
                      state.status === "unknown" ? "7 5" : undefined
                    }
                  />
                )}
              </g>
              <text
                x={x}
                y={y + (tables.length > 7 ? 6 : -4)}
                textAnchor="middle"
                fill="#273d31"
                fontSize={Math.min(
                  28,
                  (w / Math.max(3, Math.min(18, table.label.length))) * 1.4,
                  h * 0.33,
                )}
                fontWeight="650"
              >
                {table.label.length > 18
                  ? `${table.label.slice(0, 17)}…`
                  : table.label}
              </text>
              <text
                data-testid={`status-${table.id}`}
                x={x}
                y={y + h * 0.28}
                textAnchor="middle"
                fill={color}
                fontSize={Math.min(14, w / 9)}
                fontWeight="550"
                className={tables.length > 7 ? "map-hidden-status" : undefined}
              >
                {label(state)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="table-index" aria-label="Table list">
        {filtered.map((table) => (
          <button
            key={table.id}
            data-testid={`table-list-${table.id}`}
            data-monitoring={
              states[table.id].monitoring_enabled === false
                ? "disabled"
                : "enabled"
            }
            className={`table-index-item ${states[table.id].status} ${selected === table.id ? "selected" : ""} ${states[table.id].monitoring_enabled === false ? "monitoring-disabled" : ""}`}
            onClick={() => select(table, true)}
            aria-pressed={selected === table.id}
          >
            <span className="status-dot" />
            <strong>{table.label}</strong>
            <span>{label(states[table.id])}</span>
          </button>
        ))}
        {filtered.length === 0 && (
          <p className="no-tables">No matching tables.</p>
        )}
      </div>
    </div>
  );
}
