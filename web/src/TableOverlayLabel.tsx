import type { Table } from "../../shared/contracts";
import { tableOverlayGeometry } from "./table-overlay-geometry";

/** Human label first; stable identity remains available in the title and secondary text. */
export function TableOverlayLabel({
  table,
  width,
  height,
  color,
}: {
  table: Table;
  width: number;
  height: number;
  color: string;
}) {
  const geometry = tableOverlayGeometry(table, width, height);
  if (!geometry) return null;

  const font = Math.max(15, width / 78),
    padding = font * 0.55;
  const name =
    [...table.label].length > 24
      ? `${[...table.label].slice(0, 23).join("")}…`
      : table.label;
  const id =
    table.label === table.id
      ? ""
      : ` · ${table.id.length > 12 ? `${table.id.slice(0, 11)}…` : table.id}`;
  const badgeWidth = Math.min(
      width,
      ([...name].length + [...id].length * 0.8) * font * 0.62 + padding * 2,
    ),
    badgeHeight = font * 1.65;
  const x = Math.max(
      0,
      Math.min(width - badgeWidth, geometry.bounds.left),
    ),
    y = Math.max(0, geometry.bounds.top - badgeHeight);
  return (
    <g className="table-overlay-label">
      <title>{`${table.label} · ID ${table.id}`}</title>
      <rect
        x={x}
        y={y}
        width={badgeWidth}
        height={badgeHeight}
        rx={font * 0.22}
        fill={color}
      />
      <text
        x={x + padding}
        y={y + font * 1.16}
        fill="#fff"
        fontSize={font}
        fontWeight="650"
      >
        {name}
        <tspan fontSize={font * 0.8} fontWeight="450">
          {id}
        </tspan>
      </text>
    </g>
  );
}
