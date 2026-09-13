import { expect, test, type Page } from "./browser-fixtures";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import path from "node:path";
import type { Bundle, ImageAsset, Table } from "../../shared/contracts";
import type { SourceInfo } from "../../shared/live-contracts";
import { createLiveSession } from "../../web/src/live-engine";
import { liveConfig } from "./live-fixtures";

test.use({
  permissions: ["camera"],
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

/** A real 1200×400 PNG diagram; no service or image-generation dependency. */
function floorImage(): Buffer {
  const width = 1200,
    height = 400,
    bytes = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const wall =
        x < 5 ||
        y < 5 ||
        x >= width - 5 ||
        y >= height - 5 ||
        (Math.abs(x - 600) < 3 && y < 290);
      bytes.fill(
        wall ? 54 : 235,
        y * (1 + width * 3) + 1 + x * 3,
        y * (1 + width * 3) + 4 + x * 3,
      );
    }
  const chunk = (name: string, data: Buffer) => {
    const kind = Buffer.from(name),
      content = Buffer.concat([kind, data]);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4),
      check = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, content, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(bytes)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const planBytes = floorImage();
const plan: ImageAsset = {
  file: "setup/floor-plan.png",
  sha256: createHash("sha256").update(planBytes).digest("hex"),
  width: 1200,
  height: 400,
};
function place(tables: Table[]) {
  tables[0].label = "Window 1";
  tables[0].map = { x: 0.25, y: 0.25, w: 0.14, h: 0.14, shape: "rect" };
  tables[1].label = "Garden 2";
  tables[1].map = { x: 0.75, y: 0.75, w: 0.14, h: 0.14, shape: "rect" };
}
async function replay(page: Page, uploaded: boolean) {
  const bundle = JSON.parse(
    await readFile(path.resolve("tests/fixtures/workflow/bundle.json"), "utf8"),
  ) as Bundle;
  bundle.tables = [
    structuredClone(bundle.tables[0]),
    { ...structuredClone(bundle.tables[0]), id: "T2" },
  ];
  place(bundle.tables);
  bundle.staff_events = [];
  bundle.assessments = [];
  bundle.assessment_requests = [];
  bundle.snapshots = [];
  bundle.replay_events = [];
  for (const observation of bundle.observations) {
    observation.valid = true;
    observation.tables = { T1: "absent", T2: "absent" };
    observation.tracks = [];
    observation.detections = [];
    observation.surface = {
      T1: { visible: true, changed: false },
      T2: { visible: true, changed: false },
    };
  }
  if (uploaded) bundle.floor_plan = plan;
  else delete bundle.floor_plan;
  await page.route(
    "**/api/sources/browser-fixture/assets/bundle.json",
    (route) => route.fulfill({ json: bundle }),
  );
  await page.route(
    "**/api/sources/browser-fixture/assets/setup/floor-plan.png",
    (route) => route.fulfill({ body: planBytes, contentType: "image/png" }),
  );
  await page.goto("/?source=browser-fixture");
  await expect(page.getByTestId("table-T1")).toBeVisible();
}
async function positionedOnImage(page: Page) {
  const image = page.getByTestId("floor-plan-image");
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("width", "1000");
  expect(Number(await image.getAttribute("height"))).toBeCloseTo(1000 / 3, 8);
  const decoded = await image.evaluate(async (element) => {
    const image = new Image();
    image.src = (element as SVGImageElement).href.baseVal;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  });
  expect(decoded).toEqual({ width: 1200, height: 400 });
  const bounds = (await image.boundingBox())!;
  expect(bounds.width / bounds.height).toBeCloseTo(3, 5);
  for (const [id, fraction] of [
    ["T1", 0.25],
    ["T2", 0.75],
  ] as const) {
    const table = (await page
      .getByTestId(`table-${id}`)
      .locator("rect")
      .last()
      .boundingBox())!;
    expect((table.x + table.width / 2 - bounds.x) / bounds.width).toBeCloseTo(
      fraction,
      4,
    );
    expect((table.y + table.height / 2 - bounds.y) / bounds.height).toBeCloseTo(
      fraction,
      4,
    );
  }
}
async function selectAndSearch(page: Page, live = false) {
  await page.getByTestId("table-T2").click();
  await expect(page.getByTestId("table-T2")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByTestId(live ? "live-table-label" : "table-label"),
  ).toHaveValue("Garden 2");
  await page.getByTestId("table-search").fill("window");
  await expect(page.getByTestId("table-list-T2")).toHaveCount(0);
  await page.getByTestId("table-list-T1").click();
  await expect(page.getByTestId("table-T1")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByTestId(live ? "live-table-label" : "table-label"),
  ).toHaveValue("Window 1");
  await page.getByTestId("map-fit-all").click();
}
async function live(page: Page, mode: "uploaded" | "schematic") {
  const config = liveConfig(true, 2);
  config.session_id = "floor-plan-session";
  place(config.tables);
  config.tables.forEach((table) => {
    table.reference = null;
  });
  const source: SourceInfo = {
    id: "floor-plan-camera",
    kind: "camera",
    label: "Floor plan camera fixture",
    status: "needs_setup",
    progress: 1,
    phase: "needs_setup",
    revision: 1,
    calibration_confirmed: true,
    width: 640,
    height: 360,
    fps: 0,
    duration_s: 0,
    tables: config.tables,
    device_key: "default",
    floor_plan_mode: mode,
    setup_assets: { floor_plan: plan },
  };
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        available: true,
        models: {
          detector: { available: true },
          surface: { available: false },
        },
        limits: { upload_bytes: 1e9, duration_s: 600, frame_bytes: 2e6 },
      },
    }),
  );
  await page.route("**/api/jobs", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/cameras", (route) =>
    route.fulfill({ json: [source] }),
  );
  await page.route("**/api/sources/floor-plan-camera", (route) =>
    route.fulfill({ json: source }),
  );
  await page.route(
    "**/api/sources/floor-plan-camera/assets/setup/floor-plan.png",
    (route) => route.fulfill({ body: planBytes, contentType: "image/png" }),
  );
  await page.route("**/api/live", (route) =>
    route.fulfill({
      json: {
        session_id: config.session_id,
        epoch: config.epoch,
        config,
        ws_url: `/live/${config.session_id}/stream`,
      },
    }),
  );
  await page.route("**/api/live/floor-plan-session", (route) =>
    route.fulfill({ json: { stopped: true } }),
  );
  const snapshot = createLiveSession(config).send({
    op: "tick",
    t: 0,
  }).snapshot;
  await page.routeWebSocket("**/live/floor-plan-session/stream", (socket) =>
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "sync") {
        socket.send(
          JSON.stringify({ type: "clock", client_t: message.client_t, t: 0 }),
        );
        socket.send(JSON.stringify({ type: "update", snapshot }));
      }
    }),
  );
  await page.goto("/?setup=new");
  await page.getByTestId("source-open-floor-plan-camera").click();
  await page.getByTestId("camera-preview-start").click();
  await expect(page.getByTestId("camera-reuse-confirmed")).toBeEnabled();
  await page.getByTestId("camera-reuse-confirmed").check();
  await page.getByTestId("live-start").click();
  await expect(page.getByTestId("table-T1")).toBeVisible();
}

test("replay renders the uploaded wide floor plan and preserves normalized placement, selection and search", async ({
  page,
}, testInfo) => {
  await replay(page, true);
  await positionedOnImage(page);
  await selectAndSearch(page);
  await expect(page.getByTestId("floor-map")).toHaveAttribute(
    "aria-label",
    /uploaded floor plan/,
  );
  await page
    .getByTestId("floor-map")
    .screenshot({ path: testInfo.outputPath("replay-floor-plan.png") });
});
test("live camera uses its uploaded floor plan with the same normalized table coordinates", async ({
  page,
}, testInfo) => {
  await live(page, "uploaded");
  await positionedOnImage(page);
  await selectAndSearch(page, true);
  await page
    .getByTestId("floor-map")
    .screenshot({ path: testInfo.outputPath("live-floor-plan.png") });
  await page.getByTestId("live-stop").click();
});
test("replay without a floor-plan asset retains the 1000 by 650 schematic and table search", async ({
  page,
}) => {
  await replay(page, false);
  await expect(page.getByTestId("floor-plan-image")).toHaveCount(0);
  await expect(page.getByTestId("floor-map")).toHaveAttribute(
    "aria-label",
    /schematic floor plan/,
  );
  const rectangle = page.getByTestId("table-T2").locator("rect").last();
  expect(
    Number(await rectangle.getAttribute("y")) +
      Number(await rectangle.getAttribute("height")) / 2,
  ).toBeCloseTo(0.75 * 650, 8);
  await selectAndSearch(page);
});
test("an explicit live schematic choice does not display a previously uploaded floor-plan asset", async ({
  page,
}) => {
  await live(page, "schematic");
  await expect(page.getByTestId("floor-plan-image")).toHaveCount(0);
  await expect(page.getByTestId("floor-map")).toHaveAttribute(
    "aria-label",
    /schematic floor plan/,
  );
  await selectAndSearch(page, true);
  await page.getByTestId("live-stop").click();
});
