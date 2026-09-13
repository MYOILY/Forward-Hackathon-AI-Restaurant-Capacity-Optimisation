import { test as base } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Bundle } from "../../shared/contracts";
import type { SourceInfo } from "../../shared/live-contracts";

export * from "@playwright/test";
export const fixtureDirectory = path.resolve("tests/fixtures/workflow");
export const fixtureSourcePath = "/api/sources/browser-fixture";

/** Test-owned API assets; no public fixture route or sample feature exists in the app. */
export const test = base.extend({
  page: async ({ page }, use) => {
    const bundle = JSON.parse(
      await readFile(path.join(fixtureDirectory, "bundle.json"), "utf8"),
    ) as Bundle;
    const source: SourceInfo = {
      id: "browser-fixture",
      kind: "video",
      label: "Synthetic browser fixture",
      status: "completed",
      phase: "completed",
      progress: 1,
      revision: 1,
      calibration_confirmed: true,
      width: bundle.video.width,
      height: bundle.video.height,
      fps: bundle.video.fps,
      duration_s: bundle.video.duration_s,
      tables: bundle.tables,
      manifest_url: `${fixtureSourcePath}/assets/bundle.json`,
    };
    await page.route(`**${fixtureSourcePath}`, (route) =>
      route.fulfill({ json: source }),
    );
    await page.route(`**${fixtureSourcePath}/assets/**`, async (route) => {
      const asset = decodeURIComponent(
        new URL(route.request().url()).pathname.split("/assets/")[1],
      );
      const target = path.resolve(fixtureDirectory, asset);
      if (!target.startsWith(`${fixtureDirectory}${path.sep}`)) {
        await route.fulfill({ status: 400 });
        return;
      }
      try {
        await route.fulfill({
          body: await readFile(target),
          contentType: asset.endsWith(".mp4")
            ? "video/mp4"
            : asset.endsWith(".json")
              ? "application/json"
              : "image/png",
        });
      } catch {
        await route.fulfill({ status: 404 });
      }
    });
    await use(page);
  },
});
