import { approveObjects } from "./baseline-fixtures";
import { test, expect, type Page } from "./browser-fixtures";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Bundle, AssessmentRequest } from "../../shared/contracts";
import { assessment } from "./replay-fixtures";

async function independentBundle(count = 7): Promise<Bundle> {
  // Source assets only: expected events below are authored here, never read from root demo observations.
  const assets = JSON.parse(
    await readFile(path.resolve("tests/fixtures/workflow/bundle.json"), "utf8"),
  ) as Bundle;
  const source = structuredClone(assets.tables[0]);
  assets.tables = Array.from({ length: count }, (_, index) => ({
    ...structuredClone(source),
    id: `T${index + 1}`,
    label: `Table ${index + 1}`,
    map: {
      ...source.map,
      x: 0.1 + (index % 6) * 0.15,
      y: 0.1 + Math.floor(index / 6) * 0.16,
      w: 0.09,
      h: 0.08,
    },
  }));
  assets.tables.forEach((table) => approveObjects(table));
  assets.staff_events = [];
  assets.assessment_requests = [];
  assets.assessments = [];
  assets.observations = Array.from(
    { length: Math.floor(assets.video.duration_s * 10) },
    (_, index) => {
      const t = index / 10,
        occupied = t >= 10 && t < 20;
      return {
        t,
        frame_index: Math.round(t * assets.video.fps),
        valid: true,
        detections: [],
        tables: Object.fromEntries(
          assets.tables.map((table) => [
            table.id,
            table.id === "T1" && occupied ? "present" : "absent",
          ]),
        ),
        surface: Object.fromEntries(
          assets.tables.map((table) => [
            table.id,
            { visible: true, changed: false },
          ]),
        ),
        tracks: occupied
          ? [
              {
                track_id: "independent:person-1",
                box: [0.1, 0.1, 0.2, 0.8],
                score: 0.9,
                observed: true,
                table_id: "T1",
                candidate_table_ids: ["T1"],
              },
            ]
          : [],
      };
    },
  );
  for (const table of assets.tables) {
    for (const t of [5, 7]) {
      const request: AssessmentRequest = {
        id: `independent:${table.id}:${t}`,
        table_id: table.id,
        t,
        frame_index: Math.round(t * assets.video.fps),
        generation: 0,
        video_sha256: assets.video.sha256,
        geometry_sha256: table.geometry_sha256!,
        reference_sha256: table.reference!.sha256!,
        surface_method: table.surface_method,
        baseline_sha256: table.object_baseline!.baseline_sha256,
        config_sha256: table.object_baseline!.config_sha256,
      };
      assets.assessment_requests.push(request);
      assets.assessments.push({
        ...assessment(request),
        crop_file: table.reference!.file,
        crop_sha256: table.reference!.sha256!,
      });
    }
  }
  return assets;
}
async function seek(page: Page, t: number) {
  await page.getByTestId("video").evaluate(async (element, time) => {
    const video = element as HTMLVideoElement;
    video.pause();
    if (Math.abs(video.currentTime - time) < 0.001) {
      video.dispatchEvent(new Event("timeupdate"));
      return;
    }
    await new Promise<void>((resolve) => {
      video.addEventListener("seeked", () => resolve(), { once: true });
      video.currentTime = time;
    });
  }, t);
}
async function load(page: Page, bundle: Bundle) {
  await page.route(
    "**/api/sources/browser-fixture/assets/bundle.json",
    (route) => route.fulfill({ json: bundle }),
  );
  await page.goto("/?source=browser-fixture");
  await expect(page.getByTestId("table-T1")).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByTestId("video")
        .evaluate((element) => (element as HTMLVideoElement).readyState),
    )
    .toBeGreaterThanOrEqual(2);
}

test("B01 B02 B06 B17 automatic states follow source time and backwards seek discards future clearance", async ({
  page,
}) => {
  await load(page, await independentBundle());
  await expect(page.getByTestId("selected-status")).toContainText("Verifying");
  await expect(page.getByTestId("table-detail")).not.toContainText(
    "Check table",
  );
  await seek(page, 5);
  await expect(page.getByTestId("surface-state")).toContainText("Unverified");
  await seek(page, 7);
  await expect(page.getByTestId("table-T1")).toHaveAttribute(
    "aria-label",
    /ready|empty.*cleaned/i,
  );
  await seek(page, 10);
  await expect(page.getByTestId("people-state")).toContainText(
    "Arrival pending",
  );
  await expect(page.getByTestId("selected-status")).toContainText("Verifying");
  await seek(page, 15);
  await expect(page.getByTestId("people-state")).toContainText("Occupied");
  await expect(page.getByTestId("surface-state")).toContainText("Unverified");
  await expect(page.getByTestId("table-T1")).toHaveAttribute(
    "aria-label",
    /occupied/i,
  );
  const current = await page
    .getByTestId("current-crop")
    .evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  await page.waitForTimeout(250);
  expect(
    await page
      .getByTestId("current-crop")
      .evaluate((element) => (element as HTMLCanvasElement).toDataURL()),
  ).toBe(current);
  await seek(page, 6);
  await expect(page.getByTestId("selected-status")).toContainText("Verifying");
  await expect(page.getByTestId("current-crop")).toHaveAttribute(
    "aria-label",
    /00:06/,
  );
  await page.getByTestId("restart").click();
  await expect
    .poll(() =>
      page
        .getByTestId("video")
        .evaluate((element) => (element as HTMLVideoElement).currentTime),
    )
    .toBe(0);
  await expect(page.getByTestId("selected-status")).toContainText("Verifying");
});

test("B18 table-only angled layouts remain selectable for 1, 3, 7, 15 and 30 tables", async ({
  page,
}) => {
  for (const count of [1, 3, 7, 15, 30]) {
    await page.unroute("**/api/sources/browser-fixture/assets/bundle.json");
    await load(page, await independentBundle(count));
    await expect(
      page.getByTestId("floor-map").locator('[data-testid^="table-T"]'),
    ).toHaveCount(count);
    await expect(page.locator('[class*="chair"]')).toHaveCount(0);
    await page.getByTestId("table-search").fill(`T${count}`);
    await page.getByTestId(`table-list-T${count}`).click();
    await expect(page.getByTestId("current-crop")).toHaveAttribute(
      "aria-label",
      new RegExp(`T${count} current`),
    );
    await page.getByTestId("map-zoom-in").click();
    await page.getByTestId("map-fit-all").click();
    await expect(page.getByTestId("table-detail")).not.toContainText(
      /capacity|seats/i,
    );
  }
});

for (const rate of [2, 3])
  test(`B17 ${rate}x automatic playback advances five-second dwell using source clock`, async ({
    page,
  }, testInfo) => {
    await load(page, await independentBundle());
    await seek(page, 10);
    await page.getByTestId("playback-speed").selectOption(String(rate));
    const start = performance.now();
    await page.getByTestId("play-toggle").click();
    await expect(page.getByTestId("table-T1")).toHaveAttribute(
      "aria-label",
      /occupied/i,
      { timeout: 7000 },
    );
    await page.getByTestId("play-toggle").click();
    const t = await page
      .getByTestId("video")
      .evaluate((element) => (element as HTMLVideoElement).currentTime);
    expect(t).toBeGreaterThanOrEqual(15);
    expect(t).toBeLessThan(19);
    const timingPath = testInfo.outputPath("playback-timing.json");
    await writeFile(
      timingPath,
      JSON.stringify({
        provenance: "synthetic_fixture",
        playback_rate: rate,
        video_start_s: 10,
        video_end_s: t,
        video_advance_s: t - 10,
        wall_elapsed_s: (performance.now() - start) / 1000,
        measurement: "Browser playback only; not inference throughput.",
      }),
    );
    await testInfo.attach("playback-timing", {
      path: timingPath,
      contentType: "application/json",
    });
  });

test("B17 B18 current picture rectifies an angled tabletop to the reference corner orientation", async ({
  page,
}) => {
  const root = path.resolve("tests/fixtures/perspective");
  const manifest = JSON.parse(
    await readFile(path.join(root, "manifest.json"), "utf8"),
  );
  const bundle = await independentBundle(1);
  bundle.video = {
    file: "markers.mp4",
    sha256: manifest.video_sha256,
    width: 160,
    height: 120,
    fps: 10,
    duration_s: 8,
  };
  bundle.original_scene = null;
  bundle.tables[0].tabletop_polygon = manifest.tabletop_polygon;
  bundle.tables[0].crop = [0, 0, 1, 1];
  bundle.tables[0].geometry_sha256 = createHash("sha256")
    .update(
      JSON.stringify({
        occupancy_regions: bundle.tables[0].occupancy_regions,
        tabletop_polygon: manifest.tabletop_polygon,
      }),
    )
    .digest("hex");
  bundle.tables[0].reference = {
    file: "independent-reference.png",
    source_t: 0,
    confirmed_clean: true,
    sha256: manifest.reference_sha256,
  };
  approveObjects(bundle.tables[0]);
  bundle.observations = bundle.observations.filter((o) => o.t < 8);
  bundle.assessments = [];
  bundle.assessment_requests = [];
  await page.route(
    "**/api/sources/browser-fixture/assets/markers.mp4",
    async (route) =>
      route.fulfill({
        body: await readFile(path.join(root, "markers.mp4")),
        contentType: "video/mp4",
      }),
  );
  await page.route(
    "**/api/sources/browser-fixture/assets/independent-reference.png",
    async (route) =>
      route.fulfill({
        body: await readFile(path.join(root, "reference.png")),
        contentType: "image/png",
      }),
  );
  await load(page, bundle);
  await seek(page, 1);
  const corners = await page.getByTestId("current-crop").evaluate((element) => {
    const c = element as HTMLCanvasElement,
      context = c.getContext("2d")!;
    return [
      [0.1, 0.1],
      [0.9, 0.1],
      [0.9, 0.9],
      [0.1, 0.9],
    ].map(([x, y]) =>
      Array.from(
        context.getImageData(
          Math.floor(c.width * x),
          Math.floor(c.height * y),
          1,
          1,
        ).data,
      ).slice(0, 3),
    );
  });
  const expected = [
    [230, 30, 30],
    [30, 220, 30],
    [30, 30, 230],
    [220, 220, 30],
  ];
  for (let corner = 0; corner < 4; corner++)
    for (let channel = 0; channel < 3; channel++)
      expect(
        Math.abs(corners[corner][channel] - expected[corner][channel]),
      ).toBeLessThan(25);
  const paused = await page
    .getByTestId("current-crop")
    .evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  await page.waitForTimeout(250);
  expect(
    await page
      .getByTestId("current-crop")
      .evaluate((element) => (element as HTMLCanvasElement).toDataURL()),
  ).toBe(paused);
});

for (const kind of ["reference", "assessment crop"] as const) {
  test(`B19 tampered ${kind} file bytes reject the bundle before use`, async ({
    page,
  }) => {
    const bundle = await independentBundle(1);
    const reference = bundle.tables[0].reference!;
    let target = reference.file;
    if (kind === "assessment crop") {
      const result = bundle.assessments![0];
      result.crop_file = "tampered-crop.png";
      result.crop_sha256 = reference.sha256!;
      target = result.crop_file;
      bundle.assessments = [result];
      bundle.assessment_requests = [bundle.assessment_requests![0]];
    } else {
      bundle.assessments = [];
      bundle.assessment_requests = [];
    }
    await page.route(
      `**/api/sources/browser-fixture/assets/${target}`,
      (route) =>
        route.fulfill({
          body: Buffer.from("intentionally incorrect image bytes"),
          contentType: "image/png",
        }),
    );
    await page.route(
      "**/api/sources/browser-fixture/assets/bundle.json",
      (route) => route.fulfill({ json: bundle }),
    );
    await page.goto("/?source=browser-fixture");
    await expect(page.getByTestId("bundle-error")).toContainText(
      /hash|sha|match/i,
    );
    await expect(page.getByTestId("bundle-error")).toContainText(target);
  });
}

test("B13 predicted track overlay is marked as prediction and skipped surface analysis remains explicit", async ({
  page,
}) => {
  const bundle = await independentBundle(1);
  bundle.analysis.surface_analysis_complete = false;
  bundle.analysis.surface_model_skipped = true;
  for (const observation of bundle.observations) {
    observation.tracks = [
      {
        track_id: "independent:retained",
        box: [0.2, 0.1, 0.4, 0.8],
        score: 0.9,
        observed: false,
        table_id: "T1",
        candidate_table_ids: ["T1"],
      },
    ];
    observation.tables.T1 = "absent";
  }
  bundle.assessments = [];
  bundle.assessment_requests = [];
  await load(page, bundle);
  await seek(page, 1);
  await expect(page.getByTestId("surface-analysis-notice")).toContainText(
    /not run|skipped/i,
  );
  await expect(page.locator('[data-track-state="predicted"]')).toBeVisible();
  await expect(page.getByTestId("selected-status")).toContainText("Verifying");
});

test("Force clean overrides only surface checks, records staff provenance, and resets with replay", async ({
  page,
}) => {
  const bundle = await independentBundle(1);
  bundle.assessments = [];
  bundle.assessment_requests = [];
  bundle.tables[0].reference = null;
  delete bundle.tables[0].object_baseline;
  for (const observation of bundle.observations) {
    observation.surface!.T1.visible = false;
    observation.surface!.T1.camera_moved = true;
  }
  await load(page, bundle);
  await seek(page, 6);
  await expect(page.getByTestId("confirm-cleaned")).toBeDisabled();
  await expect(page.getByTestId("force-cleaned")).toBeEnabled();
  await page.getByTestId("force-cleaned").click();
  await expect(page.getByTestId("selected-status")).toContainText(/ready/i);
  await expect(page.getByTestId("table-detail")).toContainText(
    /staff override/i,
  );
  await expect(page.getByTestId("event-log")).toContainText(/override/i);
  await seek(page, 10);
  await expect(page.getByTestId("selected-status")).toContainText("Verifying");
  await expect(page.getByTestId("force-cleaned")).toBeDisabled();
  await seek(page, 15);
  await expect(page.getByTestId("selected-status")).toContainText("Occupied");
  await expect(page.getByTestId("force-cleaned")).toBeDisabled();
  await seek(page, 5);
  await expect(page.getByTestId("selected-status")).toContainText("Verifying");
  await seek(page, 6);
  await expect(page.getByTestId("selected-status")).toContainText(/ready/i);
  await page.getByTestId("restart").click();
  await seek(page, 6);
  await expect(page.getByTestId("selected-status")).toContainText("Verifying");
});

test("Manual colour controls preserve observed evidence and Auto restores the current automatic status", async ({
  page,
}) => {
  await load(page, await independentBundle(1));
  await seek(page, 15);
  for (const [control, label] of [
    ["green", "Ready"],
    ["red", "Needs cleaning"],
    ["grey", "Grey"],
    ["yellow", "Occupied"],
  ]) {
    await page.getByTestId(`override-${control}`).click();
    await expect(page.getByTestId("selected-status")).toContainText(
      new RegExp(label, "i"),
    );
    await expect(page.getByTestId("manual-override")).toContainText(
      /manual override/i,
    );
    await expect(page.getByTestId("people-state")).toContainText("Occupied");
    await expect(page.getByTestId("automatic-status")).toContainText(
      "Occupied",
    );
  }
  await page.getByTestId("override-green").click();
  await seek(page, 21);
  await expect(page.getByTestId("selected-status")).toContainText(/ready/i);
  await expect(page.getByTestId("people-state")).toContainText(
    "Departure pending",
  );
  await page.getByTestId("override-auto").click();
  await expect(page.getByTestId("selected-status")).toContainText("Verifying");
  await expect(page.getByTestId("manual-override")).toHaveCount(0);
  await seek(page, 14);
  await expect(page.getByTestId("selected-status")).toContainText("Verifying");
  await seek(page, 16);
  await expect(page.getByTestId("selected-status")).toContainText(/ready/i);
  await page.getByTestId("restart").click();
  await seek(page, 16);
  await expect(page.getByTestId("selected-status")).toContainText("Occupied");
});

test("Disabling a table excludes counts and zones, persists locally, and re-enables without an old override", async ({
  page,
}) => {
  await load(page, await independentBundle(3));
  await seek(page, 7);
  await page.getByTestId("table-T3").click();
  await page.getByTestId("override-red").click();
  await page.getByTestId("monitoring-toggle").uncheck();
  await expect(page.getByTestId("table-T3")).toHaveAttribute(
    "data-monitoring",
    "disabled",
  );
  await expect(page.getByTestId("selected-status")).toContainText("Disabled");
  await expect(page.getByTestId("video-table-T3")).toHaveCount(0);
  await expect(page.getByTestId("count-ready")).toHaveText("2");
  await expect(page.getByTestId("count-needs_cleaning")).toHaveText("0");
  await page.getByTestId("restart").click();
  await page.reload();
  await seek(page, 7);
  await page.getByTestId("table-list-T3").click();
  await expect(page.getByTestId("monitoring-toggle")).not.toBeChecked();
  await expect(page.getByTestId("selected-status")).toContainText("Disabled");
  await page.getByTestId("monitoring-toggle").check();
  await expect(page.getByTestId("table-T3")).toHaveAttribute(
    "data-monitoring",
    "enabled",
  );
  await expect(page.getByTestId("video-table-T3")).toBeVisible();
  await expect(page.getByTestId("selected-status")).toContainText(/ready/i);
  await expect(page.getByTestId("manual-override")).toHaveCount(0);
  await expect(page.getByTestId("count-ready")).toHaveText("3");
  for (const id of ["T1", "T2", "T3"]) {
    await page.getByTestId(`table-list-${id}`).click();
    await page.getByTestId("monitoring-toggle").uncheck();
  }
  for (const status of ["ready", "occupied", "needs_cleaning", "unknown"])
    await expect(page.getByTestId(`count-${status}`)).toHaveText("0");
  for (const id of ["T1", "T2", "T3"])
    await expect(page.getByTestId(`table-${id}`)).toHaveAttribute(
      "data-monitoring",
      "disabled",
    );
  const changed = await independentBundle(3);
  changed.tables[2].tabletop_polygon![0][0] += 0.001;
  changed.tables[2].geometry_sha256 = createHash("sha256")
    .update(
      JSON.stringify({
        occupancy_regions: changed.tables[2].occupancy_regions,
        tabletop_polygon: changed.tables[2].tabletop_polygon,
      }),
    )
    .digest("hex");
  approveObjects(changed.tables[2]);
  changed.assessment_requests = changed.assessment_requests!.filter(
    (request) => request.table_id !== "T3",
  );
  changed.assessments = changed.assessments!.filter(
    (result) => result.table_id !== "T3",
  );
  await page.unroute("**/api/sources/browser-fixture/assets/bundle.json");
  await load(page, changed);
  await page.getByTestId("table-list-T3").click();
  await expect(page.getByTestId("monitoring-toggle")).toBeChecked();
  await expect(page.getByTestId("table-T1")).toHaveAttribute(
    "data-monitoring",
    "disabled",
  );
});
