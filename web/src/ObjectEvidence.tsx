import { useState } from "react";
import type {
  Detection,
  ObjectBaseline,
  ObjectSurfaceEvidence,
  Table,
} from "../../shared/contracts";
import classes from "../../shared/coco-classes.json" with { type: "json" };
import {
  isUncorroboratedBackgroundGuess,
  REFERENCE_CLEANING_THRESHOLD,
} from "./object-surface";

export const objectName = (id: number) => classes[id] ?? `Object ${id}`;
export const inventoryClasses = classes
  .map((name, class_id) => ({ name, class_id }))
  .filter((item) => ![0, 56, 60].includes(item.class_id));

/** Boxes are normalized to this exact rectified assessment image, never a later camera frame. */
export function ObjectPhoto({
  image,
  detections,
  label,
}: {
  image: string;
  detections: Detection[];
  label: string;
}) {
  const [size, setSize] = useState({ width: 1000, height: 600 });
  const font = size.width * 0.03,
    anchors: { x: number; y: number }[] = [];
  return (
    <div className="object-photo" data-testid="object-photo">
      <img
        src={image}
        alt={label}
        onLoad={(event) =>
          setSize({
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          })
        }
      />
      <svg
        viewBox={`0 0 ${size.width} ${size.height}`}
        preserveAspectRatio="none"
        aria-label="Detected object boxes"
      >
        {detections
          .filter((item) => ![56, 60].includes(item.class_id))
          .map((item, index) => {
            const [x1, y1, x2, y2] = item.box;
            const anchor = {
              x: Math.max(0, Math.min(size.width * 0.65, x1 * size.width)),
              y: Math.max(font * 1.2, y1 * size.height - font * 0.2),
            };
            while (
              anchors.some(
                (old) =>
                  Math.abs(old.x - anchor.x) < size.width * 0.3 &&
                  Math.abs(old.y - anchor.y) < font * 1.2,
              ) &&
              anchor.y + font * 1.4 < size.height
            )
              anchor.y += font * 1.4;
            anchors.push(anchor);
            return (
              <g
                key={index}
                className={item.score < 0.5 ? "uncertain-object" : ""}
              >
                <title>
                  {objectName(item.class_id)} · {Math.round(item.score * 100)}%
                  confidence
                </title>
                <rect
                  x={x1 * size.width}
                  y={y1 * size.height}
                  width={(x2 - x1) * size.width}
                  height={(y2 - y1) * size.height}
                />
                <text
                  x={anchor.x}
                  y={anchor.y}
                  style={{ fontSize: font, strokeWidth: font * 0.22 }}
                >
                  {objectName(item.class_id)} {Math.round(item.score * 100)}%
                </text>
              </g>
            );
          })}
      </svg>
    </div>
  );
}

export function ExpectedInventory({
  baseline,
  onChange,
}: {
  baseline: ObjectBaseline;
  onChange: (baseline: ObjectBaseline) => void;
}) {
  const remaining = inventoryClasses.filter(
    (item) =>
      !baseline.expected.some(
        (expected) => expected.class_id === item.class_id,
      ),
  );
  return (
    <div className="expected-inventory" data-testid="expected-inventory">
      {baseline.expected.length === 0 && (
        <p>No objects detected. Review the photo and add any expected items.</p>
      )}
      {baseline.expected.map((item) => (
        <div className="inventory-row" key={item.class_id}>
          <label htmlFor={`expected-${item.class_id}`}>
            {objectName(item.class_id)}
          </label>
          <input
            id={`expected-${item.class_id}`}
            data-testid={`expected-count-${item.class_id}`}
            aria-label={`Expected ${objectName(item.class_id)} count`}
            type="number"
            min="0"
            max="100"
            step="1"
            value={item.count}
            onChange={(event) =>
              onChange({
                ...baseline,
                approved: false,
                expected: baseline.expected.map((old) =>
                  old.class_id === item.class_id
                    ? {
                        ...old,
                        count: Math.max(
                          0,
                          Math.min(100, Math.trunc(Number(event.target.value))),
                        ),
                      }
                    : old,
                ),
              })
            }
          />
          <button
            className="text-button"
            aria-label={`Remove expected ${objectName(item.class_id)}`}
            onClick={() =>
              onChange({
                ...baseline,
                approved: false,
                expected: baseline.expected.filter(
                  (old) => old.class_id !== item.class_id,
                ),
              })
            }
          >
            Remove
          </button>
        </div>
      ))}
      <label>
        Add a supported object
        <select
          data-testid="expected-add-class"
          value=""
          onChange={(event) => {
            if (event.target.value !== "")
              onChange({
                ...baseline,
                approved: false,
                expected: [
                  ...baseline.expected,
                  { class_id: Number(event.target.value), count: 1 },
                ].sort((a, b) => a.class_id - b.class_id),
              });
          }}
        >
          <option value="">Choose an object…</option>
          {remaining.map((item) => (
            <option key={item.class_id} value={item.class_id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

type AssessmentEvidence = {
  t: number;
  reason: string;
  object_evidence?: ObjectSurfaceEvidence;
  crop_base64?: string;
};
export function ObjectEvidence({
  table,
  assessment,
  image,
}: {
  table: Table;
  assessment?: AssessmentEvidence | null;
  image?: string;
}) {
  if (
    table.surface_method !== "objects_reference_v1" &&
    !assessment?.object_evidence
  )
    return null;
  const expected = table.object_baseline?.expected ?? [],
    evidence = assessment?.object_evidence;
  const uncertain = (item: Detection) =>
    item.score < 0.5 ||
    (!!evidence && isUncorroboratedBackgroundGuess(table, evidence, item));
  const ids = [
    ...new Set([
      ...expected.map((item) => item.class_id),
      ...(evidence?.detections ?? [])
        .filter((item) => ![0, 56, 60].includes(item.class_id))
        .map((item) => item.class_id),
    ]),
  ].sort((a, b) => a - b);
  return (
    <div className="object-evidence" data-testid="object-evidence">
      <h3>Expected objects</h3>
      {!table.object_baseline?.approved && (
        <p className="baseline-needed">
          Approve expected objects in table setup to enable automatic readiness.
        </p>
      )}
      {evidence && image && (
        <figure>
          <figcaption>
            Last assessed tabletop · {assessment!.t.toFixed(2)} s
          </figcaption>
          <ObjectPhoto
            image={image}
            detections={evidence.detections}
            label={`${table.label} assessed tabletop at ${assessment!.t.toFixed(2)} seconds`}
          />
        </figure>
      )}
      {ids.length ? (
        <table>
          <thead>
            <tr>
              <th>Object</th>
              <th>Expected</th>
              <th>Detected</th>
              <th>Uncertain</th>
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => (
              <tr key={id}>
                <th>{objectName(id)}</th>
                <td>
                  {expected.find((item) => item.class_id === id)?.count ?? 0}
                </td>
                <td>
                  {evidence
                    ? evidence.detections.filter(
                        (item) => item.class_id === id && !uncertain(item),
                      ).length
                    : "—"}
                </td>
                <td>
                  {evidence
                    ? evidence.detections.filter(
                        (item) => item.class_id === id && uncertain(item),
                      ).length
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>
          {table.object_baseline?.approved
            ? "No objects expected."
            : "No inventory approved."}
        </p>
      )}
      {evidence?.detections.some((item) =>
        isUncorroboratedBackgroundGuess(table, evidence, item),
      ) && (
        <p className="object-measurements">
          A broad object label is uncertain because the tabletop photo still
          matches.
        </p>
      )}
      {assessment ? (
        <p className="object-decision">{assessment.reason}</p>
      ) : (
        <p>No tabletop assessment yet.</p>
      )}
      {evidence?.reference.alignment?.applied && (
        <p
          className="object-measurements"
          data-testid="reference-framing-correction"
        >
          Small framing offset corrected.
        </p>
      )}
      {evidence && (
        <>
          <p
            className="object-measurements"
            data-testid="object-reference-difference"
          >
            Last assessed reference difference:{" "}
            {evidence.reference.changed_fraction === null
              ? "unavailable"
              : `${(evidence.reference.changed_fraction * 100).toFixed(2)}%`}{" "}
            · Cleaning threshold: above{" "}
            {(REFERENCE_CLEANING_THRESHOLD * 100).toFixed(2)}% · Assessment
            time: {assessment!.t.toFixed(2)} s
            {evidence.reference.reason ? ` · ${evidence.reference.reason}` : ""}
          </p>
          <p className="object-measurements">
            This is the last measured capture. Colour also depends on vacancy,
            visibility and follow-up checks. After cleaning, repeated matching
            captures confirm green; confirmed occupancy stays yellow.
          </p>
        </>
      )}
    </div>
  );
}
