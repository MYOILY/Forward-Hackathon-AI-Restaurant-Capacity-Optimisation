import { test, expect, type Page } from "./browser-fixtures";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { liveConfig } from "./live-fixtures";
import type { SourceInfo } from "../../shared/live-contracts";

const pngPath = path.resolve("tests/fixtures/workflow/original.png");
const videoPath = path.resolve("tests/fixtures/workflow/video.mp4");
const baseSource = (): SourceInfo => ({
  id: "fresh-restaurant",
  kind: "video",
  label: "My recording.mp4",
  status: "needs_setup",
  phase: "Review setup",
  progress: 1,
  revision: 0,
  calibration_confirmed: false,
  setup_mode: "guided_v1",
  width: 1280,
  height: 720,
  fps: 10,
  duration_s: 42,
  tables: [],
  frame_url: "/api/sources/browser-fixture/assets/original.png",
  media_url: "/api/sources/browser-fixture/assets/video.mp4",
});
async function fixtures(page: Page, initial = baseSource()) {
  let source = initial;
  const uploads: { kind: string; revision: string }[] = [],
    saves: Record<string, unknown>[] = [],
    proposals: Record<string, unknown>[] = [];
  let analyses = 0,
    sampleRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/bundle.json"))
      sampleRequests++;
  });
  const png = await readFile(pngPath);
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        available: true,
        models: { detector: { available: true }, surface: { available: true } },
        limits: { upload_bytes: 1e9, duration_s: 600, frame_bytes: 2097152 },
      },
    }),
  );
  await page.route("**/api/jobs", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/cameras", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/videos", (route) =>
    route.fulfill({ status: 202, json: source }),
  );
  await page.route("**/api/sources/fresh-restaurant", (route) =>
    route.fulfill({ json: source }),
  );
  await page.route("**/api/jobs/fresh-restaurant", (route) =>
    route.fulfill({ json: source }),
  );
  await page.route("**/api/sources/fresh-restaurant/assets/**", (route) =>
    route.fulfill({ body: png, contentType: "image/png" }),
  );
  await page.route(
    "**/api/sources/fresh-restaurant/setup-assets/*",
    async (route) => {
      const kind = new URL(route.request().url()).pathname.split("/").pop() as
        | "clean_reference"
        | "floor_plan";
      const body = route.request().postDataBuffer()!.toString("latin1");
      const revision =
        body.match(/name="revision"\r\n\r\n(\d+)/)?.[1] ?? "missing";
      uploads.push({ kind, revision });
      expect(revision).toBe(String(source.revision));
      source = {
        ...source,
        revision: source.revision + 1,
        setup_assets: {
          ...source.setup_assets,
          [kind]: {
            file: `setup/${kind}.png`,
            sha256: (kind === "clean_reference" ? "a" : "b").repeat(64),
            width: kind === "floor_plan" ? 1000 : 1280,
            height: kind === "floor_plan" ? 500 : 720,
          },
        },
      };
      await route.fulfill({ json: source });
    },
  );
  await page.route("**/api/sources/fresh-restaurant/frame", (route) =>
    route.fulfill({
      json: {
        url: "/api/sources/browser-fixture/assets/original.png",
        t: 1.2,
        sha256: "d".repeat(64),
        width: 1280,
        height: 720,
      },
    }),
  );
  await page.route(
    "**/api/sources/fresh-restaurant/baseline-proposal",
    async (route) => {
      const body = route.request().postDataJSON();
      proposals.push(body);
      expect(body.revision).toBe(source.revision);
      await route.fulfill({
        json: {
          revision: source.revision,
          reference_t: 0,
          frame_base64: `data:image/png;base64,${png.toString("base64")}`,
          detections: [{ class_id: 41, score: 0.9, box: [0.2, 0.2, 0.4, 0.4] }],
          baseline: {
            version: 1,
            approved: false,
            expected: [{ class_id: 41, count: 1 }],
            reference_sha256: "c".repeat(64),
            geometry_sha256: "d".repeat(64),
            detector_sha256: "e".repeat(64),
            config_sha256: "f".repeat(64),
            baseline_sha256: "a".repeat(64),
            reviewed_by: "operator_setup_approval",
          },
        },
      });
    },
  );
  await page.route(
    "**/api/sources/fresh-restaurant/calibration",
    async (route) => {
      const body = route.request().postDataJSON();
      saves.push(body);
      expect(body.revision).toBe(source.revision);
      source = {
        ...source,
        revision: source.revision + 1,
        calibration_confirmed: body.confirmed,
        floor_plan_mode: body.floor_plan_mode,
        setup_reference: body.setup_reference,
        tables: body.tables.map((table: SourceInfo["tables"][number]) =>
          !table.reference_approved && table.object_baseline
            ? {
                ...table,
                object_baseline: undefined,
                expected_objects_draft: table.object_baseline.expected,
              }
            : table,
        ),
      };
      await route.fulfill({ json: source });
    },
  );
  await page.route("**/api/sources/fresh-restaurant/analyze", (route) => {
    analyses++;
    return route.fulfill({
      status: 202,
      json: { ...source, status: "analyzing" },
    });
  });
  return {
    uploads,
    saves,
    proposals,
    source: () => source,
    analyses: () => analyses,
    sampleRequests: () => sampleRequests,
  };
}
async function uploadRecording(page: Page) {
  await page.goto("/?setup=new");
  await page.getByTestId("source-upload").setInputFiles(videoPath);
  await expect(
    page.getByRole("button", { name: "Reference & floor plan", exact: true }),
  ).toHaveClass(/active/);
}
async function selectAssets(page: Page) {
  await page.getByLabel("Upload a clean photo", { exact: true }).check();
  await page.getByTestId("clean-reference-upload").setInputFiles(pngPath);
  await expect(page.getByTestId("reference-alignment-confirmed")).toBeVisible();
  await expect(page.getByTestId("setup-next")).toBeDisabled();
  await page.getByTestId("reference-alignment-confirmed").check();
  await page.getByTestId("floor-plan-upload").setInputFiles(pngPath);
  await expect(page.getByTestId("setup-next")).toBeEnabled();
  await page.getByTestId("setup-next").click();
}
async function markTable(page: Page) {
  await expect(page.getByTestId("setup-no-tables")).toContainText(
    "No tables marked",
  );
  await page.getByTestId("calibration-add-table").click();
  await page.getByTestId("calibration-label").fill("Window table");
  await expect(page.getByTestId("calibration-source-image")).toHaveAttribute(
    "href",
    /clean_reference/,
  );
  const canvas = page.getByTestId("calibration-canvas");
  const box = (await canvas.boundingBox())!;
  for (const [x, y] of [
    [0.2, 0.2],
    [0.7, 0.2],
    [0.7, 0.7],
    [0.2, 0.7],
  ])
    await canvas.click({ position: { x: box.width * x, y: box.height * y } });
  await expect(page.getByTestId("calibration-handle-0")).toBeVisible();
  await page.getByTestId("setup-next").click();
  await expect(page.getByTestId("table-step-occupancy")).toHaveAttribute(
    "aria-current",
    "step",
  );
  await expect(page.getByTestId("calibration-source-image")).toHaveAttribute(
    "href",
    "/api/sources/browser-fixture/assets/original.png",
  );
  await page.getByTestId("setup-next").click();
  await expect(page.getByTestId("floor-plan-background")).toHaveAttribute(
    "href",
    /floor_plan/,
  );
  const marker = (await page
    .getByRole("button", { name: "Select Window table", exact: true })
    .boundingBox())!;
  await page.mouse.move(
    marker.x + marker.width / 2,
    marker.y + marker.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    marker.x + marker.width / 2 + 30,
    marker.y + marker.height / 2 + 20,
    { steps: 3 },
  );
  await page.mouse.up();
  await page.getByTestId("setup-next").click();
  await expect(page.getByTestId("table-step-objects")).toHaveAttribute(
    "aria-current",
    "step",
  );
}

test("Fresh route asks for inputs and never fetches an old demonstration", async ({
  page,
}) => {
  const state = await fixtures(page);
  await page.goto("/?setup=new");
  await expect(page.getByTestId("fresh-setup-prompt")).toBeVisible();
  await expect(page.getByTestId("source-upload")).toBeAttached();
  await expect(page.getByTestId("video")).toHaveCount(0);
  expect(state.sampleRequests()).toBe(0);
  expect(state.analyses()).toBe(0);
});

test("Guided setup uploads references, marks matching table IDs, and separates approval from analysis", async ({
  page,
}, testInfo) => {
  const state = await fixtures(page);
  await uploadRecording(page);
  await selectAssets(page);
  await markTable(page);
  await expect(page.getByTestId("setup-next")).toBeDisabled();
  await page.getByTestId("baseline-propose").click();
  await expect(page.getByTestId("expected-count-41")).toHaveValue("1");
  expect(state.proposals[0]).toMatchObject({
    reference_source: "uploaded_image",
    reference_image_sha256: "a".repeat(64),
    alignment_confirmed: true,
    reference_t: null,
    revision: 6,
  });
  await expect(page.getByTestId("setup-next")).toBeEnabled();
  await expect(page.getByTestId("calibration-editor")).not.toContainText(
    "Reference selected at 0.00",
  );
  await page.screenshot({
    path: testInfo.outputPath("guided-objects-review.png"),
    fullPage: true,
  });
  await page.getByTestId("setup-next").click();
  await page
    .getByRole("button", { name: "Review setup", exact: true })
    .first()
    .click();
  await page.getByTestId("calibration-save").click();
  await expect.poll(() => state.saves.length).toBe(6);
  const table = state.source().tables[0];
  expect(table.label).toBe("Window table");
  expect(table.setup_review).toEqual({
    tabletop: true,
    occupancy: true,
    map: true,
  });
  expect(table.map.x).not.toBe(0.5);
  expect(state.saves[5]).toMatchObject({
    confirmed: true,
    setup_mode: "guided_v1",
    floor_plan_mode: "uploaded",
    revision: 7,
  });
  expect(state.analyses()).toBe(0);
  await expect(page.getByTestId("analyze-source")).toBeEnabled();
  await page.getByTestId("analyze-source").click();
  await expect.poll(() => state.analyses()).toBe(1);
});

test("Asset-only drafts and incomplete table drafts remain reviewable without starting analysis", async ({
  page,
}) => {
  const state = await fixtures(page);
  await uploadRecording(page);
  await selectAssets(page);
  await page.getByTestId("calibration-save-draft").click();
  await expect.poll(() => state.saves.length).toBe(2);
  expect(state.saves[1]).toMatchObject({
    confirmed: false,
    tables: [],
    floor_plan_mode: "uploaded",
  });
  await expect(page.getByTestId("setup-no-tables")).toContainText(
    "No tables marked",
  );
  await expect(page.getByTestId("analyze-source")).toHaveCount(0);
  expect(state.analyses()).toBe(0);
  await page.getByRole("button", { name: /^Set up tables/ }).click();
  await page.getByTestId("calibration-add-table").click();
  await page.getByTestId("draw-tabletop").click();
  await page.getByTestId("calibration-label").fill("Keep my draft name");
  await page
    .getByRole("button", { name: "Reference & floor plan", exact: true })
    .click();
  await page.getByTestId("floor-plan-upload").setInputFiles(pngPath);
  await page.getByRole("button", { name: /^Set up tables/ }).click();
  await expect(page.getByTestId("calibration-label")).toHaveValue(
    "Keep my draft name",
  );
  await page.getByTestId("calibration-save-draft").click();
  await expect.poll(() => state.saves.length).toBe(3);
  expect(state.saves[2].revision).toBe(5);
  expect(state.source().tables[0].setup_review).toEqual({
    tabletop: false,
    occupancy: false,
    map: false,
  });
  await expect(page.getByTestId("draft-save-status")).toContainText(
    "unfinished corners",
  );
  expect(state.analyses()).toBe(0);
});

test("Video-frame reference and explicit schematic fallback are an alternative to uploaded images", async ({
  page,
}) => {
  const state = await fixtures(page);
  await uploadRecording(page);
  await page.getByTestId("calibration-frame-time").fill("1.2");
  await page.getByTestId("reference-use-frame").click();
  await expect(page.getByTestId("setup-next")).toBeDisabled();
  await page.getByTestId("schematic-floor-plan").check();
  await page.getByTestId("setup-next").click();
  await expect(page.getByTestId("setup-no-tables")).toBeVisible();
  await page.getByTestId("calibration-save-draft").click();
  expect(state.saves[0]).toMatchObject({
    floor_plan_mode: "schematic",
    confirmed: false,
  });
  expect(state.uploads).toHaveLength(0);
});

test("Source setup deep link opens its existing setup without loading a sample", async ({
  page,
}) => {
  const state = await fixtures(page);
  await page.goto("/?setup=fresh-restaurant");
  await expect(page.getByTestId("calibration-editor")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reference & floor plan", exact: true }),
  ).toHaveClass(/active/);
  expect(state.sampleRequests()).toBe(0);
});

test("An empty healthy service opens guided setup from the default URL", async ({
  page,
}) => {
  const state = await fixtures(page);
  await page.goto("/");
  await expect(page.getByTestId("fresh-setup-prompt")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  expect(state.sampleRequests()).toBe(0);
  await expect(page.getByTestId("video")).toHaveCount(0);
});

test("An unavailable service stays on fresh setup and shows a recoverable error", async ({
  page,
}) => {
  await fixtures(page);
  await page.route("**/api/health", (route) =>
    route.abort("connectionrefused"),
  );
  await page.route("**/api/jobs", (route) => route.abort("connectionrefused"));
  await page.goto("/");
  await expect(page.getByTestId("fresh-setup-prompt")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("service unavailable");
  await expect(page.getByTestId("video")).toHaveCount(0);
});

test("A zero-table draft remembers its uploaded reference choice and alignment review", async ({
  page,
}) => {
  const state = await fixtures(page);
  await uploadRecording(page);
  await selectAssets(page);
  await page.getByTestId("calibration-save-draft").click();
  await expect.poll(() => state.saves.length).toBe(2);
  expect(state.saves[1].setup_reference).toEqual({
    reference_source: "uploaded_image",
    reference_t: null,
    reference_image_sha256: "a".repeat(64),
    alignment_confirmed: true,
  });
  await page
    .getByRole("button", { name: "Reference & floor plan", exact: true })
    .click();
  await expect(
    page.getByLabel("Upload a clean photo", { exact: true }),
  ).toBeChecked();
  await expect(page.getByTestId("reference-alignment-confirmed")).toBeChecked();
  await expect(page.getByTestId("setup-next")).toBeEnabled();
});

test("A saved nonzero reference time restores the actual selected frame without invalidating reviews", async ({
  page,
}) => {
  const source = baseSource();
  source.floor_plan_mode = "schematic";
  source.setup_reference = {
    reference_source: "video_frame",
    reference_t: 3.2,
    alignment_confirmed: false,
  };
  const table = {
    ...liveConfig(true).tables[0],
    reference: null,
    reference_t: 3.2,
    setup_review: { tabletop: true, occupancy: true, map: true },
  };
  source.tables = [table];
  const state = await fixtures(page, source);
  const captures: number[] = [];
  await page.route("**/api/sources/fresh-restaurant/frame", (route) => {
    captures.push(route.request().postDataJSON().t);
    return route.fulfill({
      json: {
        url: "/api/sources/fresh-restaurant/assets/frame-at-3.2.png",
        t: 3.2,
      },
    });
  });
  await page.goto("/?setup=fresh-restaurant");
  await page.getByRole("button", { name: /^Set up tables/ }).click();
  await page.getByTestId("table-step-tabletop").click();
  await expect(page.getByTestId("calibration-source-image")).toHaveAttribute(
    "href",
    /frame-at-3.2.png/,
  );
  expect(captures.every((t) => t === 3.2)).toBe(true);
  await page.getByTestId("calibration-save-draft").click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.source().tables[0].setup_review).toEqual({
    tabletop: true,
    occupancy: true,
    map: true,
  });
  expect(state.source().setup_reference?.reference_t).toBe(3.2);
});

test("Draft quantities are restored only after a new proposal and cannot be edited during inference", async ({
  page,
}) => {
  const source = baseSource();
  source.floor_plan_mode = "schematic";
  source.setup_reference = {
    reference_source: "video_frame",
    reference_t: 0,
    alignment_confirmed: false,
  };
  source.tables = [
    {
      ...liveConfig(true).tables[0],
      reference: null,
      reference_t: 0,
      expected_objects_draft: [{ class_id: 41, count: 3 }],
      setup_review: { tabletop: true, occupancy: true, map: true },
    },
  ];
  const state = await fixtures(page, source);
  await page.goto("/?setup=fresh-restaurant");
  await expect(page.getByTestId("saved-inventory-draft")).toContainText(
    "cup × 3",
  );
  await expect(page.getByTestId("expected-count-41")).toHaveCount(0);
  await page.getByTestId("baseline-propose").click();
  await expect(page.getByTestId("expected-count-41")).toHaveValue("3");
  await expect(page.getByTestId("setup-next")).toBeEnabled();
  await page.getByTestId("expected-count-41").fill("4");
  let release: (() => void) | undefined;
  await page.route(
    "**/api/sources/fresh-restaurant/baseline-proposal",
    async (route) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({
        json: {
          revision: source.revision,
          reference_t: 0,
          frame_base64: "data:image/png;base64,AAAA",
          detections: [],
          baseline: {
            version: 1,
            approved: false,
            expected: [{ class_id: 41, count: 1 }],
            reference_sha256: "c".repeat(64),
            geometry_sha256: "d".repeat(64),
            detector_sha256: "e".repeat(64),
            config_sha256: "f".repeat(64),
            baseline_sha256: "a".repeat(64),
            reviewed_by: "fixture",
          },
        },
      });
    },
  );
  await page.getByTestId("baseline-propose").click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await expect(page.getByTestId("expected-count-41")).toBeDisabled();
  await expect(page.getByTestId("setup-next")).toBeDisabled();
  release!();
  await expect(page.getByTestId("expected-count-41")).toBeEnabled();
  await expect(page.getByTestId("expected-count-41")).toHaveValue("4");
  await page.getByTestId("calibration-save-draft").click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.source().tables[0].expected_objects_draft).toEqual([
    { class_id: 41, count: 4 },
  ]);
  await page.getByTestId("table-step-tabletop").click();
  const handle = (await page
    .getByTestId("calibration-handle-0")
    .boundingBox())!;
  await page.mouse.move(handle.x + 4, handle.y + 4);
  await page.mouse.down();
  await page.mouse.move(handle.x + 20, handle.y + 10, { steps: 3 });
  await page.mouse.up();
  await page.getByTestId("table-step-objects").click();
  await expect(page.getByTestId("saved-inventory-draft")).toHaveCount(0);
});

test("An explicitly unselected video reference stays unselected when an old clean-photo asset exists", async ({
  page,
}) => {
  const source = baseSource();
  source.floor_plan_mode = "schematic";
  source.setup_reference = {
    reference_source: "video_frame",
    reference_t: null,
    alignment_confirmed: false,
  };
  source.setup_assets = {
    clean_reference: {
      file: "setup/clean_reference.png",
      sha256: "a".repeat(64),
      width: 1280,
      height: 720,
    },
  };
  const state = await fixtures(page, source);
  await page.goto("/?setup=fresh-restaurant");
  await expect(
    page.getByLabel("Select a recording frame", { exact: true }),
  ).toBeChecked();
  await expect(page.getByTestId("setup-next")).toBeDisabled();
  await expect(page.getByTestId("calibration-editor")).toContainText(
    "Select a clean frame to continue.",
  );
  await page.getByTestId("calibration-save-draft").click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0].setup_reference).toEqual({
    reference_source: "video_frame",
    reference_t: null,
    alignment_confirmed: false,
  });
});

test("Missing CPU models keep manual setup available from the root screen", async ({
  page,
}) => {
  await fixtures(page);
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        available: true,
        models: {
          detector: {
            available: false,
            reason: "CPU models are not installed",
          },
          surface: { available: false },
        },
        limits: { upload_bytes: 1e9, duration_s: 600, frame_bytes: 2097152 },
      },
    }),
  );
  let uploadedManually = false;
  await page.route("**/api/videos", (route) => {
    uploadedManually = /name="manual_setup"\r\n\r\ntrue/.test(
      route.request().postDataBuffer()!.toString("latin1"),
    );
    return route.fulfill({ status: 202, json: baseSource() });
  });
  await page.goto("/");
  await expect(page.getByTestId("model-availability")).toContainText(
    "prepare your setup",
  );
  await page.getByTestId("manual-setup-upload").check();
  await page.getByTestId("source-upload").setInputFiles(videoPath);
  await expect(page.getByTestId("calibration-editor")).toBeVisible();
  expect(uploadedManually).toBe(true);
  await expect(page.getByTestId("video")).toHaveCount(0);
});
