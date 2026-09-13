import { test, expect, type Locator, type Page } from "./browser-fixtures";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Bundle, ImageAsset } from "../../shared/contracts";
import type { SourceInfo } from "../../shared/live-contracts";
import { approveObjects } from "./object-fixtures";

const sourceId = "original-reference-browser-fixture";
const sourcePath = `/api/sources/${sourceId}`;
const bundleDirectory = path.resolve("tests/fixtures/workflow");
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

async function imageHash(image: Locator): Promise<string> {
  return image.evaluate(async (element) => {
    const bytes = await (
      await fetch((element as HTMLImageElement).src)
    ).arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  });
}

async function fixture(
  page: Page,
  options: { uploaded?: boolean; failFirstUpload?: boolean } = {},
) {
  const bundle = JSON.parse(
    await readFile(path.join(bundleDirectory, "bundle.json"), "utf8"),
  ) as Bundle;
  // Full-size synthetic test photos have different bytes from the video's original frame and each tabletop crop.
  const photos = await page.evaluate(
    ({ width, height }) =>
      ["#27513e", "#32618b"].map((color) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d")!;
        context.fillStyle = color;
        context.fillRect(0, 0, width, height);
        context.fillStyle = "#f1e8d4";
        context.fillRect(width / 4, height / 4, width / 2, height / 2);
        return canvas.toDataURL("image/png").split(",")[1];
      }),
    bundle.video,
  );
  const [originalPhoto, replacementPhoto] = photos.map((data) =>
    Buffer.from(data, "base64"),
  );
  const asset = (file: string, bytes: Buffer): ImageAsset => ({
    file,
    sha256: sha256(bytes),
    width: bundle.video.width,
    height: bundle.video.height,
  });
  const originalAsset = asset("setup/approved-clean-photo.png", originalPhoto);
  const replacementAsset = asset(
    "setup/replacement-clean-photo.png",
    replacementPhoto,
  );
  const uploaded = options.uploaded !== false;
  bundle.analysis.original_scene_source_t = 4.2;
  if (uploaded)
    for (const table of bundle.tables)
      table.reference = {
        ...table.reference!,
        source_kind: "uploaded_image",
        source_image: originalAsset,
        alignment_confirmed: true,
      };
  let source: SourceInfo = {
    id: sourceId,
    kind: "video",
    label: "Completed restaurant fixture",
    status: "completed",
    phase: "completed",
    progress: 1,
    revision: 7,
    calibration_confirmed: true,
    setup_mode: "guided_v1",
    floor_plan_mode: "schematic",
    width: bundle.video.width,
    height: bundle.video.height,
    fps: bundle.video.fps,
    duration_s: bundle.video.duration_s,
    manifest_url: `${sourcePath}/assets/bundle.json`,
    media_url: `${sourcePath}/assets/${bundle.video.file}`,
    frame_url: `${sourcePath}/assets/${bundle.original_scene}`,
    ...(uploaded ? { setup_assets: { clean_reference: originalAsset } } : {}),
    setup_reference: uploaded
      ? {
          reference_source: "uploaded_image",
          reference_t: null,
          reference_image_sha256: originalAsset.sha256,
          alignment_confirmed: true,
        }
      : {
          reference_source: "video_frame",
          reference_t: 0,
          alignment_confirmed: false,
        },
    tables: bundle.tables.map((table) => ({
      ...approveObjects(structuredClone(table)),
      setup_review: { tabletop: true, occupancy: true, map: true },
      reference_approved: true,
      reference_source: uploaded ? "uploaded_image" : "video_frame",
      reference_t: uploaded ? null : 0,
      ...(uploaded
        ? {
            reference_image_sha256: originalAsset.sha256,
            alignment_confirmed: true,
          }
        : {}),
    })),
  };
  const uploads: {
    url: string;
    method: string;
    revision: string;
    hasReplacementBytes: boolean;
  }[] = [];
  const saves: Record<string, unknown>[] = [],
    proposals: Record<string, unknown>[] = [],
    unexpected: string[] = [];
  let analyses = 0;
  const files = new Map<string, Buffer>([
    [originalAsset.file, originalPhoto],
    [replacementAsset.file, replacementPhoto],
  ]);
  await page.route("**/api/**", (route) => {
    unexpected.push(
      `${route.request().method()} ${new URL(route.request().url()).pathname}`,
    );
    return route.fulfill({
      status: 404,
      json: { detail: "Unmocked browser fixture route" },
    });
  });
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        available: true,
        models: { detector: { available: true }, surface: { available: true } },
        limits: { upload_bytes: 1e9, duration_s: 600, frame_bytes: 2097152 },
      },
    }),
  );
  await page.route("**/api/jobs", (route) => route.fulfill({ json: [source] }));
  await page.route("**/api/cameras", (route) => route.fulfill({ json: [] }));
  await page.route(`**${sourcePath}`, (route) =>
    route.fulfill({ json: source }),
  );
  await page.route(`**/api/jobs/${sourceId}`, (route) =>
    route.fulfill({ json: source }),
  );
  await page.route(`**${sourcePath}/assets/**`, async (route) => {
    const file = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/assets/")[1],
    );
    if (file === "bundle.json") {
      await route.fulfill({ json: bundle });
      return;
    }
    if (!files.has(file))
      files.set(file, await readFile(path.join(bundleDirectory, file)));
    await route.fulfill({
      body: files.get(file),
      contentType: file.endsWith(".mp4") ? "video/mp4" : "image/png",
    });
  });
  await page.route(
    `**${sourcePath}/setup-assets/clean_reference`,
    async (route) => {
      const request = route.request(),
        body = request.postDataBuffer()!;
      const revision =
        body.toString("latin1").match(/name="revision"\r\n\r\n(\d+)/)?.[1] ??
        "missing";
      uploads.push({
        url: new URL(request.url()).pathname,
        method: request.method(),
        revision,
        hasReplacementBytes: body.includes(replacementPhoto),
      });
      if (options.failFirstUpload && uploads.length === 1) {
        await route.fulfill({
          status: 503,
          json: { detail: "Photo upload temporarily unavailable. Try again." },
        });
        return;
      }
      expect(revision).toBe(String(source.revision));
      source = {
        ...source,
        status: "needs_setup",
        calibration_confirmed: false,
        revision: source.revision + 1,
        setup_assets: {
          ...source.setup_assets,
          clean_reference: replacementAsset,
        },
        setup_reference: {
          reference_source: "uploaded_image",
          reference_t: null,
          reference_image_sha256: replacementAsset.sha256,
          alignment_confirmed: false,
        },
        tables: source.tables.map((table) => ({
          ...table,
          reference: null,
          reference_approved: false,
          object_baseline: undefined,
        })),
      };
      await route.fulfill({ json: source });
    },
  );
  await page.route(`**${sourcePath}/calibration`, async (route) => {
    const body = route.request().postDataJSON();
    saves.push(body);
    expect(body.revision).toBe(source.revision);
    source = {
      ...source,
      revision: source.revision + 1,
      calibration_confirmed: body.confirmed,
      setup_reference: body.setup_reference,
      floor_plan_mode: body.floor_plan_mode,
      tables: body.tables,
    };
    await route.fulfill({ json: source });
  });
  await page.route(`**${sourcePath}/baseline-proposal`, async (route) => {
    const body = route.request().postDataJSON();
    proposals.push(body);
    expect(body.revision).toBe(source.revision);
    const baseline = {
      ...approveObjects(structuredClone(bundle.tables[0])).object_baseline!,
      approved: false,
    };
    await route.fulfill({
      json: {
        revision: source.revision,
        reference_t: 0,
        baseline,
        detections: [],
        frame_base64: `data:image/png;base64,${replacementPhoto.toString("base64")}`,
      },
    });
  });
  await page.route(`**${sourcePath}/analyze`, (route) => {
    analyses++;
    return route.fulfill({
      status: 202,
      json: { ...source, status: "analyzing" },
    });
  });
  return {
    bundle,
    originalAsset,
    replacementAsset,
    originalPhoto,
    replacementPhoto,
    uploads,
    saves,
    proposals,
    unexpected,
    source: () => source,
    analyses: () => analyses,
    replacementFile: {
      name: "new-clean-photo.png",
      mimeType: "image/png",
      buffer: replacementPhoto,
    },
  };
}

async function openOriginalScene(page: Page) {
  await page.goto(`/?source=${sourceId}`);
  await expect(page.getByTestId("table-T1")).toBeVisible();
  await page
    .getByRole("button", { name: "Original scene", exact: true })
    .click();
  await expect(page.getByTestId("original-scene")).toBeVisible();
}

async function openReferenceEditor(page: Page) {
  await openOriginalScene(page);
  const videoUrl = await page.getByTestId("video").getAttribute("src");
  await page
    .getByRole("link", { name: "Change reference photo", exact: true })
    .click();
  await expect(page).toHaveURL(`/?setup=${sourceId}&step=references`);
  await expect(
    page.getByRole("button", { name: "Reference & floor plan", exact: true }),
  ).toHaveClass(/active/);
  await expect(page.getByTestId("clean-reference-upload")).toBeAttached();
  await expect(
    page.getByText("Choose clean photo", { exact: true }),
  ).toBeVisible();
  return videoUrl;
}

test("Original scene defaults to verified full uploaded photo and keeps recording-frame evidence separate", async ({
  page,
}) => {
  const state = await fixture(page);
  await openOriginalScene(page);
  const photo = page.getByTestId("original-scene");
  await expect(photo).toHaveAttribute("src", /^blob:/);
  expect(await imageHash(photo)).toBe(state.originalAsset.sha256);
  expect(await imageHash(photo)).not.toBe(
    state.bundle.tables[0].reference!.sha256,
  );
  expect(await imageHash(photo)).not.toBe(
    sha256(
      await readFile(path.join(bundleDirectory, state.bundle.original_scene!)),
    ),
  );
  expect(
    await photo.evaluate((element) => ({
      width: (element as HTMLImageElement).naturalWidth,
      height: (element as HTMLImageElement).naturalHeight,
    })),
  ).toEqual({
    width: state.bundle.video.width,
    height: state.bundle.video.height,
  });
  await expect(page.getByTestId("original-scene-provenance")).toContainText(
    "Saved reference photo.",
  );
  await expect(page.getByTestId("original-scene-timestamp")).toHaveCount(0);
  await page
    .getByRole("button", { name: "View recording setup frame", exact: true })
    .click();
  await expect(photo).toHaveAttribute(
    "src",
    new RegExp(`/assets/${state.bundle.original_scene}$`),
  );
  await expect(page.getByTestId("original-scene-timestamp")).toHaveText(
    "Source video timestamp: 00:04.200",
  );
  await page
    .getByRole("button", { name: "View saved reference photo", exact: true })
    .click();
  expect(await imageHash(photo)).toBe(state.originalAsset.sha256);
  await expect(page.getByTestId("original-scene-timestamp")).toHaveCount(0);
  expect(state.unexpected).toEqual([]);
});

test("Original scene without an uploaded photo preserves its actual source timestamp", async ({
  page,
}) => {
  const state = await fixture(page, { uploaded: false });
  await openOriginalScene(page);
  await expect(page.getByTestId("original-scene")).toHaveAttribute(
    "src",
    new RegExp(`/assets/${state.bundle.original_scene}$`),
  );
  await expect(page.getByTestId("original-scene-timestamp")).toHaveText(
    "Source video timestamp: 00:04.200",
  );
  await expect(page.getByTestId("original-scene-provenance")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "View saved reference photo",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(state.analyses()).toBe(0);
});

test("Change reference photo opens the completed source directly at its existing reference section", async ({
  page,
}) => {
  const state = await fixture(page);
  const videoUrl = await openReferenceEditor(page);
  expect(state.source().status).toBe("completed");
  await expect(
    page.getByRole("img", { name: "Uploaded clean reference", exact: true }),
  ).toHaveAttribute("src", `${sourcePath}/assets/${state.originalAsset.file}`);
  await expect(page.getByTestId("reference-alignment-confirmed")).toBeChecked();
  expect(state.uploads).toHaveLength(0);
  expect(state.saves).toHaveLength(0);
  expect(state.analyses()).toBe(0);
  await page
    .getByRole("button", { name: "Back to dashboard", exact: true })
    .click();
  await expect(page).toHaveURL(`/?source=${sourceId}`);
  await expect(page.getByTestId("video")).toHaveAttribute("src", videoUrl!);
  await expect
    .poll(() =>
      page
        .getByTestId("video")
        .evaluate((element) => (element as HTMLVideoElement).readyState),
    )
    .toBeGreaterThanOrEqual(2);
  await page
    .getByRole("button", { name: "Original scene", exact: true })
    .click();
  expect(await imageHash(page.getByTestId("original-scene"))).toBe(
    state.originalAsset.sha256,
  );
  await page
    .getByRole("link", { name: "Change reference photo", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Reference & floor plan", exact: true }),
  ).toHaveClass(/active/);
  await expect(page.getByTestId("clean-reference-upload")).toBeAttached();
  expect(state.unexpected).toEqual([]);
});

test("Replacing the photo uses the source revision, clears approval, and permits explicit object review without analysis", async ({
  page,
}) => {
  const state = await fixture(page);
  await openReferenceEditor(page);
  await page
    .getByTestId("clean-reference-upload")
    .setInputFiles(state.replacementFile);
  await expect(
    page.getByRole("img", { name: "Uploaded clean reference", exact: true }),
  ).toHaveAttribute(
    "src",
    `${sourcePath}/assets/${state.replacementAsset.file}`,
  );
  expect(state.uploads).toEqual([
    {
      url: `${sourcePath}/setup-assets/clean_reference`,
      method: "PUT",
      revision: "7",
      hasReplacementBytes: true,
    },
  ]);
  await expect(
    page.getByTestId("reference-alignment-confirmed"),
  ).not.toBeChecked();
  await expect(page.getByTestId("setup-next")).toBeDisabled();
  await page.getByTestId("reference-alignment-confirmed").check();
  await page.getByTestId("setup-next").click();
  await expect(page.getByTestId("table-step-objects")).toHaveAttribute(
    "aria-current",
    "step",
  );
  await expect(page.getByTestId("baseline-propose")).toBeEnabled();
  await expect(page.getByTestId("setup-next")).toBeDisabled();
  expect(state.saves[0]).toMatchObject({
    revision: 8,
    confirmed: false,
    setup_reference: {
      reference_source: "uploaded_image",
      reference_image_sha256: state.replacementAsset.sha256,
      alignment_confirmed: true,
    },
  });
  expect(
    state
      .source()
      .tables.every(
        (table) =>
          table.reference === null &&
          !table.reference_approved &&
          !table.object_baseline,
      ),
  ).toBe(true);
  expect(
    state
      .source()
      .tables.every(
        (table) =>
          table.setup_review?.tabletop &&
          table.setup_review.occupancy &&
          table.setup_review.map,
      ),
  ).toBe(true);
  await page.getByTestId("baseline-propose").click();
  await expect(page.getByTestId("expected-count-41")).toHaveValue("1");
  await expect(page.getByTestId("setup-next")).toBeEnabled();
  expect(state.proposals[0]).toMatchObject({
    revision: 9,
    table_id: "T1",
    reference_source: "uploaded_image",
    reference_image_sha256: state.replacementAsset.sha256,
    alignment_confirmed: true,
  });
  expect(state.analyses()).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("A failed replacement preserves the saved photo and approval and lets the same file be retried", async ({
  page,
}) => {
  const state = await fixture(page, { failFirstUpload: true });
  await page.goto(`/?setup=${sourceId}&step=references`);
  const image = page.getByRole("img", {
    name: "Uploaded clean reference",
    exact: true,
  });
  await expect(image).toBeVisible();
  await page
    .getByTestId("clean-reference-upload")
    .setInputFiles(state.replacementFile);
  await expect(page.getByRole("alert")).toContainText(
    "Photo upload temporarily unavailable. Try again.",
  );
  await expect(image).toHaveAttribute(
    "src",
    `${sourcePath}/assets/${state.originalAsset.file}`,
  );
  expect(await imageHash(image)).toBe(state.originalAsset.sha256);
  await expect(page.getByTestId("reference-alignment-confirmed")).toBeChecked();
  await expect(page.getByTestId("clean-reference-upload")).toBeEnabled();
  expect(state.source().revision).toBe(7);
  expect(
    state
      .source()
      .tables.every(
        (table) => table.reference_approved && table.object_baseline?.approved,
      ),
  ).toBe(true);
  await page
    .getByTestId("clean-reference-upload")
    .setInputFiles(state.replacementFile);
  await expect(image).toHaveAttribute(
    "src",
    `${sourcePath}/assets/${state.replacementAsset.file}`,
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.uploads.map((upload) => upload.revision)).toEqual(["7", "7"]);
  expect(state.source().revision).toBe(8);
  expect(state.analyses()).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("A direct reference-edit link returns to its completed recording when leaving unchanged setup", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(`/?setup=${sourceId}&step=references`);
  await expect(page.getByTestId("clean-reference-upload")).toBeAttached();
  await page
    .getByRole("button", { name: "Back to dashboard", exact: true })
    .click();
  await expect(page).toHaveURL(`/?source=${sourceId}`);
  await expect(page.getByTestId("table-T1")).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByTestId("video")
        .evaluate((element) => (element as HTMLVideoElement).readyState),
    )
    .toBeGreaterThanOrEqual(2);
  await page
    .getByRole("button", { name: "Original scene", exact: true })
    .click();
  expect(await imageHash(page.getByTestId("original-scene"))).toBe(
    state.originalAsset.sha256,
  );
  expect(state.uploads).toHaveLength(0);
  expect(state.saves).toHaveLength(0);
  expect(state.analyses()).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("Imported bundle explains that saving a replacement requires its source and has no change link", async ({
  page,
}) => {
  await page.goto("/?source=browser-fixture");
  await page.getByTestId("bundle-upload").setInputFiles(bundleDirectory);
  await expect(
    page.getByRole("button", { name: "Open bundle", exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("bundle-error")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Original scene", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Imported bundle folders are view-only.",
  );
  await expect(
    page.getByRole("link", { name: "Change reference photo", exact: true }),
  ).toHaveCount(0);
});
