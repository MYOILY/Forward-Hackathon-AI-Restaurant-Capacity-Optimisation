import type { Point } from "../../shared/contracts";

export interface RectificationPlan {
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  indices: Uint32Array;
  weights: Float32Array;
}

function solve(matrix: number[][]): number[] {
  for (let column = 0; column < 8; column++) {
    let pivot = column;
    for (let row = column + 1; row < 8; row++)
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column]))
        pivot = row;
    if (Math.abs(matrix[pivot][column]) < 1e-12)
      throw new Error("Tabletop geometry cannot be rectified.");
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const divisor = matrix[column][column];
    for (let k = column; k <= 8; k++) matrix[column][k] /= divisor;
    for (let row = 0; row < 8; row++)
      if (row !== column) {
        const factor = matrix[row][column];
        for (let k = column; k <= 8; k++)
          matrix[row][k] -= factor * matrix[column][k];
      }
  }
  return matrix.map((row) => row[8]);
}
const roundEven = (value: number): number =>
  value % 1 === 0.5
    ? Math.floor(value) % 2 === 0
      ? Math.floor(value)
      : Math.ceil(value)
    : Math.round(value);

/** Ordered source corners correspond to TL/TR/BR/BL, matching processor.geometry. */
export function createRectificationPlan(
  polygon: Point[],
  sourceWidth: number,
  sourceHeight: number,
): RectificationPlan {
  if (polygon.length !== 4 || sourceWidth < 2 || sourceHeight < 2)
    throw new Error("A tabletop needs four corners and a valid source frame.");
  const source = polygon.map(([x, y]) => [
    Math.fround(Math.fround(x) * (sourceWidth - 1)),
    Math.fround(Math.fround(y) * (sourceHeight - 1)),
  ]);
  const length = (a: number[], b: number[]) =>
    Math.hypot(a[0] - b[0], a[1] - b[1]);
  const horizontal =
    (length(source[1], source[0]) + length(source[2], source[3])) / 2;
  const vertical =
    (length(source[3], source[0]) + length(source[2], source[1])) / 2;
  const scale = 512 / Math.max(horizontal, vertical);
  const width = Math.max(8, Math.min(512, roundEven(horizontal * scale))),
    height = Math.max(8, Math.min(512, roundEven(vertical * scale)));
  if (!Number.isFinite(width) || !Number.isFinite(height))
    throw new Error("Tabletop geometry is degenerate.");
  const destination = [
    [0, 0],
    [width - 1, 0],
    [width - 1, height - 1],
    [0, height - 1],
  ];
  const equations: number[][] = [];
  destination.forEach(([x, y], i) => {
    const [u, v] = source[i];
    equations.push(
      [x, y, 1, 0, 0, 0, -u * x, -u * y, u],
      [0, 0, 0, x, y, 1, -v * x, -v * y, v],
    );
  });
  const h = solve(equations),
    indices = new Uint32Array(width * height * 4),
    weights = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const denominator = h[6] * x + h[7] * y + 1;
      if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12)
        throw new Error("Unstable tabletop perspective transform.");
      const sx = Math.max(
        0,
        Math.min(sourceWidth - 1, (h[0] * x + h[1] * y + h[2]) / denominator),
      );
      const sy = Math.max(
        0,
        Math.min(sourceHeight - 1, (h[3] * x + h[4] * y + h[5]) / denominator),
      );
      const x0 = Math.floor(sx),
        y0 = Math.floor(sy),
        x1 = Math.min(sourceWidth - 1, x0 + 1),
        y1 = Math.min(sourceHeight - 1, y0 + 1),
        dx = sx - x0,
        dy = sy - y0,
        i = (y * width + x) * 4;
      indices[i] = (y0 * sourceWidth + x0) * 4;
      indices[i + 1] = (y0 * sourceWidth + x1) * 4;
      indices[i + 2] = (y1 * sourceWidth + x0) * 4;
      indices[i + 3] = (y1 * sourceWidth + x1) * 4;
      weights[i] = (1 - dx) * (1 - dy);
      weights[i + 1] = dx * (1 - dy);
      weights[i + 2] = (1 - dx) * dy;
      weights[i + 3] = dx * dy;
    }
  return { sourceWidth, sourceHeight, width, height, indices, weights };
}

/** Border replication plus bilinear sampling; cached indices/weights avoid per-frame homography work. */
export function rectifyRgba(
  plan: RectificationPlan,
  source: Uint8ClampedArray,
  output: Uint8ClampedArray,
): void {
  if (
    source.length !== plan.sourceWidth * plan.sourceHeight * 4 ||
    output.length !== plan.width * plan.height * 4
  )
    throw new Error("Rectification frame dimensions do not match calibration.");
  const { indices, weights } = plan;
  for (let i = 0; i < output.length; i += 4) {
    const a = indices[i],
      b = indices[i + 1],
      c = indices[i + 2],
      d = indices[i + 3],
      wa = weights[i],
      wb = weights[i + 1],
      wc = weights[i + 2],
      wd = weights[i + 3];
    for (let channel = 0; channel < 4; channel++)
      output[i + channel] =
        source[a + channel] * wa +
        source[b + channel] * wb +
        source[c + channel] * wc +
        source[d + channel] * wd;
  }
}
