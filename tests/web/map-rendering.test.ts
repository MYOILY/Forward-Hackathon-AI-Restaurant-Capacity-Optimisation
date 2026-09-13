import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FloorMap } from "../../web/src/FloorMap";
import type { TableState } from "../../shared/contracts";
import { fixture } from "./fixtures";
import { validateBundle } from "../../web/src/validation";

function render(rotation?: number, shape: "rect" | "round" = "rect") {
  const tables = fixture().tables;
  tables[0].map = {
    x: 0.5,
    y: 0.5,
    w: 0.8,
    h: 0.1,
    shape,
    ...(rotation === undefined ? {} : { rotation }),
  };
  const state = { status: "ready", monitoring_enabled: true } as Omit<
    TableState,
    "last_assessment"
  >;
  return renderToStaticMarkup(
    createElement(FloorMap, {
      tables,
      states: { T1: state },
      selected: "T1",
      onSelect: () => {},
    }),
  );
}

describe("map rendering shared by playback and live views", () => {
  it("defaults omitted rotation to zero and leaves text outside the transformed shape", () => {
    const html = render();
    expect(html).toContain('transform="rotate(0 500 325)"');
    expect(html).toMatch(/<\/g><text[^>]*>Table 1<\/text>/);
  });
  it("renders a true unequal-axis ellipse and its selected outline", () => {
    const html = render(45, "round");
    expect(html).toContain('transform="rotate(45 500 325)"');
    expect(html).toContain('rx="400" ry="32.5"');
    expect(html.match(/<ellipse /g)).toHaveLength(2);
  });
  it("fits the entire rotated long shape in a schematic view", () => {
    const html = render(90);
    const [x, y, w, h] = html
      .match(/data-testid="floor-map" viewBox="([^"]+)"/)![1]
      .split(" ")
      .map(Number);
    expect(x).toBeLessThanOrEqual(467.5);
    expect(x + w).toBeGreaterThanOrEqual(532.5);
    expect(y).toBeLessThanOrEqual(-75);
    expect(y + h).toBeGreaterThanOrEqual(725);
  });
});

describe("imported map rotation contract", () => {
  it.each([undefined, 0, 45, 359.999])("accepts rotation %s", (rotation) => {
    const bundle = fixture();
    if (rotation !== undefined) bundle.tables[0].map.rotation = rotation;
    expect(() => validateBundle(bundle)).not.toThrow();
  });
  it.each([null, "45", true, false, NaN, Infinity, -1, 360])(
    "rejects rotation %s",
    (rotation) => {
      const bundle = fixture();
      Object.assign(bundle.tables[0].map, { rotation });
      expect(() => validateBundle(bundle)).toThrow("Invalid map rotation");
    },
  );
});
