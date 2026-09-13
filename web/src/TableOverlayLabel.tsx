import type { Table } from "../../shared/contracts";

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
      Math.min(width - badgeWidth, table.video_region[0] * width),
    ),
    y = Math.max(0, table.video_region[1] * height - badgeHeight);
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
