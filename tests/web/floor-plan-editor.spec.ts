import { expect, test, type Page } from "./browser-fixtures";
import type { CalibrationTable, SourceInfo } from "../../shared/live-contracts";
import { objectBundle } from "./object-fixtures";
import {
  directions,
  rotate,
  type Handle,
} from "../../web/src/floor-plan-geometry";

async function mount(page: Page, uploaded = false) {
  const original = objectBundle().tables[0];
  const table: CalibrationTable = {
    ...original,
    id: "T1",
    label: "Window table",
    map: { x: 0.5, y: 0.5, w: 0.2, h: 0.2, shape: "rect", rotation: 0 },
    setup_review: { tabletop: true, occupancy: true, map: false },
    reference_t: 0,
  };
  let source: SourceInfo = {
    id: "floor-editor-test",
    kind: "video",
    label: "Floor editor fixture",
    status: "needs_setup",
    phase: "Review setup",
    progress: 1,
    revision: 1,
    calibration_confirmed: false,
    setup_mode: "guided_v1",
    setup_reference: {
      reference_source: "video_frame",
      reference_t: 0,
      alignment_confirmed: false,
    },
    floor_plan_mode: uploaded ? "uploaded" : "schematic",
    width: 1280,
    height: 720,
    fps: 10,
    duration_s: 42,
    tables: [table],
    frame_url: "/api/sources/browser-fixture/assets/original.png",
    media_url: "/api/sources/browser-fixture/assets/video.mp4",
    ...(uploaded
      ? {
          setup_assets: {
            floor_plan: {
              file: "plan.png",
              width: 1280,
              height: 720,
              sha256: "a".repeat(64),
            },
          },
        }
      : {}),
  };
  const saves: CalibrationTable[][] = [];
  await page.route("**/api/health", (r) =>
    r.fulfill({
      json: {
        available: true,
        models: { detector: { available: true }, surface: { available: true } },
        limits: { upload_bytes: 1e9, duration_s: 600, frame_bytes: 2097152 },
      },
    }),
  );
  await page.route("**/api/jobs", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/cameras", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/sources/floor-editor-test", (r) =>
    r.fulfill({ json: source }),
  );
  await page.route("**/api/jobs/floor-editor-test", (r) =>
    r.fulfill({ json: source }),
  );
  await page.route("**/api/sources/floor-editor-test/assets/plan.png", (r) =>
    r.fulfill({
      path: "tests/fixtures/workflow/original.png",
      contentType: "image/png",
    }),
  );
  await page.route(
    "**/api/sources/floor-editor-test/calibration",
    async (r) => {
      const body = r.request().postDataJSON();
      expect(body.revision).toBe(source.revision);
      saves.push(body.tables);
      source = {
        ...source,
        tables: body.tables,
        revision: source.revision + 1,
      };
      await r.fulfill({ json: source });
    },
  );
  await page.goto("/?setup=floor-editor-test");
  await expect(page.getByTestId("floor-plan-editor")).toBeVisible();
  return {
    async savedMap() {
      const count = saves.length;
      await page.getByTestId("calibration-save-draft").click();
      await expect.poll(() => saves.length).toBe(count + 1);
      await expect(page.getByTestId("calibration-save-draft")).toBeEnabled();
      return saves.at(-1)![0].map;
    },
  };
}
async function screenPoint(page: Page, x: number, y: number) {
  await page.getByTestId("floor-plan-editor").scrollIntoViewIfNeeded();
  return page.getByTestId("floor-plan-editor").evaluate(
    (svg, p) => {
      const m = (svg as SVGSVGElement).getScreenCTM()!;
      const result = new DOMPoint(p.x, p.y).matrixTransform(m);
      return { x: result.x, y: result.y };
    },
    { x, y },
  );
}
async function dragBetween(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
}

for (const handle of Object.keys(directions) as Handle[])
  test(`floor plan supports the ${handle} resize handle and preserves its opposite anchor`, async ({
    page,
  }) => {
    const state = await mount(page),
      [sx, sy] = directions[handle];
    const start = await screenPoint(page, 500 + sx * 100, 325 + sy * 65),
      end = await screenPoint(page, 500 + sx * 120, 325 + sy * 75);
    await dragBetween(page, start, end);
    const map = await state.savedMap();
    expect(map.w * 1000).toBeCloseTo(200 + (sx ? 20 : 0), 0);
    expect(map.h * 650).toBeCloseTo(130 + (sy ? 10 : 0), 0);
    expect(map.x * 1000 - (sx * map.w * 1000) / 2).toBeCloseTo(
      500 - sx * 100,
      0,
    );
    expect(map.y * 650 - (sy * map.h * 650) / 2).toBeCloseTo(325 - sy * 65, 0);
  });
test("grabbing off-centre preserves offset and moving stops at the entire shape boundary", async ({
  page,
}) => {
  const state = await mount(page),
    from = await screenPoint(page, 540, 340),
    to = await screenPoint(page, 565, 355);
  await dragBetween(page, from, to);
  let map = await state.savedMap();
  expect(map.x).toBeCloseTo(0.525, 3);
  expect(map.y).toBeCloseTo(340 / 650, 3);
  const nextFrom = await screenPoint(page, 525, 340),
    edge = await screenPoint(page, 20, 20);
  await dragBetween(page, nextFrom, edge);
  map = await state.savedMap();
  expect(map.x).toBeCloseTo(0.1, 3);
  expect(map.y).toBeCloseTo(0.1, 3);
});
test("rotation handle rotates the table and normalized numeric rotation updates it", async ({
  page,
}) => {
  const state = await mount(page),
    center = await screenPoint(page, 500, 325),
    handle = (await page.getByTestId("rotate-handle").boundingBox())!,
    start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 },
    offset = rotate({ x: start.x - center.x, y: start.y - center.y }, 45),
    end = { x: center.x + offset.x, y: center.y + offset.y };
  await dragBetween(page, start, end);
  await expect
    .poll(async () =>
      Number(
        await page.getByLabel("Rotation (°)", { exact: true }).inputValue(),
      ),
    )
    .toBeCloseTo(45, 0);
  await page.getByLabel("Rotation (°)", { exact: true }).fill("-45");
  await expect(page.getByLabel("Rotation (°)", { exact: true })).toHaveValue(
    "315",
  );
  expect((await state.savedMap()).rotation).toBe(315);
});
test("pixel dimensions, shape and aspect lock stay synchronized with edits and history", async ({
  page,
}) => {
  const state = await mount(page),
    width = page.getByLabel("Width (px)", { exact: true }),
    height = page.getByLabel("Height (px)", { exact: true });
  await expect(width).toHaveValue("200");
  await expect(height).toHaveValue("130");
  await expect(page.getByLabel("Lock aspect ratio")).not.toBeChecked();
  await page.getByLabel("Lock aspect ratio").check();
  await width.fill("240");
  await expect(height).toHaveValue("156");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(width).toHaveValue("200");
  await expect(height).toHaveValue("130");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(width).toHaveValue("240");
  await page.getByLabel("Lock aspect ratio").uncheck();
  await height.fill("180");
  await expect(width).toHaveValue("240");
  await page
    .getByRole("combobox", { name: "Shape", exact: true })
    .selectOption("round");
  await expect(
    page.getByTestId("floor-plan-editor").locator("ellipse"),
  ).toHaveCount(1);
  const map = await state.savedMap();
  expect(map.w).toBeCloseTo(0.24);
  expect(map.h).toBeCloseTo(180 / 650);
  expect(map.shape).toBe("round");
});
test("invalid numeric values keep the last valid geometry and explain the error", async ({
  page,
}) => {
  const state = await mount(page);
  await page.getByLabel("Width (px)", { exact: true }).fill("20000");
  await expect(page.locator("#floor-editor-error")).toContainText(
    "keep the entire rotated shape inside the plan",
  );
  let map = await state.savedMap();
  expect(map.w).toBe(0.2);
  expect(map.h).toBe(0.2);
  await page.getByLabel("Height (px)", { exact: true }).fill("-1");
  await expect(page.locator("#floor-editor-error")).toContainText(
    "positive size",
  );
  map = await state.savedMap();
  expect(map.h).toBe(0.2);
});
test("keyboard movement and undo remain available after switching away from the map", async ({
  page,
}) => {
  const state = await mount(page),
    canvas = page.getByTestId("floor-plan-editor");
  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await page.getByTestId("table-step-occupancy").click();
  await page.getByTestId("table-step-map").click();
  await canvas.focus();
  await page.keyboard.press("Control+z");
  let map = await state.savedMap();
  expect(map.x).toBeCloseTo(0.501);
  expect(map.y).toBe(0.5);
  await canvas.focus();
  await page.keyboard.press("Control+Shift+z");
  map = await state.savedMap();
  expect(map.y).toBeCloseTo(0.5 + 10 / 650);
});
test("uploaded plan pixel dimensions remain stable across viewports and draft saves", async ({
  page,
}) => {
  const state = await mount(page, true);
  await page.getByLabel("Width (px)", { exact: true }).fill("300");
  await page.getByLabel("Height (px)", { exact: true }).fill("180");
  for (const width of [1440, 820, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.getByLabel("Width (px)", { exact: true })).toHaveValue(
      "300",
    );
    await expect(page.getByLabel("Height (px)", { exact: true })).toHaveValue(
      "180",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.screenshot({
    path: "/tmp/tablewatch-responsive-review/floor-editor-mobile-after.png",
    fullPage: true,
  });
  const map = await state.savedMap();
  expect(map.w).toBeCloseTo(300 / 1280);
  expect(map.h).toBeCloseTo(180 / 720);
  await page.reload();
  await expect(page.getByLabel("Width (px)", { exact: true })).toHaveValue(
    "300",
  );
  await expect(page.getByLabel("Height (px)", { exact: true })).toHaveValue(
    "180",
  );
});

test("aspect-locked handle dragging preserves the physical width-to-height ratio", async ({
  page,
}) => {
  const state = await mount(page);
  await page.getByLabel("Lock aspect ratio").check();
  const start = await screenPoint(page, 600, 390),
    end = await screenPoint(page, 645, 400);
  await dragBetween(page, start, end);
  const map = await state.savedMap();
  expect(map.w).toBeGreaterThan(0.2);
  expect((map.w * 1000) / (map.h * 650)).toBeCloseTo(200 / 130, 5);
});
