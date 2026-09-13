import { test, expect } from "./browser-fixtures";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  approveObjects,
  detected,
  objectEvidence,
  objectAssessment,
} from "./object-fixtures";
import type { Bundle, AssessmentRequest } from "../../shared/contracts";

test("Object-based recording details explain missing approval while keeping the recording inspectable", async ({
  page,
}) => {
  const bundle = JSON.parse(
    await readFile(path.resolve("tests/fixtures/workflow/bundle.json"), "utf8"),
  ) as Bundle;
  bundle.tables[0].surface_method = "objects_reference_v1";
  delete bundle.tables[0].object_baseline;
  bundle.assessments = [];
  bundle.assessment_requests = [];
  bundle.staff_events = [];
  await page.route(
    "**/api/sources/browser-fixture/assets/bundle.json",
    (route) => route.fulfill({ json: bundle }),
  );
  await page.goto("/?source=browser-fixture");
  await expect(page.getByTestId("object-evidence")).toContainText(
    "Approve expected objects",
  );
  await expect(page.getByTestId("object-evidence")).toContainText(
    "No inventory approved",
  );
  await expect(page.getByTestId("bundle-error")).toHaveCount(0);
});

test("Recording details show exact assessed-image boxes and expected versus extra object counts", async ({
  page,
}, testInfo) => {
  const bundle = JSON.parse(
    await readFile(path.resolve("tests/fixtures/workflow/bundle.json"), "utf8"),
  ) as Bundle;
  bundle.tables = [approveObjects(bundle.tables[0])];
  const table = bundle.tables[0];
  bundle.staff_events = [];
  bundle.snapshots = [];
  bundle.replay_events = [];
  bundle.observations = Array.from({ length: 100 }, (_, frame_index) => ({
    t: frame_index / 10,
    frame_index,
    valid: true,
    detections: [],
    tracks: [],
    tables: { T1: "absent" },
    surface: { T1: { visible: true, changed: false } },
  }));
  const request: AssessmentRequest = {
    id: "object-browser-evidence-5",
    table_id: table.id,
    t: 5,
    frame_index: Math.round(5 * bundle.video.fps),
    generation: 0,
    video_sha256: bundle.video.sha256,
    geometry_sha256: table.geometry_sha256!,
    reference_sha256: table.reference!.sha256!,
    surface_method: table.surface_method,
    baseline_sha256: table.object_baseline!.baseline_sha256,
    config_sha256: table.object_baseline!.config_sha256,
  };
  bundle.assessment_requests = [request];
  bundle.assessments = [
    {
      ...objectAssessment(request, objectEvidence([detected(), detected(45)])),
      crop_file: table.reference!.file,
      crop_sha256: table.reference!.sha256!,
    },
  ];
  await page.route(
    "**/api/sources/browser-fixture/assets/bundle.json",
    (route) => route.fulfill({ json: bundle }),
  );
  await page.goto("/?source=browser-fixture");
  await expect(page.getByTestId("video")).toBeVisible();
  await page.getByTestId("video").evaluate(async (element) => {
    const video = element as HTMLVideoElement;
    await new Promise<void>((resolve) => {
      video.addEventListener("seeked", () => resolve(), { once: true });
      video.currentTime = 5;
    });
  });
  const evidence = page.getByTestId("object-evidence");
  await expect(evidence).toContainText(
    /object mismatch needs a second capture/,
  );
  await expect(evidence.getByRole("row").filter({ hasText: "cup" })).toHaveText(
    /cup110/,
  );
  await expect(
    evidence.getByRole("row").filter({ hasText: "bowl" }),
  ).toHaveText(/bowl010/);
  await expect(
    evidence.getByTestId("object-photo").locator("svg rect"),
  ).toHaveCount(2);
  const digest = await evidence
    .getByRole("img", { name: /assessed tabletop/ })
    .evaluate(async (element) => {
      const bytes = await (
        await fetch((element as HTMLImageElement).src)
      ).arrayBuffer();
      const sha = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(sha))
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
    });
  expect(digest).toBe(table.reference!.sha256);
  await page
    .getByTestId("table-detail")
    .screenshot({ path: testInfo.outputPath("object-assessment-details.png") });
});
