import {
  test,
  expect,
  type Page,
  type WebSocketRoute,
} from "./browser-fixtures";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { Bundle } from "../../shared/contracts";
import type { SourceInfo, LiveConfig } from "../../shared/live-contracts";
import { liveConfig, liveObservation } from "./live-fixtures";
import { createLiveSession } from "../../web/src/live-engine";

test.use({
  permissions: ["camera"],
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

async function mockHealth(page: Page) {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        available: true,
        models: {
          detector: { available: true },
          surface: {
            available: false,
            reason: "Independent browser fixture has no surface model",
          },
        },
        limits: {
          upload_bytes: 1_000_000_000,
          duration_s: 600,
          frame_bytes: 2 * 1024 * 1024,
        },
      },
    }),
  );
  await page.route("**/api/jobs", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/cameras", (route) => route.fulfill({ json: [] }));
}

test("U01 source workspace offers raw upload, saved jobs and live camera setup", async ({
  page,
}) => {
  await mockHealth(page);
  await page.goto("/?source=browser-fixture");
  await page.getByTestId("open-inputs").click();
  await expect(page.getByTestId("source-upload")).toBeAttached();
  await expect(page.getByTestId("saved-sources")).toBeVisible();
  await expect(page.getByTestId("camera-preview-start")).toBeVisible();
});

test("L08 leaving Sources while camera permission resolves releases the late stream", async ({
  page,
}) => {
  await mockHealth(page);
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      const state = window as unknown as {
        lateCamera: MediaStream;
        releaseCamera?: () => void;
      };
      state.lateCamera = stream;
      await new Promise<void>((resolve) => {
        state.releaseCamera = resolve;
      });
      return stream;
    };
  });
  await page.goto("/?source=browser-fixture");
  await page.getByTestId("open-inputs").click();
  await page.getByTestId("camera-preview-start").click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as unknown as { releaseCamera?: () => void }).releaseCamera,
        ),
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Back to dashboard" }).click();
  await page.evaluate(() =>
    (window as unknown as { releaseCamera: () => void }).releaseCamera(),
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { lateCamera: MediaStream }).lateCamera
          .getTracks()
          .every((track) => track.readyState === "ended"),
      ),
    )
    .toBe(true);
});

test("U03 saved camera requires a fresh alignment review for each preview session", async ({
  page,
}) => {
  await mockHealth(page);
  await page.goto("/?source=browser-fixture");
  const device = await page.evaluate(
    async () =>
      (await navigator.mediaDevices.enumerateDevices()).find(
        (item) => item.kind === "videoinput",
      )!.deviceId,
  );
  const source = {
    ...sourceInfo("camera"),
    device_key: device,
    calibration_confirmed: true,
    revision: 1,
  };
  await page.unroute("**/api/cameras");
  await page.route("**/api/cameras", (route) =>
    route.fulfill({ json: [source] }),
  );
  await page.route("**/api/sources/independent-source", (route) =>
    route.fulfill({ json: source }),
  );
  await page.getByTestId("open-inputs").click();
  await page.getByTestId("source-open-independent-source").click();
  await page.getByTestId("camera-preview-start").click();
  await expect(page.getByTestId("camera-setup-save")).toBeEnabled();
  await page.getByTestId("detection-only").check();
  await expect(page.getByTestId("camera-reuse-confirmed")).not.toBeChecked();
  await expect(page.getByTestId("live-start")).toBeDisabled();
  await page.getByTestId("camera-reuse-confirmed").check();
  await expect(page.getByTestId("live-start")).toBeEnabled();
  await page.getByTestId("camera-preview-start").click();
  await expect(page.getByTestId("camera-reuse-confirmed")).not.toBeChecked();
  await expect(page.getByTestId("live-start")).toBeDisabled();
});

test("T02 recording label edit keeps table identity, observed evidence and manual colour", async ({
  page,
}) => {
  await page.goto("/?source=browser-fixture");
  await expect(page.getByTestId("table-T1")).toBeVisible();
  await page
    .getByTestId("bundle-upload")
    .setInputFiles(path.resolve("tests/fixtures/workflow"));
  await expect
    .poll(() => page.getByTestId("video").getAttribute("src"))
    .toMatch(/^blob:/);
  const before = await page.getByTestId("people-state").textContent();
  await page.getByTestId("override-green").click();
  await page.getByTestId("table-label").fill("Window row");
  await page.getByTestId("table-label-save").click();
  await expect(page.getByTestId("table-T1")).toHaveAttribute(
    "aria-label",
    /Window row/,
  );
  await expect(page.getByTestId("people-state")).toHaveText(before!);
  await expect(page.getByTestId("selected-status")).toContainText(/ready/i);
  await expect(page.getByTestId("manual-override")).toContainText(/manual/i);
  expect(
    await page.getByTestId("video").evaluate(async (element) => {
      try {
        return (await fetch((element as HTMLVideoElement).currentSrc)).ok;
      } catch {
        return false;
      }
    }),
  ).toBe(true);
  expect(
    await page.getByTestId("reference-image").evaluate(async (element) => {
      try {
        return (await fetch((element as HTMLImageElement).src)).ok;
      } catch {
        return false;
      }
    }),
  ).toBe(true);
  await page.getByTestId("video").evaluate(async (element) => {
    const video = element as HTMLVideoElement;
    await new Promise<void>((resolve) => {
      video.addEventListener("seeked", () => resolve(), { once: true });
      video.currentTime = 1;
    });
  });
  await page.getByTestId("play-toggle").click();
  await expect
    .poll(() =>
      page
        .getByTestId("video")
        .evaluate((element) => (element as HTMLVideoElement).currentTime),
    )
    .toBeGreaterThan(1.1);
  await page.getByTestId("play-toggle").click();
});

function sourceInfo(kind: "video" | "camera" = "video"): SourceInfo {
  const config = liveConfig(true);
  return {
    id: "independent-source",
    kind,
    label: "Independent source",
    status: "needs_setup",
    progress: 1,
    phase: "needs_setup",
    revision: 0,
    calibration_confirmed: false,
    width: 1280,
    height: 720,
    fps: kind === "video" ? 10 : 0,
    duration_s: kind === "video" ? 42 : 0,
    tables: config.tables.map((table) => ({ ...table, reference: null })),
    frame_url: "/api/sources/browser-fixture/assets/original.png",
    media_url:
      kind === "video"
        ? "/api/sources/browser-fixture/assets/video.mp4"
        : undefined,
    device_key: kind === "camera" ? "fixture-camera" : undefined,
  };
}

test("L02 L08 fake-device camera paints exact analyzed bytes, obeys backpressure and releases tracks on Stop", async ({
  page,
}) => {
  await mockHealth(page);
  let source = { ...sourceInfo("camera"), calibration_confirmed: true };
  let setupCapture = "";
  let analyzedImage = "";
  let analyzedFrames = 0;
  let stopped = false;
  let deleted = 0;
  let clockReplies = 0;
  let socketConnections = 0;
  const captureTimes: number[] = [];
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    const state = window as unknown as {
      testStreams: MediaStream[];
      testConstraints: MediaStreamConstraints[];
    };
    state.testStreams = [];
    state.testConstraints = [];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      state.testConstraints.push(constraints!);
      const stream = await original(constraints);
      state.testStreams.push(stream);
      return stream;
    };
  });
  await page.unroute("**/api/cameras");
  await page.route("**/api/cameras", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: [] });
      return;
    }
    setupCapture = route.request().postDataJSON().image_base64;
    await route.fulfill({ status: 202, json: source });
  });
  await page.route("**/api/jobs/independent-source", (route) =>
    route.fulfill({ json: source }),
  );
  await page.route("**/api/sources/independent-source", (route) =>
    route.fulfill({ json: source }),
  );
  await page.route(
    "**/api/sources/independent-source/calibration",
    async (route) => {
      source = {
        ...source,
        tables: route.request().postDataJSON().tables,
        revision: 1,
        calibration_confirmed: true,
      };
      await route.fulfill({ json: source });
    },
  );
  const config: LiveConfig = {
    ...liveConfig(true, 2),
    session_id: "browser-session",
    width: 1280,
    height: 720,
  };
  source.tables = config.tables.map((table) => ({ ...table, reference: null }));
  const engine = createLiveSession(config);
  let origin = performance.now();
  let staffSeq = 0;
  let liveSocket: WebSocketRoute | undefined;
  await page.route("**/api/live", async (route) => {
    origin = performance.now();
    await route.fulfill({
      json: {
        session_id: config.session_id,
        epoch: config.epoch,
        config,
        ws_url: "ws://127.0.0.1:4175/live/browser-session/stream",
      },
    });
  });
  await page.route("**/api/live/browser-session", async (route) => {
    deleted++;
    await route.fulfill({ json: { stopped: true } });
  });
  await page.routeWebSocket("**/live/browser-session/stream", (socket) => {
    socketConnections++;
    liveSocket = socket;
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      const now = (performance.now() - origin) / 1000;
      if (message.type === "sync") {
        clockReplies++;
        socket.send(
          JSON.stringify({
            type: "clock",
            client_t: message.client_t,
            t: now + (clockReplies > 1 ? 500 : 0),
          }),
        );
        return;
      }
      if (message.type === "stop") {
        stopped = true;
        socket.send(JSON.stringify({ type: "stopped" }));
        return;
      }
      let reply;
      if (message.type === "frame") {
        analyzedFrames++;
        captureTimes.push(message.captured_t);
        analyzedImage = message.image_base64;
        const observation = liveObservation(
          message.captured_t,
          true,
          config,
          message.seq,
        );
        observation.tables.T2 = "present";
        observation.tracks!.push({
          track_id: "independent-person-2",
          box: [0.3, 0.1, 0.6, 0.8],
          score: 0.9,
          observed: true,
          table_id: "T2",
          candidate_table_ids: ["T2"],
        });
        reply = engine.send({
          op: "observation",
          observation,
          now: Math.max(now, message.captured_t),
        });
        socket.send(
          JSON.stringify({
            type: "update",
            session_id: config.session_id,
            epoch: config.epoch,
            t: reply.snapshot.t,
            snapshot: reply.snapshot,
            stats: {
              processed_frames: message.seq,
              dropped_frames: 0,
              inference_ms: 1,
              frame_age_s: 0.01,
              analyzed_fps: 10,
              sampled_peak_rss_bytes: 1000,
            },
            frame: {
              seq: message.seq,
              captured_t: message.captured_t,
              image_base64: analyzedImage,
              width: 1280,
              height: 720,
            },
            observation,
          }),
        );
      }
      if (message.type === "staff") {
        reply = engine.send({
          op: "staff",
          event: {
            id: `browser-staff-${staffSeq}`,
            seq: staffSeq++,
            t: now,
            source: "staff",
            table_id: message.table_id,
            action: message.action,
            status: message.status,
          },
        });
        socket.send(
          JSON.stringify({
            type: "update",
            session_id: config.session_id,
            epoch: config.epoch,
            t: now,
            snapshot: reply.snapshot,
            stats: {
              processed_frames: 1,
              dropped_frames: 0,
              inference_ms: 1,
              frame_age_s: 0.01,
              analyzed_fps: 10,
              sampled_peak_rss_bytes: 1000,
            },
          }),
        );
      }
    });
  });
  await page.goto("/?source=browser-fixture");
  await page.evaluate(() => {
    const Base = window.WebSocket;
    window.WebSocket = new Proxy(Base, {
      construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        (window as unknown as { testSocket: WebSocket }).testSocket = socket;
        return socket;
      },
    });
  });
  await page.getByTestId("open-inputs").click();
  await page.getByTestId("camera-preview-start").click();
  await expect(page.getByTestId("camera-setup-save")).toBeEnabled();
  await page.getByTestId("camera-setup-save").click();
  expect(setupCapture.length).toBeGreaterThan(1000);
  await page.getByRole("button", { name: "Back to sources" }).click();
  await page.getByTestId("camera-reuse-confirmed").check();
  await page.getByTestId("detection-only").check();
  await page.getByTestId("live-start").click();
  await expect(page.getByTestId("live-analyzed-frame")).toBeVisible();
  await expect.poll(() => analyzedImage.length).toBeGreaterThan(1000);
  await expect
    .poll(
      async () =>
        (
          await page.getByTestId("live-analyzed-frame").getAttribute("src")
        )?.split(",")[1] === analyzedImage,
    )
    .toBe(true);
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { testConstraints: MediaStreamConstraints[] }
      ).testConstraints.every((value) => value.audio === false),
    ),
  ).toBe(true);
  await page.getByTestId("raw-preview-toggle").click();
  await expect(page.getByTestId("live-raw-preview")).toBeVisible();
  await expect(page.locator(".video-overlay")).toHaveCount(0);
  await page.getByTestId("raw-preview-toggle").click();
  await expect.poll(() => clockReplies).toBeGreaterThan(1);
  await page.waitForTimeout(150);
  expect(Math.max(...captureTimes)).toBeLessThan(10);
  await expect(page.getByTestId("people-state")).toContainText("Occupied", {
    timeout: 8000,
  });
  expect(
    await page.evaluate(() => {
      const socket = (window as unknown as { testSocket: WebSocket })
        .testSocket;
      Object.defineProperty(socket, "bufferedAmount", {
        configurable: true,
        get: () => 512 * 1024 + 1,
      });
      return socket.bufferedAmount;
    }),
  ).toBe(512 * 1024 + 1);
  await page.waitForTimeout(150);
  const beforeBlocked = analyzedFrames;
  await page.waitForTimeout(350);
  expect(analyzedFrames).toBe(beforeBlocked);
  await page.getByTestId("override-green").click();
  await expect(page.getByTestId("manual-override")).toContainText(/manual/i);
  liveSocket!.close({
    code: 1000,
    reason: "Independent transport-loss fixture",
  });
  await expect(page.getByTestId("live-connection-status")).toContainText(
    "Connection unavailable",
  );
  const age = await page.getByTestId("live-frame-age").textContent();
  await expect
    .poll(() => page.getByTestId("live-frame-age").textContent())
    .not.toBe(age);
  await page.getByTestId("table-T2").click();
  await expect(page.getByTestId("selected-status")).toContainText(
    "Connection unavailable",
  );
  await page.getByTestId("table-T1").click();
  await expect(page.getByTestId("selected-status")).toContainText(/manual/i);
  await page.getByTestId("live-stop").click();
  await expect.poll(() => deleted).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { testStreams: MediaStream[] }).testStreams
          .flatMap((stream) => stream.getTracks())
          .every((track) => track.readyState === "ended"),
      ),
    )
    .toBe(true);
  await page.waitForTimeout(150);
  expect(deleted).toBe(1);
  expect(stopped).toBe(false);
  expect(socketConnections).toBe(1);
});

test("L01 denied camera permission leaves a recoverable source workspace", async ({
  page,
}) => {
  await mockHealth(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Camera permission denied", "NotAllowedError");
    };
  });
  await page.goto("/?source=browser-fixture");
  await page.getByTestId("open-inputs").click();
  await page.getByTestId("camera-preview-start").click();
  await expect(page.getByRole("alert")).toContainText(
    "Camera permission denied",
  );
  await expect(page.getByTestId("camera-preview-start")).toBeEnabled();
  await expect(page.getByTestId("source-upload")).toBeAttached();
  await expect(page.getByTestId("live-start")).toHaveCount(0);
});

test("T03 saved long labels still load and search matches label and immutable ID", async ({
  page,
}) => {
  const bundle = JSON.parse(
    await readFile(path.resolve("tests/fixtures/workflow/bundle.json"), "utf8"),
  ) as Bundle;
  const legacyLabel =
    "Historic window reservation table with a label longer than forty characters";
  bundle.tables[0].label = legacyLabel;
  await page.route(
    "**/api/sources/browser-fixture/assets/bundle.json",
    (route) => route.fulfill({ json: bundle }),
  );
  await page.goto("/?source=browser-fixture");
  await expect(page.getByTestId("table-T1")).toHaveAttribute(
    "aria-label",
    new RegExp(legacyLabel),
  );
  await expect(page.getByTestId("bundle-error")).toHaveCount(0);
  await page.getByTestId("table-search").fill("historic WINDOW");
  await expect(page.locator('[data-testid^="table-list-"]')).toHaveCount(1);
  await expect(page.getByTestId("table-list-T1")).toContainText(legacyLabel);
  await page.getByTestId("table-search").fill("T1");
  await page.getByTestId("table-list-T1").click();
  await expect(page.getByTestId("current-crop")).toHaveAttribute(
    "aria-label",
    /T1 current/,
  );
});
