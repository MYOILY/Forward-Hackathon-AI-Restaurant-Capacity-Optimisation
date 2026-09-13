import { describe, expect, it, vi } from "vitest";
import type { ImageAsset } from "../../shared/contracts";
import { sha256Blob, verifyBundleAssets } from "../../web/src/assets";
import {
  validateBundle,
  validateImageAsset,
  verifyBundleGeometry,
} from "../../web/src/validation";
import { legacyFixture } from "./fixtures";
import { replayFixture } from "./replay-fixtures";

async function assetFixture() {
  const bundle = replayFixture(2);
  const files = new Map<string, Blob>([
    [
      "references/table-crop.png",
      new Blob(["the approved rectified tabletop crop"]),
    ],
    [
      "setup/clean-reference.png",
      new Blob([
        "the complete independently uploaded clean-reference photograph",
      ]),
    ],
    [
      "setup/floor-plan.png",
      new Blob(["the uploaded restaurant floor-plan image"]),
    ],
  ]);
  const descriptor = async (file: string): Promise<ImageAsset> => ({
    file,
    sha256: await sha256Blob(files.get(file)!),
    width: 1200,
    height: 800,
  });
  const source_image = await descriptor("setup/clean-reference.png");
  source_image.width = bundle.video.width;
  source_image.height = bundle.video.height;
  bundle.floor_plan = await descriptor("setup/floor-plan.png");
  bundle.tables[0].reference = {
    file: "references/table-crop.png",
    sha256: await sha256Blob(files.get("references/table-crop.png")!),
    source_t: 0,
    confirmed_clean: true,
    source_kind: "uploaded_image",
    source_image,
    alignment_confirmed: true,
  };
  bundle.tables[0].setup_review = {
    tabletop: true,
    occupancy: true,
    map: true,
  };
  const readAsset = vi.fn(async (path: string) => files.get(path) ?? null);
  return { bundle, files, readAsset };
}

describe("uploaded setup image contracts and evidence verification", () => {
  it("verifies the floor plan, full clean photograph and approved crop independently", async () => {
    const { bundle, readAsset } = await assetFixture();
    validateBundle(bundle);
    await verifyBundleAssets(bundle, readAsset);
    expect(readAsset.mock.calls.map(([file]) => file).sort()).toEqual([
      "references/table-crop.png",
      "setup/clean-reference.png",
      "setup/floor-plan.png",
    ]);
  });
  it.each(["setup/clean-reference.png", "setup/floor-plan.png"])(
    "rejects a missing source image: %s",
    async (file) => {
      const { bundle, files, readAsset } = await assetFixture();
      files.delete(file);
      await expect(verifyBundleAssets(bundle, readAsset)).rejects.toThrow(
        /missing/,
      );
    },
  );
  it.each(["setup/clean-reference.png", "setup/floor-plan.png"])(
    "rejects tampering in %s even when the reference crop is valid",
    async (file) => {
      const { bundle, files, readAsset } = await assetFixture();
      files.set(file, new Blob(["replacement data"]));
      await expect(verifyBundleAssets(bundle, readAsset)).rejects.toThrow(
        /hash mismatch/,
      );
    },
  );
  it("deduplicates a shared clean photograph across table references", async () => {
    const { bundle, readAsset } = await assetFixture();
    bundle.tables.push({ ...structuredClone(bundle.tables[0]), id: "T2" });
    await verifyBundleAssets(bundle, readAsset);
    expect(
      readAsset.mock.calls.filter(
        ([file]) => file === "setup/clean-reference.png",
      ),
    ).toHaveLength(1);
    expect(
      readAsset.mock.calls.filter(
        ([file]) => file === "references/table-crop.png",
      ),
    ).toHaveLength(1);
  });
  it("rejects conflicting digests for a reused path before reading files", async () => {
    const { bundle, readAsset } = await assetFixture();
    bundle.floor_plan!.file = bundle.tables[0].reference!.source_image!.file;
    await expect(verifyBundleAssets(bundle, readAsset)).rejects.toThrow(
      /Conflicting SHA-256/,
    );
    expect(readAsset).not.toHaveBeenCalled();
  });
  it.each([
    "../floor.png",
    "/floor.png",
    "https://example.com/floor.png",
    "setup/%2e%2e/floor.png",
    "setup\\floor.png",
  ])("rejects unsafe image paths before asset access: %s", async (file) => {
    const { bundle, readAsset } = await assetFixture();
    bundle.floor_plan!.file = file;
    expect(() => validateBundle(bundle)).toThrow(/Floor plan/);
    await expect(verifyBundleAssets(bundle, readAsset)).rejects.toThrow(
      /Floor plan/,
    );
    expect(readAsset).not.toHaveBeenCalled();
  });
  it.each([
    { width: 0 },
    { height: 8193 },
    { width: 4001, height: 4000 },
    { width: 1.2 },
    { height: NaN },
    { sha256: "incorrect" },
  ])(
    "rejects invalid image dimensions or content identity: %j",
    async (invalid) => {
      const { bundle } = await assetFixture();
      expect(() =>
        validateImageAsset({ ...bundle.floor_plan, ...invalid }),
      ).toThrow();
    },
  );
  it("accepts the exact limits on declared dimensions and pixel count", () => {
    const asset = {
      file: "floor.png",
      sha256: "a".repeat(64),
      width: 4000,
      height: 4000,
    };
    expect(() => validateImageAsset(asset)).not.toThrow();
    expect(() =>
      validateImageAsset({ ...asset, width: 8192, height: 1 }),
    ).not.toThrow();
  });
  it.each(["width", "height"] as const)(
    "rejects a clean source photograph whose %s differs from the source video",
    async (dimension) => {
      const { bundle, readAsset } = await assetFixture();
      bundle.tables[0].reference!.source_image![dimension] += 1;
      expect(() => validateBundle(bundle)).toThrow(/dimensions must match/);
      await expect(verifyBundleAssets(bundle, readAsset)).rejects.toThrow(
        /dimensions must match/,
      );
      expect(readAsset).not.toHaveBeenCalled();
    },
  );
  it.each([
    "missing-source",
    "unsafe-source",
    "unaligned",
    "wrong-time",
    "missing-provenance",
  ])(
    "rejects incomplete or inconsistent uploaded reference metadata: %s",
    async (mode) => {
      const { bundle, readAsset } = await assetFixture(),
        reference = bundle.tables[0].reference!;
      if (mode === "missing-source") delete reference.source_image;
      else if (mode === "unsafe-source")
        reference.source_image!.file = "../outside.png";
      else if (mode === "unaligned") reference.alignment_confirmed = false;
      else if (mode === "wrong-time") reference.source_t = 1;
      else delete reference.source_kind;
      expect(() => validateBundle(bundle)).toThrow();
      await expect(verifyBundleAssets(bundle, readAsset)).rejects.toThrow();
      expect(readAsset).not.toHaveBeenCalled();
    },
  );
  it("does not change geometry identity when map presentation or review annotations change", async () => {
    const { bundle } = await assetFixture();
    await verifyBundleGeometry(bundle);
    const previous = bundle.tables[0].geometry_sha256;
    bundle.tables[0].map.x = 0.8;
    bundle.tables[0].setup_review!.map = false;
    await verifyBundleGeometry(bundle);
    expect(bundle.tables[0].geometry_sha256).toBe(previous);
  });
  it.each([
    {},
    { tabletop: true, occupancy: true },
    { tabletop: true, occupancy: true, map: "yes" },
    { tabletop: true, occupancy: true, map: true, extra: false },
  ])(
    "requires exactly three boolean review flags when supplied: %j",
    async (setup_review) => {
      const { bundle } = await assetFixture();
      Object.assign(bundle.tables[0], { setup_review });
      expect(() => validateBundle(bundle)).toThrow(/setup review/);
    },
  );
  it("validates video-frame references without uploaded-image metadata", async () => {
    const { bundle, readAsset } = await assetFixture();
    delete bundle.floor_plan;
    delete bundle.tables[0].setup_review;
    const reference = bundle.tables[0].reference!;
    delete reference.source_kind;
    delete reference.source_image;
    delete reference.alignment_confirmed;
    validateBundle(bundle);
    await verifyBundleAssets(bundle, readAsset);
    expect(readAsset.mock.calls.map(([file]) => file)).toEqual([
      "references/table-crop.png",
    ]);
  });
  it("rejects historical recording formats before reading evidence", () => {
    expect(() => validateBundle(legacyFixture())).toThrow(
      /Reprocess the original video/,
    );
  });
});
