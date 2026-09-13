import { test, expect, type Page } from "./browser-fixtures";
import {
  readFile,
  mkdtemp,
  mkdir,
  writeFile,
  copyFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const recording = path.resolve("tests/fixtures/workflow");

async function mediaTime(page: Page, time: number) {
  await page.getByTestId("video").evaluate(async (element, value) => {
    const video = element as HTMLVideoElement;
    video.pause();
    if (Math.abs(video.currentTime - value) < 0.01) {
      video.dispatchEvent(new Event("timeupdate"));
      return;
    }
    await new Promise<void>((resolve) => {
      video.addEventListener("seeked", () => resolve(), { once: true });
      video.currentTime = value;
    });
  }, time);
  await expect
    .poll(async () =>
      page
        .getByTestId("video")
        .evaluate((element) => (element as HTMLVideoElement).currentTime),
    )
    .toBeCloseTo(time, 1);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?source=browser-fixture");
  await expect(page.getByTestId("table-T1")).toBeVisible();
  await expect
    .poll(async () =>
      page
        .getByTestId("video")
        .evaluate((element) => (element as HTMLVideoElement).readyState),
    )
    .toBeGreaterThanOrEqual(2);
});

test("original scene displays supplied source time and never invents a missing timestamp", async ({
  page,
}) => {
  const original = JSON.parse(
    await readFile(path.join(recording, "bundle.json"), "utf8"),
  );
  let sourceTime: number | null = 0;
  await page.route(
    "**/api/sources/browser-fixture/assets/bundle.json",
    async (route) => {
      const fixture = structuredClone(original);
      fixture.analysis.original_scene_source_t = sourceTime;
      await route.fulfill({ json: fixture });
    },
  );
  for (const expected of [
    "Source video timestamp: 00:00.000",
    "Source video timestamp unavailable.",
  ]) {
    await page.reload();
    await page
      .getByRole("button", { name: "Original scene", exact: true })
      .click();
    await expect(page.getByTestId("original-scene")).toBeVisible();
    await expect(page.getByTestId("original-scene-timestamp")).toHaveText(
      expected,
    );
    sourceTime = null;
  }
});

test("overlay and source video retain identical image rectangles after resize", async ({
  page,
}) => {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 900, height: 1000 },
  ]) {
    await page.setViewportSize(viewport);
    const video = await page.getByTestId("video").boundingBox();
    const overlay = await page.locator(".video-overlay").boundingBox();
    expect(video).not.toBeNull();
    expect(overlay).not.toBeNull();
    for (const field of ["x", "y", "width", "height"] as const)
      expect(Math.abs(video![field] - overlay![field])).toBeLessThanOrEqual(1);
  }
});

test("uploaded bundle rejects a real file whose bytes disagree with declared video hash", async ({
  page,
}) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "occupancy-hash-test-"),
  );
  try {
    const folder = path.join(temporary, "bundle");
    await mkdir(folder);
    const bundle = JSON.parse(
      await readFile(path.join(recording, "bundle.json"), "utf8"),
    );
    bundle.video.sha256 = "f".repeat(64);
    bundle.original_scene = null;
    bundle.assessments = [];
    bundle.assessment_requests = [];
    for (const table of bundle.tables) {
      table.reference = null;
      delete table.object_baseline;
    }
    await writeFile(path.join(folder, "bundle.json"), JSON.stringify(bundle));
    await copyFile(
      path.join(recording, bundle.video.file),
      path.join(folder, bundle.video.file),
    );
    await page.getByTestId("bundle-upload").setInputFiles(folder);
    await expect(page.getByTestId("bundle-error")).toContainText(
      /hash|SHA|match/i,
    );
    await expect(page.getByTestId("table-T1")).toBeVisible();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("uploaded bundle rejects missing video and accepts matching source media", async ({
  page,
}) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "occupancy-upload-test-"),
  );
  try {
    const folder = path.join(temporary, "bundle");
    await mkdir(folder);
    const bundle = JSON.parse(
      await readFile(path.join(recording, "bundle.json"), "utf8"),
    );
    bundle.original_scene = null;
    bundle.assessments = [];
    bundle.assessment_requests = [];
    for (const table of bundle.tables) {
      table.reference = null;
      delete table.object_baseline;
    }
    await writeFile(path.join(folder, "bundle.json"), JSON.stringify(bundle));
    await page.getByTestId("bundle-upload").setInputFiles(folder);
    await expect(page.getByTestId("bundle-error")).toContainText(
      /missing|video|source/i,
    );
    await copyFile(
      path.join(recording, bundle.video.file),
      path.join(folder, bundle.video.file),
    );
    await page.getByTestId("bundle-upload").setInputFiles(folder);
    await expect(page.getByTestId("bundle-error")).toHaveCount(0);
    await expect(page.getByTestId("video")).toHaveAttribute("src", /^blob:/);
    await mediaTime(page, 15);
    await expect(page.getByTestId("table-T1")).toHaveAttribute(
      "aria-label",
      /occupied/i,
    );
    await expect(page.getByText("No clean reference supplied")).toBeVisible();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("unsupported legacy bundle is rejected while the current recording stays usable", async ({
  page,
}) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tablewatch-legacy-"));
  try {
    const bundle = JSON.parse(
      await readFile(path.join(recording, "bundle.json"), "utf8"),
    );
    bundle.schema_version = 1;
    bundle.policy = "legacy_v1";
    await writeFile(
      path.join(temporary, "bundle.json"),
      JSON.stringify(bundle),
    );
    await page.getByTestId("override-green").click();
    await page.getByTestId("bundle-upload").setInputFiles(temporary);
    await expect(page.getByTestId("bundle-error")).toContainText(
      "Reprocess the original video",
    );
    await expect(page.getByTestId("selected-status")).toContainText(/ready/i);
    await expect(page.getByTestId("manual-override")).toContainText(/manual/i);
    await expect(page.getByTestId("video")).toBeVisible();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
