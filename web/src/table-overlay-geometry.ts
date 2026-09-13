import type { Table } from "../../shared/contracts";

/** Camera outlines and labels share the reviewed tabletop in source coordinates. */
export function tableOverlayGeometry(
  table: Pick<Table, "tabletop_polygon">,
  width: number,
  height: number,
) {
  const polygon = table.tabletop_polygon;
  if (!polygon || polygon.length < 3) return null;

  const points = polygon.map(([x, y]) => [x * width, y * height]);
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    points: points.map(([x, y]) => `${x},${y}`).join(" "),
    bounds: {
      left: Math.min(...xs),
      top: Math.min(...ys),
      right: Math.max(...xs),
      bottom: Math.max(...ys),
    },
  };
}
