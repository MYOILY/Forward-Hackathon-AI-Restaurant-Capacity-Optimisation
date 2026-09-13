import type { Bundle } from "../../shared/contracts";
import {
  isSafeMediaPath,
  validateImageAsset,
  validateReferenceImageSource,
} from "./validation";

export async function sha256Blob(blob: Blob): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(hash)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}

/** Authenticate the actual evidence files before a recording is opened. */
export async function verifyBundleAssets(
  bundle: Bundle,
  readAsset: (path: string) => Promise<Blob | null>,
): Promise<void> {
  const expected = new Map<string, string>();
  const add = (path: string, hash: string) => {
    if (
      !isSafeMediaPath(path) ||
      typeof hash !== "string" ||
      !/^[a-f\d]{64}$/i.test(hash)
    )
      throw new Error("Evidence requires a safe media path and valid SHA-256.");
    if (expected.has(path) && expected.get(path) !== hash.toLowerCase())
      throw new Error(`Conflicting SHA-256 declarations for ${path}.`);
    expected.set(path, hash.toLowerCase());
  };
  if (bundle.floor_plan) {
    validateImageAsset(bundle.floor_plan, "Floor plan");
    add(bundle.floor_plan.file, bundle.floor_plan.sha256);
  }
  for (const table of bundle.tables)
    if (table.reference) {
      validateReferenceImageSource(table.reference, bundle.video.source_kind === "browser_file" ? {
        width: bundle.video.processing_width!, height: bundle.video.processing_height!,
      } : bundle.video);
      add(table.reference.file, table.reference.sha256!);
      if (table.reference.source_image)
        add(
          table.reference.source_image.file,
          table.reference.source_image.sha256,
        );
    }
  for (const assessment of bundle.assessments ?? [])
    add(assessment.crop_file, assessment.crop_sha256);
  const entries = [...expected];
  for (let index = 0; index < entries.length; index += 4)
    await Promise.all(
      entries.slice(index, index + 4).map(async ([path, hash]) => {
        let blob: Blob | null;
        try {
          blob = await readAsset(path);
        } catch {
          throw new Error(
            `Unable to read evidence file ${path} for SHA-256 verification.`,
          );
        }
        if (!blob)
          throw new Error(
            `Evidence file ${path} is missing; SHA-256 verification failed.`,
          );
        if ((await sha256Blob(blob)) !== hash)
          throw new Error(`SHA-256 hash mismatch for evidence file ${path}.`);
      }),
    );
}
