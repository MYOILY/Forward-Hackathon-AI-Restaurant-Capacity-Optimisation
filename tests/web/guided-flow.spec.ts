import { expect, test, type Page } from "./browser-fixtures";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CalibrationTable, SourceInfo } from "../../shared/live-contracts";
import { objectBundle } from "./object-fixtures";

function initial(complete = false): SourceInfo {
  const original = objectBundle().tables[0];
  const table: CalibrationTable = {
    ...original,
    id: "T1",
    label: "Window",
    map: { x: 0.5, y: 0.5, w: 0.2, h: 0.2, shape: "rect" },
    setup_review: { tabletop: complete, occupancy: complete, map: complete },
    reference_t: 0,
  };
  if (!complete) {
    table.object_baseline = undefined;
    table.reference = null;
  }
  return {
    id: "flow-test",
    kind: "video",
    label: "Fixture recording",
    status: "needs_setup",
    phase: "Review setup",
    progress: 1,
    revision: 3,
    calibration_confirmed: false,
    setup_mode: "guided_v1",
    setup_reference: {
      reference_source: "video_frame",
      reference_t: 0,
      alignment_confirmed: false,
    },
    floor_plan_mode: "schematic",
    width: 1280,
    height: 720,
    fps: 10,
    duration_s: 42,
    tables: [table],
    frame_url: "/api/sources/browser-fixture/assets/original.png",
    media_url: "/api/sources/browser-fixture/assets/video.mp4",
  };
}
async function mount(page: Page, source = initial(), failFirst = false) {
  const saves: any[] = [];
  let analyses = 0,
    attempts = 0;
  const png = await readFile(
    path.resolve("tests/fixtures/workflow/original.png"),
  );
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
  await page.route("**/api/videos", (r) =>
    r.fulfill({ status: 202, json: source }),
  );
  await page.route("**/api/sources/flow-test", (r) =>
    r.fulfill({ json: source }),
  );
  await page.route("**/api/jobs/flow-test", (r) => r.fulfill({ json: source }));
  await page.route("**/api/sources/flow-test/assets/**", (r) =>
    r.fulfill({ body: png, contentType: "image/png" }),
  );
  await page.route("**/api/sources/flow-test/calibration", async (r) => {
    const body = r.request().postDataJSON();
    saves.push(body);
    expect(body.revision).toBe(source.revision);
    if (failFirst && attempts++ === 0) {
      await r.fulfill({ status: 500, json: { detail: "Fixture save failed" } });
      return;
    }
    source = {
      ...source,
      revision: source.revision + 1,
      tables: body.tables.map((t: CalibrationTable) =>
        t.object_baseline && !t.object_baseline.approved
          ? {
              ...t,
              object_baseline: undefined,
              expected_objects_draft: t.object_baseline.expected,
            }
          : t,
      ),
      setup_reference: body.setup_reference,
      floor_plan_mode: body.floor_plan_mode,
      calibration_confirmed: body.confirmed,
    };
    await r.fulfill({ json: source });
  });
  await page.route("**/api/sources/flow-test/baseline-proposal", (r) =>
    r.fulfill({
      json: {
        revision: source.revision,
        reference_t: 0,
        frame_base64: `data:image/png;base64,${png.toString("base64")}`,
        detections: [],
        baseline: {
          ...objectBundle().tables[0].object_baseline!,
          approved: false,
          expected: [],
        },
      },
    }),
  );
  await page.route("**/api/sources/flow-test/analyze", (r) => {
    analyses++;
    return r.fulfill({ status: 202, json: source });
  });
  await page.goto("/?setup=new");
  await page
    .getByTestId("source-upload")
    .setInputFiles(path.resolve("tests/fixtures/workflow/video.mp4"));
  await expect(page.getByTestId("calibration-editor")).toBeVisible();
  return { saves, source: () => source, analyses: () => analyses };
}
test("each table confirmation saves its updated snapshot and uses the returned revision", async ({
  page,
}) => {
  const state = await mount(page);
  for (const [index, step] of ["tabletop", "occupancy", "map"].entries()) {
    await expect(page.getByTestId(`table-step-${step}`)).toHaveAttribute(
      "aria-current",
      "step",
    );
    await page.getByTestId("setup-next").click();
    await expect.poll(() => state.saves.length).toBe(index + 1);
    expect(state.saves[index].revision).toBe(3 + index);
    expect(state.saves[index].confirmed).toBe(false);
    expect(state.saves[index].tables[0].setup_review).toEqual({
      tabletop: true,
      occupancy: index >= 1,
      map: index >= 2,
    });
  }
  await expect(page.getByTestId("table-step-objects")).toHaveAttribute(
    "aria-current",
    "step",
  );
  await page.getByTestId("baseline-propose").click();
  await expect(page.getByTestId("calibration-editor")).toContainText(
    "No objects detected. Review the photo and add any expected items.",
  );
  await page.getByTestId("setup-next").click();
  await expect.poll(() => state.saves.length).toBe(4);
  expect(state.saves[3].tables[0].reference_approved).toBe(true);
  expect(state.saves[3].tables[0].object_baseline.approved).toBe(true);
  await expect(
    page
      .locator(".guided-table-done")
      .getByRole("button", { name: "Review setup", exact: true }),
  ).toBeVisible();
  expect(state.analyses()).toBe(0);
});
test("failed save stays on the current step and retry retains the confirmed snapshot", async ({
  page,
}) => {
  const state = await mount(page, initial(), true);
  await page.getByTestId("calibration-label").fill("Corner table");
  await page.getByTestId("setup-next").click();
  await expect(page.getByRole("button", { name: "Retry save" })).toBeVisible();
  await expect(page.getByTestId("table-step-tabletop")).toHaveAttribute(
    "aria-current",
    "step",
  );
  await expect(page.getByTestId("calibration-label")).toHaveValue(
    "Corner table",
  );
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.getByTestId("table-step-occupancy")).toHaveAttribute(
    "aria-current",
    "step",
  );
  expect(state.saves[1]).toEqual(state.saves[0]);
  expect(state.saves[1].tables[0].setup_review.tabletop).toBe(true);
});
test("resume skips complete tables; partial corners survive switching tables and steps", async ({
  page,
}) => {
  const source = initial(true);
  source.tables.push({
    ...structuredClone(source.tables[0]),
    id: "T2",
    label: "Garden",
    object_baseline: undefined,
    reference: null,
    setup_review: { tabletop: true, occupancy: false, map: false },
  });
  await mount(page, source);
  await expect(page.getByTestId("calibration-label")).toHaveValue("Garden");
  await expect(page.getByTestId("table-step-occupancy")).toHaveAttribute(
    "aria-current",
    "step",
  );
  await page.getByTestId("table-step-tabletop").click();
  await page.getByTestId("draw-tabletop").click();
  const canvas = page.getByTestId("calibration-canvas");
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width * 0.2, y: box.height * 0.2 } });
  await canvas.click({ position: { x: box.width * 0.6, y: box.height * 0.2 } });
  await expect(
    page.getByText("2 of 4 corners marked", { exact: true }),
  ).toBeVisible();
  await page.getByTestId("table-step-map").click();
  await page.getByTestId("setup-table-T1").click();
  await page.getByTestId("setup-table-T2").click();
  await page.getByTestId("table-step-tabletop").click();
  await expect(
    page.getByText("2 of 4 corners marked", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("setup-next")).toBeDisabled();
});
test("editing map position clears only map review and preserves approved object evidence", async ({
  page,
}) => {
  const source = initial(true),
    before = structuredClone(source.tables[0]);
  const state = await mount(page, source);
  await page.getByRole("button", { name: "Edit table", exact: true }).click();
  await page.getByTestId("table-step-map").click();
  await page.getByTestId("floor-plan-editor").focus();
  await page.keyboard.press("ArrowRight");
  await page.getByTestId("calibration-save-draft").click();
  await expect.poll(() => state.saves.length).toBe(1);
  const saved = state.saves[0].tables[0];
  expect(saved.setup_review).toEqual({
    tabletop: true,
    occupancy: true,
    map: false,
  });
  expect(saved.map.x).toBeCloseTo(0.501);
  for (const key of [
    "geometry_sha256",
    "tabletop_polygon",
    "occupancy_regions",
    "object_baseline",
    "reference",
  ] as const)
    expect(saved[key]).toEqual(before[key]);
});

test("saving a draft retains unapproved proposal evidence in the mounted editor", async ({
  page,
}) => {
  const source = initial();
  source.tables[0].setup_review = {
    tabletop: true,
    occupancy: true,
    map: true,
  };
  const state = await mount(page, source);
  await page.getByTestId("baseline-propose").click();
  await expect(page.getByTestId("calibration-editor")).toContainText(
    "No objects detected. Review the photo and add any expected items.",
  );
  await page.getByTestId("calibration-save-draft").click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.source().tables[0].object_baseline).toBeUndefined();
  await expect(page.getByTestId("setup-next")).toBeEnabled();
  await page.getByTestId("setup-next").click();
  await expect.poll(() => state.saves.length).toBe(2);
  expect(state.saves[1].revision).toBe(4);
  expect(state.saves[1].tables[0].object_baseline.approved).toBe(true);
});
test("proposal errors preserve geometry and provide a retry path", async ({
  page,
}) => {
  const source = initial();
  source.tables[0].setup_review = {
    tabletop: true,
    occupancy: true,
    map: true,
  };
  const state = await mount(page, source);
  await page.route("**/api/sources/flow-test/baseline-proposal", (r) =>
    r.fulfill({
      status: 500,
      json: { detail: "Fixture inference unavailable" },
    }),
  );
  await page.getByTestId("baseline-propose").click();
  await expect(page.getByRole("alert")).toContainText(
    "Your drawing is still here; you can retry.",
  );
  await expect(page.getByTestId("baseline-propose")).toBeEnabled();
  await expect(page.getByTestId("setup-next")).toBeDisabled();
  await page.getByTestId("table-step-tabletop").click();
  await expect(page.getByTestId("calibration-handle-0")).toBeVisible();
  expect(state.saves).toHaveLength(0);
  expect(state.analyses()).toBe(0);
});
test("responsive guided editor preserves visible controls and captures design review evidence", async ({
  page,
}, testInfo) => {
  const source = initial();
  source.tables[0].setup_review = {
    tabletop: true,
    occupancy: true,
    map: false,
  };
  await mount(page, source);
  for (const [name, width, height] of [
    ["desktop", 1440, 1000],
    ["tablet", 820, 1180],
    ["mobile", 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.getByTestId("floor-plan-editor")).toBeVisible();
    await expect(page.getByTestId("setup-next")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`guided-map-${name}.png`),
      fullPage: true,
    });
    await page.getByTestId("table-step-tabletop").click();
    await page.screenshot({
      path: testInfo.outputPath(`guided-corners-${name}.png`),
      fullPage: true,
    });
    await page.getByTestId("table-step-map").click();
  }
});

test("revision conflict retains edits and never advances or overwrites newer work", async ({
  page,
}) => {
  const state = await mount(page);
  let attempts = 0;
  await page.route("**/api/sources/flow-test/calibration", (r) => {
    attempts++;
    return r.fulfill({
      status: 409,
      json: { detail: "Source revision changed. Reload the latest source." },
    });
  });
  await page.getByTestId("calibration-label").fill("My unsaved name");
  await page.getByTestId("setup-next").click();
  await expect(page.getByRole("alert")).toContainText(
    "Your edits are retained here",
  );
  await expect(page.getByTestId("calibration-label")).toHaveValue(
    "My unsaved name",
  );
  await expect(page.getByTestId("table-step-tabletop")).toHaveAttribute(
    "aria-current",
    "step",
  );
  expect(attempts).toBe(1);
  expect(state.source().revision).toBe(3);
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect.poll(() => attempts).toBe(2);
  expect(state.source().revision).toBe(3);
});
test("keyboard setup and leave dialog preserve work and manage focus", async ({
  page,
}) => {
  await mount(page);
  await page.getByTestId("calibration-add-table").click();
  const start = page.getByRole("button", {
    name: "Start rectangle & enter coordinates",
  });
  await start.focus();
  await page.keyboard.press("Enter");
  const x = page.getByRole("spinbutton", { name: "Point 1 X percent" });
  await expect(x).toBeVisible();
  await x.fill("30");
  await expect(page.getByTestId("setup-next")).toBeEnabled();
  await page
    .getByRole("button", { name: "Back to sources", exact: true })
    .click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Keep editing" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Leave with browser recovery" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(x).toHaveValue("30");
});
test("browser recovery restores partial corners on the first unfinished monitored table", async ({
  page,
}) => {
  const source = initial(true);
  source.tables.push({
    ...structuredClone(source.tables[0]),
    id: "T2",
    label: "Garden",
    object_baseline: undefined,
    reference: null,
    setup_review: { tabletop: false, occupancy: false, map: false },
  });
  await mount(page, source);
  await page.goto("/?setup=flow-test");
  await page.getByTestId("draw-tabletop").click();
  const canvas = page.getByTestId("calibration-canvas"),
    box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width * 0.2, y: box.height * 0.2 } });
  await expect(
    page.getByText("1 of 4 corners marked", { exact: true }),
  ).toBeVisible();
  page.on("dialog", (d) => d.accept());
  await page.reload();
  await page
    .getByRole("button", { name: "Restore my edits", exact: true })
    .click();
  await expect(page.getByTestId("calibration-label")).toHaveValue("Garden");
  await expect(page.getByTestId("table-step-tabletop")).toHaveAttribute(
    "aria-current",
    "step",
  );
  await expect(
    page.getByText("1 of 4 corners marked", { exact: true }),
  ).toBeVisible();
});
