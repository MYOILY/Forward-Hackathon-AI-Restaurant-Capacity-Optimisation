import { describe, expect, it } from "vitest";
import {
  contained,
  directions,
  extents,
  moveMap,
  resizeMap,
  rotate,
  type Handle,
  type PlanMap,
} from "../../web/src/floor-plan-geometry";
const size = { width: 1000, height: 650 };
const map: PlanMap = {
  x: 0.5,
  y: 0.5,
  w: 0.2,
  h: 0.2,
  shape: "rect",
  rotation: 0,
};
describe("floor-plan geometry", () => {
  it("preserves the grab offset by applying only pointer delta", () => {
    expect(moveMap(map, { x: 0, y: 0 }, size)).toEqual(map);
    const next = moveMap(map, { x: 15, y: -20 }, size);
    expect(next.x).toBeCloseTo(0.515);
    expect(next.y).toBeCloseTo(0.5 - 20 / 650);
  });
  for (const handle of Object.keys(directions) as Handle[])
    it(`resizes ${handle} with the opposite edge anchored`, () => {
      const [sx, sy] = directions[handle];
      const next = resizeMap(map, handle, { x: sx * 20, y: sy * 10 }, size);
      expect(next.w * 1000).toBeCloseTo(200 + (sx ? 20 : 0));
      expect(next.h * 650).toBeCloseTo(130 + (sy ? 10 : 0));
      expect(next.x * 1000 - (sx * next.w * 1000) / 2).toBeCloseTo(
        500 - sx * 100,
      );
      expect(next.y * 650 - (sy * next.h * 650) / 2).toBeCloseTo(325 - sy * 65);
    });
  it("resizes in rotated local coordinates", () => {
    const current = { ...map, rotation: 90 };
    const next = resizeMap(current, "e", { x: 0, y: 30 }, size);
    expect(next.w * 1000).toBeCloseTo(230);
    expect(next.h).toBeCloseTo(map.h);
    expect(next.x).toBeCloseTo(0.5);
    expect(next.y * 650).toBeCloseTo(340);
  });
  it("keeps aspect ratio for corner and side resizing", () => {
    for (const h of Object.keys(directions) as Handle[]) {
      const [sx, sy] = directions[h];
      const next = resizeMap(map, h, { x: sx * 50, y: sy * 10 }, size, true);
      expect((next.w * 1000) / (next.h * 650)).toBeCloseTo(200 / 130);
    }
  });
  it("contains the full rotated bounding box during movement", () => {
    const current = { ...map, rotation: 45 };
    const next = moveMap(current, { x: -1000, y: -1000 }, size);
    expect(contained(next, size)).toBe(true);
    const e = extents(next, size);
    expect(next.x * 1000).toBeCloseTo(e.x);
    expect(next.y * 650).toBeCloseTo(e.y);
  });
  it("stops rotated resizing at the plan boundary", () => {
    const current = { ...map, rotation: 35 };
    const next = resizeMap(current, "se", { x: 5000, y: 5000 }, size, true);
    expect(contained(next, size)).toBe(true);
    expect(next.w).toBeGreaterThan(map.w);
    expect(next.w / next.h).toBeCloseTo(map.w / map.h);
  });
  it("rejects invalid numeric geometry and out-of-bounds rotation", () => {
    expect(contained({ ...map, w: 0 }, size)).toBe(false);
    expect(contained({ ...map, h: NaN }, size)).toBe(false);
    expect(contained({ ...map, x: 0.1, rotation: 45 }, size)).toBe(false);
    expect(contained(map, size)).toBe(true);
  });
  it("converts a rotated point back without scale loss", () => {
    const p = { x: 75, y: 42 };
    const result = rotate(rotate(p, 33), -33);
    expect(result.x).toBeCloseTo(p.x);
    expect(result.y).toBeCloseTo(p.y);
  });
});
