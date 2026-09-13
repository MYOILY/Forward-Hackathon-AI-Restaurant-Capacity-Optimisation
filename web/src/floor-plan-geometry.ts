export type PlanMap = {
  x: number;
  y: number;
  w: number;
  h: number;
  shape?: "rect" | "round";
  rotation?: number;
};
export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const directions: Record<Handle, [number, number]> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};
export function rotate(p: Point, degrees: number): Point {
  const a = (degrees * Math.PI) / 180;
  return {
    x: p.x * Math.cos(a) - p.y * Math.sin(a),
    y: p.x * Math.sin(a) + p.y * Math.cos(a),
  };
}
export function extents(map: PlanMap, size: Size): Point {
  const a = ((map.rotation ?? 0) * Math.PI) / 180;
  return {
    x:
      (Math.abs(Math.cos(a)) * map.w * size.width +
        Math.abs(Math.sin(a)) * map.h * size.height) /
      2,
    y:
      (Math.abs(Math.sin(a)) * map.w * size.width +
        Math.abs(Math.cos(a)) * map.h * size.height) /
      2,
  };
}
export function contained(map: PlanMap, size: Size): boolean {
  if (
    ![map.x, map.y, map.w, map.h, map.rotation ?? 0].every(Number.isFinite) ||
    map.w * size.width < 1 ||
    map.h * size.height < 1
  )
    return false;
  const e = extents(map, size),
    x = map.x * size.width,
    y = map.y * size.height;
  return (
    x - e.x >= -1e-7 &&
    y - e.y >= -1e-7 &&
    x + e.x <= size.width + 1e-7 &&
    y + e.y <= size.height + 1e-7
  );
}
export function moveMap(map: PlanMap, delta: Point, size: Size): PlanMap {
  const e = extents(map, size);
  return {
    ...map,
    x:
      Math.max(e.x, Math.min(size.width - e.x, map.x * size.width + delta.x)) /
      size.width,
    y:
      Math.max(
        e.y,
        Math.min(size.height - e.y, map.y * size.height + delta.y),
      ) / size.height,
  };
}
export function resizeMap(
  map: PlanMap,
  handle: Handle,
  delta: Point,
  size: Size,
  lock = false,
): PlanMap {
  const [sx, sy] = directions[handle],
    d = rotate(delta, -(map.rotation ?? 0)),
    w = map.w * size.width,
    h = map.h * size.height;
  let nw = Math.max(1, w + sx * d.x),
    nh = Math.max(1, h + sy * d.y);
  if (lock) {
    const factor =
      sx && sy
        ? Math.abs(nw / w - 1) >= Math.abs(nh / h - 1)
          ? nw / w
          : nh / h
        : sx
          ? nw / w
          : nh / h;
    nw = Math.max(1, 1 / (w / h), w * factor);
    nh = (nw * h) / w;
  }
  const shift = rotate(
    { x: (sx * (nw - w)) / 2, y: (sy * (nh - h)) / 2 },
    map.rotation ?? 0,
  );
  const next = {
    ...map,
    w: nw / size.width,
    h: nh / size.height,
    x: map.x + shift.x / size.width,
    y: map.y + shift.y / size.height,
  };
  if (contained(next, size)) return next;
  // Stop at the boundary without losing the opposite anchor or aspect ratio.
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 35; i++) {
    const t = (lo + hi) / 2;
    const test = {
      ...next,
      x: map.x + (next.x - map.x) * t,
      y: map.y + (next.y - map.y) * t,
      w: map.w + (next.w - map.w) * t,
      h: map.h + (next.h - map.h) * t,
    };
    if (contained(test, size)) lo = t;
    else hi = t;
  }
  return {
    ...next,
    x: map.x + (next.x - map.x) * lo,
    y: map.y + (next.y - map.y) * lo,
    w: map.w + (next.w - map.w) * lo,
    h: map.h + (next.h - map.h) * lo,
  };
}
