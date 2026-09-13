import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let media: string, clip: string;
test.beforeAll(() => {
  // Other browser projects may clean test-results when starting. Keep generated
  // media private to this worker so parallel suites cannot delete open videos.
  media = mkdtempSync(path.join(tmpdir(), "tablewatch-stateless-media-"));
  clip = path.join(media, "cfr.mp4");
  const ff = (...args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  ff("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10", "-t", "3", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip);
  ff("-display_rotation", "90", "-i", clip, "-c", "copy", path.join(media, "rotated.mp4"));
  ff("-i", clip, "-vf", "setpts=PTS+0.5/TB", "-fps_mode", "passthrough", "-c:v", "libx264", path.join(media, "offset.mp4"));
  ff("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "3", "-vf", "select='if(lt(t,1.5),not(mod(n,3)),not(mod(n,2)))'", "-fps_mode", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(media, "vfr.mp4"));
});
test.afterAll(() => { if (media) rmSync(media, { recursive: true, force: true }); });

async function markTable(page: Page) {
  await page.getByRole("button", { name: "Set up tables manually" }).click();
  await page.getByTestId("schematic-floor-plan").check();
  await page.getByTestId("setup-next").click();
  await page.getByTestId("calibration-add-table").click();
  await page.getByTestId("calibration-label").fill("Test table");
  const canvas = page.getByTestId("calibration-canvas"), box = (await canvas.boundingBox())!;
  for (const [x, y] of [[.2, .2], [.7, .2], [.7, .7], [.2, .7]])
    await canvas.click({ position: { x: box.width * x, y: box.height * y } });
  await page.getByTestId("setup-next").click();
  await page.getByTestId("setup-next").click();
  await page.getByTestId("setup-next").click();
  await page.getByTestId("baseline-propose").click();
  await expect(page.getByTestId("setup-next")).toBeEnabled();
  await page.getByTestId("setup-next").click();
  await page.getByRole("button", { name: "Review setup", exact: true }).first().click();
  await page.getByTestId("calibration-save").click();
  await expect(page.getByRole("button", { name: "Analyze video", exact: true })).toBeEnabled();
}

test("real frame API completes reviewed setup and replay without persistent endpoints", async ({ page, context }, testInfo) => {
  const forbidden: string[] = [], operations: string[] = [], bodies: Record<string, unknown>[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) forbidden.push(url.pathname);
    if (request.method() === "POST" && url.pathname.startsWith("/frames/")) {
      operations.push(url.pathname); bodies.push(request.postDataJSON());
      expect(Buffer.byteLength(request.postData()!)).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
  });
  await page.goto("/");
  await page.getByLabel("Choose local video").setInputFiles(clip);
  await expect(page.getByRole("button", { name: "Set up tables manually" })).toBeVisible();
  await markTable(page);
  await page.getByRole("button", { name: "Analyze video", exact: true }).click();
  await expect(page.getByTestId("video")).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId("video")).toHaveAttribute("src", /^blob:/);
  expect(operations).toContain("/frames/propose-reference");
  expect(operations).toContain("/frames/observe-batch");
  expect(operations).toContain("/frames/assess-batch");
  expect(forbidden).toEqual([]);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => /tablewatch/.test(k)))).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("stateless-replay.png"), fullPage: true });
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByText("In this tab", { exact: true })).toHaveCount(0);
  await expect(other.getByTestId("video")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("In this tab", { exact: true })).toHaveCount(0);
  expect(bodies.every(body => !JSON.stringify(body).includes("video_base64"))).toBe(true);
  expect(bodies.every(body => !("protocol_version" in body))).toBe(true);
});

for (const name of ["cfr", "vfr", "rotated", "offset"]) {
  test(`worker preserves ${name} presentation timing and geometry`, async ({ page }) => {
    await page.goto("/");
    const bytes = readFileSync(path.join(media, `${name}.mp4`)).toString("base64");
    const result = await page.evaluate(async ({ bytes, name }) => {
      const modulePath = "/src/stateless/decoder.ts";
      const { openVideo } = await import(modulePath);
      const raw = Uint8Array.from(atob(bytes), c => c.charCodeAt(0));
      const file = new File([raw], `${name}.mp4`, { type: "video/mp4" });
      const decoder = await openVideo(file);
      const times: number[] = [], counts: number[] = [];
      let firstFrame: { t: number; image_base64: string } | undefined;
      let done = false;
      while (!done) {
        const batch = await decoder.next(8); done = batch.done;
        firstFrame ??= batch.frames[0];
        counts.push(batch.frames.length);
        times.push(...batch.frames.map((f: { t: number }) => f.t));
      }
      const video = document.createElement("video"); video.muted = true;
      video.src = URL.createObjectURL(file);
      await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error("native decode failed")); });
      const geometry = [video.videoWidth, video.videoHeight], duration = video.duration;
      // Positive-start MP4s can report a transient native duration. Compare the
      // actual image at the original presentation timestamp instead of rebasing it.
      // Even a seek to the current timestamp is necessary here: Chrome can emit
      // loadeddata before a detached paused video's first image is drawable.
      // Waiting for seeked produces a real native frame, rather than transparent
      // canvas pixels that would make this comparison meaningless.
      await new Promise<void>(resolve => { video.onseeked = () => resolve(); video.currentTime = firstFrame!.t; });
      const encoded = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${firstFrame!.image_base64}`)).blob());
      const canvas = document.createElement("canvas"); canvas.width = encoded.width; canvas.height = encoded.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const nativePixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      ctx.drawImage(encoded, 0, 0);
      const workerPixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const pixelDifference = nativePixels.reduce((total, value, i) => total + Math.abs(value - workerPixels[i]), 0) / nativePixels.length;
      encoded.close();
      URL.revokeObjectURL(video.src); video.remove(); decoder.close();
      return { metadata: decoder.metadata, times, counts, geometry, duration, pixelDifference };
    }, { bytes, name });
    expect(result.counts.every(n => n <= 8)).toBe(true);
    expect(result.times.length).toBeGreaterThan(20);
    expect(result.times.every((t, i) => t >= 0 && (i === 0 || t > result.times[i - 1]))).toBe(true);
    expect([result.metadata.width, result.metadata.height]).toEqual(result.geometry);
    expect(result.duration).toBeGreaterThanOrEqual(result.metadata.duration_s - result.times[0] - .11);
    expect(result.duration).toBeLessThanOrEqual(result.metadata.duration_s + .11);
    expect(result.pixelDifference).toBeLessThan(6);
    if (name === "offset") expect(result.times[0]).toBeGreaterThanOrEqual(.49);
    if (name === "rotated") expect(result.geometry).toEqual([180, 320]);
  });
}
