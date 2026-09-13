import { test, expect } from "./browser-fixtures";

for (const [query, expected] of [
  ["0.5", "0.5"],
  ["1", "1"],
  ["2", "2"],
  ["3", "3"],
  ["NaN", "1"],
  ["10", "1"],
  ["-1", "1"],
  ["", "1"],
]) {
  test(`Playback speed URL ${JSON.stringify(query)} initializes to ${expected} after media loading`, async ({
    page,
  }) => {
    await page.goto(
      `/?source=browser-fixture&speed=${encodeURIComponent(query)}`,
    );
    await expect(page.getByTestId("video")).toBeVisible();
    await expect
      .poll(() =>
        page
          .getByTestId("video")
          .evaluate((element) => (element as HTMLVideoElement).readyState),
      )
      .toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId("playback-speed")).toHaveValue(expected);
    expect(
      await page
        .getByTestId("video")
        .evaluate((element) => (element as HTMLVideoElement).playbackRate),
    ).toBe(Number(expected));
    const status = await page.getByTestId("selected-status").textContent();
    for (const value of ["0.5", "1", "2", "3"]) {
      await page.getByTestId("playback-speed").selectOption(value);
      expect(
        await page
          .getByTestId("video")
          .evaluate((element) => (element as HTMLVideoElement).playbackRate),
      ).toBe(Number(value));
      await expect(page.getByTestId("selected-status")).toHaveText(status!);
    }
  });
}
