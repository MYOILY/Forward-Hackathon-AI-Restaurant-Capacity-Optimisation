import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Table } from "../../shared/contracts";
import { TableOverlayLabel } from "../../web/src/TableOverlayLabel";
import { tableOverlayGeometry } from "../../web/src/table-overlay-geometry";
import { replayFixture } from "./replay-fixtures";

function redrawnTable(): Table {
  return {
    ...replayFixture(0).tables[0],
    label: "Front table",
    // The detector proposed a different table in the back-left corner.
    video_region: [.05, .05, .25, .2],
    crop: [.05, .05, .25, .2],
    tabletop_polygon: [[.3, .55], [.6, .56], [.5, .95], [.1, .9]],
  };
}

describe("reviewed camera overlays", () => {
  it.each([[1000, 600], [640, 360]])("shows the marked trapezoid instead of the original detection at %sx%s", (width, height) => {
    const table = redrawnTable();
    const geometry = tableOverlayGeometry(table, width, height)!;
    const vertices = geometry.points.split(" ").map(pair => pair.split(",").map(Number));
    expect(vertices).toEqual([
      [.3 * width, .55 * height], [.6 * width, .56 * height],
      [.5 * width, .95 * height], [.1 * width, .9 * height],
    ]);
    expect(geometry.bounds).toEqual({ left: .1 * width, top: .55 * height, right: .6 * width, bottom: .95 * height });
    expect(table.video_region).toEqual([.05, .05, .25, .2]);
  });

  it("puts the saved name above the reviewed table, not above the suggested table", () => {
    const markup = renderToStaticMarkup(createElement(TableOverlayLabel, {
      table: redrawnTable(), width: 1000, height: 600, color: "#123456",
    }));
    const badge = markup.match(/<rect[^>]* x="([^"]+)" y="([^"]+)"/)!;
    expect(Number(badge[1])).toBe(100);
    expect(Number(badge[2])).toBeCloseTo(305.25);
    expect(markup).toContain("Front table");
    expect(markup).toContain("ID T1");
  });

  it("never invents a camera outline from a stale detector box when reviewed corners are absent", () => {
    const table = { ...redrawnTable(), tabletop_polygon: undefined };
    expect(tableOverlayGeometry(table, 1000, 600)).toBeNull();
    expect(renderToStaticMarkup(createElement(TableOverlayLabel, {
      table, width: 1000, height: 600, color: "#123456",
    }))).toBe("");
  });
});
