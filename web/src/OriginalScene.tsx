import { useState } from "react";
import type { Bundle, ImageAsset } from "../../shared/contracts";
import "./original-scene.css";

export function uploadedOriginal(
  bundle: Bundle | undefined,
  selectedTableId?: string,
): ImageAsset | undefined {
  const selected = bundle?.tables.find(
    (table) => table.id === selectedTableId,
  )?.reference;
  if (selected?.source_kind === "uploaded_image" && selected.source_image)
    return selected.source_image;
  return bundle?.tables.find(
    (table) =>
      table.reference?.source_kind === "uploaded_image" &&
      table.reference.source_image,
  )?.reference?.source_image;
}

export function OriginalScene({
  uploadedPhoto,
  openingFrame,
  openingTime,
  provenance,
  sourceId,
  onChangeReference,
}: {
  uploadedPhoto?: string;
  openingFrame?: string;
  openingTime: string | null;
  provenance?: Bundle["provenance"];
  sourceId?: string;
  onChangeReference?: () => void;
}) {
  const [showOpening, setShowOpening] = useState(false);
  const showingUpload = !!uploadedPhoto && !showOpening;
  const synthetic = provenance === "synthetic_fixture",
    generated = provenance === "ai_generated_video";
  return (
    <div className="original-scene-content">
      <img
        className="original-image"
        data-testid="original-scene"
        src={showingUpload ? uploadedPhoto : openingFrame}
        alt={
          showingUpload
            ? "Saved uploaded empty-restaurant reference photo"
            : synthetic
              ? "Untouched synthetic setup illustration"
              : generated
                ? "Original frame from AI-generated restaurant video"
                : "Recording setup frame"
        }
      />
      {showingUpload ? (
        <p data-testid="original-scene-provenance">
          <strong>Saved reference photo.</strong> This is the full uploaded
          photo used for the table references in this analysis.
        </p>
      ) : (
        <>
          <p data-testid="original-scene-timestamp">
            {openingTime === null
              ? "Source video timestamp unavailable."
              : `Source video timestamp: ${openingTime}`}
          </p>
          <p>
            {synthetic
              ? "Synthetic workflow illustration. This is not a real restaurant photograph or detection evidence."
              : generated
                ? "Original frame from the AI-generated source video. The model ran on generated footage; this is not a real restaurant recording or cleanliness evidence."
                : "Recording setup frame. This frame is kept separately from your uploaded reference photo."}
          </p>
        </>
      )}
      <div className="original-scene-actions">
        {sourceId && (
          <a
            className="button dark"
            data-testid="change-reference-photo"
            href={`?setup=${encodeURIComponent(sourceId)}&step=references`}
            onClick={(event) => {
              if (
                onChangeReference &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.shiftKey &&
                !event.altKey
              ) {
                event.preventDefault();
                onChangeReference();
              }
            }}
          >
            Change reference photo
          </a>
        )}
        {uploadedPhoto && openingFrame && (
          <button
            className="button secondary"
            onClick={() => setShowOpening((value) => !value)}
          >
            {showingUpload
              ? "View recording setup frame"
              : "View saved reference photo"}
          </button>
        )}
      </div>
      {sourceId ? (
        <p className="original-scene-help">
          To change the photo, upload a replacement in setup, confirm its
          framing, and review each table’s reference and expected objects.
          Analyze the recording again to use the new reference.
        </p>
      ) : (
        <p className="original-scene-help">
          To change this reference, open its saved source from video selection.
          Imported bundle folders are view-only.
        </p>
      )}
    </div>
  );
}
