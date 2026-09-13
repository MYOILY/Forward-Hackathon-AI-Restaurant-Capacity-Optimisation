import type { Table } from "../../shared/contracts";
import {
  createRectificationPlan,
  rectifyRgba,
  type RectificationPlan,
} from "./rectification";
/** One selected-table cache keeps memory bounded as the floor grows. */
export function createCurrentCropRenderer() {
  let cacheKey = "",
    lastFrame = -1;
  let plan: RectificationPlan | undefined, output: ImageData | undefined;
  let sourceCanvas: HTMLCanvasElement | undefined;
  let previousTarget: HTMLCanvasElement | undefined;
  return (
    media: HTMLVideoElement,
    target: HTMLCanvasElement,
    table: Table,
    fps: number,
    frameTime = media.currentTime,
    exactTimestamp = false,
  ): void => {
    if (media.readyState < 2) return;
    const width = media.videoWidth,
      height = media.videoHeight;
    if (!width || !height) return;
    const key = JSON.stringify([
      media.currentSrc,
      table.id,
      table.tabletop_polygon,
      width,
      height,
    ]);
    if (key !== cacheKey || target !== previousTarget) {
      cacheKey = key;
      previousTarget = target;
      lastFrame = -1;
      plan = undefined;
      output = undefined;
    }
    // requestVideoFrameCallback supplies the decoded frame's source time. The
    // nominal frame index also deduplicates paused timeupdate/seeked events.
    const frame = exactTimestamp ? frameTime : Math.floor(frameTime * fps + 1e-5);
    if (lastFrame === frame) return;
    const context = target.getContext("2d");
    if (!context)
      throw new Error(
        "The browser could not display the current table picture.",
      );
    {
      if (!plan)
        plan = createRectificationPlan(table.tabletop_polygon!, width, height);
      if (!sourceCanvas) sourceCanvas = document.createElement("canvas");
      if (sourceCanvas.width !== width || sourceCanvas.height !== height) {
        sourceCanvas.width = width;
        sourceCanvas.height = height;
      }
      const sourceContext = sourceCanvas.getContext("2d", {
        willReadFrequently: true,
      });
      if (!sourceContext)
        throw new Error("The browser could not read the current video frame.");
      sourceContext.drawImage(media, 0, 0, width, height);
      const source = sourceContext.getImageData(0, 0, width, height);
      if (!output) output = context.createImageData(plan.width, plan.height);
      rectifyRgba(plan, source.data, output.data);
      if (target.width !== plan.width || target.height !== plan.height) {
        target.width = plan.width;
        target.height = plan.height;
      }
      context.putImageData(output, 0, 0);
    }
    lastFrame = frame;
  };
}
