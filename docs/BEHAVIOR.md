# Table status and evidence

For where these states appear and how to use the controls, see the
[dashboard usage guide](USAGE.md#8-use-the-dashboard).

TurnTable keeps person occupancy and tabletop evidence separate, then derives a
service colour. All automatic tables start **Grey · Verifying**. An approved
reference photo alone does not make a table green.

| Colour | Meaning |
| --- | --- |
| Yellow · Occupied | A tracked person has completed the configured arrival wait |
| Red · Needs cleaning | A vacant, visible tabletop has qualifying evidence that it needs reset |
| Green · Ready | Valid vacancy and the required matching reference/object checks have completed |
| Grey · Verifying | Evidence is pending, missing, ambiguous, obstructed or invalid |

## People and tabletop timing

The default arrival and vacancy waits are five seconds of valid source evidence.
The same anonymous person must qualify the arrival; separate short visits cannot
combine. Predictions preserve identity briefly but do not add observed dwell.
New person evidence removes automatic readiness immediately. Configured timing
in accepted current-format recordings is respected.

After people leave, status can first become grey. A cleaning alert can follow
after one second of continuous valid absence and one second of unobstructed
tabletop evidence. Automatic green still requires the full vacancy wait.

Initial readiness needs two positive captures at least two source seconds apart,
following five valid vacant seconds. The earliest initial green with default
timings and qualifying evidence is seven seconds. After a cleaning alert,
readiness instead needs at least three matching captures spanning five seconds.
Red remains visible during valid, unobstructed confirmation. Obstruction or
ambiguous evidence produces grey and restarts confirmation.

Regular surface checks and dirty retries occur every two seconds. Inconclusive
evidence is retried after one second. Automatic clearance expires ten seconds
after the last successful capture; pending or slow work cannot renew it.

These are source/video seconds. Playback at 3× makes a five-second source wait
take about 1.7 wall seconds. Explicit accelerated fixture timing, when present,
is distinct from playback speed and cannot reduce required capture counts or be
used for live cameras.

## Comparing with the approved setup

YOLOX-Tiny detects objects in a perspective-corrected crop. A separate deterministic
comparison measures its changed area against the approved reference.

- **More than 10%** changed area is evidence that a valid, observable tabletop
  needs reset.
- **10% or less** can support a positive result only when object counts, image
  quality, vacancy and confirmation checks also pass.
- Uncertain guesses about extra objects need corroborating visual difference.
  Unexpected detections covering at least 80% of the tabletop also need this
  corroboration; people and explicitly expected items are not discounted.
- Confident extra/missing-object evidence without an above-threshold visual
  difference needs a consistent second capture at least one second later.
  An expected item supported only by uncertain detections still needs another
  usable check.
- A change between corrected and uncorrected image framing needs a stable
  follow-up capture. The first unconfirmed result remains uncertain.

Small translation can be corrected when distributed image features support
registration correlation of at least 0.85, within 2.5% of each crop dimension.
There is no rotation, scale or shear correction. Edge strips remain measurable;
failed registration uses the original comparison. Detection uses the raw crop,
and the saved evidence images remain unchanged.

People obstructing the tabletop, darkness, invalid reference identity or unreliable
evidence block automatic readiness. Actual camera displacement or a scene cut
invalidates calibration. Camera movement is checked against the original view
using background evidence, excluding detected foreground where possible.

Measurement settings, decision policy and alignment settings have separate
identities in [the shared configuration](../shared/). Their recorded identifiers
must not be renamed merely to simplify filenames.

## Staff controls and monitoring

**Confirm cleaned** requires stable vacancy and usable visibility. **Force clean**
can override tabletop verification after stable valid vacancy, but cannot replace
an occupied, pending or uncertain people state. It records manual provenance.

The separate Red, Yellow, Green and Grey controls force the displayed colour
until another colour, **Auto**, or session reset. The underlying evidence remains
visible, and a forced green is not measured as successful automatic readiness.

Disabling monitoring leaves a table selectable but excludes it from active
counts and new surface work. Live monitoring requires fresh usable evidence when
re-enabled. Recorded playback instead recalculates the status from the recording's
existing evidence at the selected timestamp; toggling clears that table's staff
actions from the current playback session. Browser monitoring preferences are
scoped to the source and reviewed geometry.

The displayed comparison percentage belongs to its measured capture. Current
status also depends on freshness, occupancy and confirmation. A difference from
an approved setup is not proof of sanitation or real-restaurant accuracy.
