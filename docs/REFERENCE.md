# Commands and interfaces

Run commands from the repository root. The Python service and processor require
Python 3.11. The shared headless decision engine requires Node.js. Video
normalization uses FFmpeg/ffprobe. Install the complete locked environment as
shown in the [README](../README.md).

Those runtime commands describe the shared-workspace service. The stateless
recording mode uses Python frame/image inference and browser decisions, with no
Node or FFmpeg process inside Lambda. Its local adapter and deployment commands
are in [Stateless deployment](STATELESS_DEPLOYMENT.md).

## Stateless recording interface

Build with `VITE_PROCESSING_MODE=stateless` and
`VITE_STATELESS_API_URL=https://your-function-url`. The JSON contract
is [frame-batch-contracts.ts](../shared/frame-batch-contracts.ts); request, image,
checkpoint and local-video ceilings are in
[frame-batch-limits.json](../shared/frame-batch-limits.json).

| Method and path | Purpose |
| --- | --- |
| `GET /frames/capabilities` | Model/build/config identity, availability and limits |
| `POST /frames/propose-tables` | Unapproved geometry from one transmitted frame |
| `POST /frames/propose-reference` | Rectified image and unapproved object baseline |
| `POST /frames/observe-batch` | Ordered observations and portable continuation checkpoint |
| `POST /frames/assess-batch` | Requested tabletop/reference measurements and evidence crops |

Every POST carries run/request identity, model/configuration/build identity,
source description, revision, reviewed table setup and bounded encoded frames.
Observation retries reuse the same prior
checkpoint and byte-identical request. No endpoint accepts whole recordings or
persists results. The `/api` service below remains available for the local/EC2
shared-workspace deployment.

## Processor

For a complete first run, use [guided setup](SETUP.md#try-the-demo) and start
analysis in the browser. The CLI is useful for rerunning an already reviewed
recording or developing the processor.

```sh
.venv/bin/python -m processor --help
.venv/bin/python -m processor download-model --model tiny --model-dir models
```

### Reanalyze a reviewed recording

In the shared-workspace UI, upload a video and complete **Finish reviewed setup**.
The native service saves its `layout.json`, normalized video and reference assets
under `data/sources/SOURCE_ID/`. Find the source ID by opening
[/api/jobs](http://127.0.0.1:5173/api/jobs) and matching its label. After opening
completed playback, the ID also appears in the URL as `?source=…`. A fresh setup
may still show `?setup=new`; `new` is not a source ID. Replace
`SOURCE_ID` below with that ID. If you configured `TABLEWATCH_DATA_DIR`, use that
directory instead of `data/sources`.

Run this from the same native environment, using a new output directory:

```sh
.venv/bin/python -m processor analyze \
  --video data/sources/SOURCE_ID/media/source.mp4 \
  --layout data/sources/SOURCE_ID/layout.json \
  --out output/reanalysis \
  --model-dir models
```

The processed video's path is recorded in `layout.json` under `video.file`;
`media/source.mp4` is the native upload path. Use that video, since normalization
can change the original upload's bytes and timing. Keep the saved source directory
and its reference assets together. For Docker deployments, these paths live in
the data volume inside the container, not in a host `data/sources/` folder.

The result is `output/reanalysis/bundle.json` with its media and evidence assets.
Use **Back to dashboard → Open bundle** to open that complete output
folder in the shared-workspace UI. A completed analysis started in the browser
already has `bundle.json` inside its saved source directory.

### Generate a draft with the CLI

`processor prepare` proposes geometry and captures source references, but its
layout is unapproved. It is an advanced draft-generation command, not a complete
prepare-then-analyze tutorial. The UI does not import arbitrary CLI layouts.
Upload the recording through the UI for guided approval, then use the reviewed
layout as shown above. Do not set approval flags by hand to bypass review.

```sh
.venv/bin/python -m processor prepare --help
```

`--model tiny` is the default detector. Nano and S remain optional CPU detector
choices, but automatic tabletop checks use the verified Tiny model.
`--skip-surface` produces explicitly incomplete detection-only analysis.
`--provenance` identifies real, AI-generated or synthetic footage. Supplying a
provenance label does not replace actual model evidence or independent labels.
Run each subcommand with `--help` for its exact supported arguments.

Recordings use one current format with no schema number or format selection.
`video.source_kind` identifies either the original `browser_file` or the local
processor's `processed_file`; it describes the source, not a different format.
Browser recordings hash the original client file and identify every transmitted
capture by its actual presentation timestamp, sample sequence, processing
dimensions and image hash. Analysis metadata records the run, setup revision
and processor identities; exact reference and evidence bytes remain in the tab
for verification. Processing uses the automatic decision policy. Previously
exported numbered bundles are unsupported; reprocess their original recording
through reviewed setup. Old policy-selection and Qwen CLI options have been
removed.

## Evaluation label format

Use this section when preparing independent annotations for
[evaluation](VALIDATION.md#evaluate-your-restaurant-footage). Normal setup and
playback do not require label files.

The [example label JSON](examples/labels.synthetic.json) describes a hypothetical
synthetic ten-second recording with one table, `T1`: a person is present from
time zero and qualifies as occupied at five seconds. Its all-zero video hash is
a placeholder. **It is a format example, not labels for the bundled demo.**
Its structure has been checked against the label validator using matching
hypothetical metadata; no footage or accuracy claim accompanies it.

Copy its structure, then author your own intervals and outcomes while watching
the analyzed source video independently of the app's predictions. Use source
seconds, even if you watch at a different playback speed. Read
[Behavior](BEHAVIOR.md) to distinguish physical occupancy from the delayed service
status. For example, a physically occupied table can still be pending arrival.

Required top-level fields:

| Field | What to supply |
| --- | --- |
| `policy` | `"automatic"`; do not add a `schema_version` field |
| `provenance` | `manual_real_video` for a `real_video` bundle; `manual_ai_video` for `ai_generated_video`; `synthetic_fixture` for `synthetic_fixture` |
| `video_sha256` | Copy `video.sha256` from the reviewed bundle; label that exact recording's timeline |
| `intervals` | A nonempty array covering each table from zero to `video.duration_s`, without gaps or overlaps |
| `transitions` | Expected status changes; use `[]` only if there are none |
| `staff_events` | Independently recorded staff actions; use `[]` if there were none |

Shared-workspace uploads are normalized. Do not substitute the original upload's
hash or assume its timestamps are identical. The evaluator also checks the
bundled video bytes. A provenance string must describe the actual source; changing
it cannot turn synthetic material into real-video evidence.

Every interval needs these fields:

| Field | Allowed values or meaning |
| --- | --- |
| `table_id` | A table ID from `bundle.json` → `tables`, not its display name |
| `start`, `end` | Source seconds, with `0 ≤ start < end ≤ video.duration_s` |
| `occupancy` | `occupied`, `vacant`, `unobservable` |
| `surface_condition` | Independently observed `cleared_reset`, `needs_reset`, or `unobservable` |
| `expected_status` | `unknown` (grey), `ready` (green), `occupied` (yellow), `needs_cleaning` (red) |
| `expected_people_state` | `vacant`, `pending_arrival`, `occupied`, `pending_departure`, `uncertain` |
| `expected_surface_state` | `cleared_reset`, `needs_reset`, `unverified` |
| `evaluable` | JSON `true` or `false`; keep uncertain/unobservable periods in the timeline rather than deleting them |

Each transition needs `table_id`, `status`, `physical_t` (when the physical change
occurred), `expected_t` (when the service should change), and `tolerance_s`.
Use `0 ≤ physical_t ≤ expected_t ≤ duration` and a tolerance from 0 to 0.1 seconds.

Staff events require a unique `id`, source time `t`, `table_id`, integer `seq`,
`source` (`setup` or `staff`), and `action`. The pair `(t, seq)` must be unique.
Both sources support `confirm_cleaned` and `needs_cleaning`; `staff` also supports
`force_cleaned`, `force_status` and `clear_status_override`. Only `force_status`
includes a `status`, using the four status values above.

Optional `tracking_frames` contains independent anonymous person identities and
boxes. Omit it if you are not measuring tracking. The complete validation,
including optional monitoring exclusions and tracking fields, is in
[evaluator/labels.py](../evaluator/labels.py). Disabling a table in the UI alone
does not create an independent evaluation exclusion.

## Browser and service entry points

| Command | Purpose |
| --- | --- |
| `npm run dev:full` | Start the service and Vite together |
| `npm run service` | Start the Python service alone |
| `npm run dev` | Start Vite; the setup screen still needs the service |
| `npm run build` | Type-check and build the production UI |
| `npm test` | Run TypeScript behavioral tests |
| `npm run test:browser` | Run browser checks with controlled fixtures |

In the shared-workspace service, `/` opens fresh setup. Saved-source and setup
links select server-managed source IDs; example folders are not scanned. The
service serves the production UI from
the configured static directory. API requests stay on the same origin in a
hosted EC2 deployment. The hosted recording demo instead uses the separate
[`/frames` API](STATELESS_DEPLOYMENT.md#how-this-deployment-works) on Lambda.

## HTTP API

All paths below belong to the shared-workspace service and are under `/api`.
The public EC2 deployment authenticates every request at the proxy, including
health and asset requests. See
[the route implementation](../service/app.py) and
[the browser contract](../shared/live-contracts.ts) for complete payload types.

| Method and path | Purpose |
| --- | --- |
| `GET /live` | Model-independent process liveness |
| `GET /ready` | Verified detector/surface model readiness; 503 when unavailable |
| `GET /health` | UI health, model capabilities, limits and active work |
| `POST /videos` | Multipart `file`, optional `manual_setup`; starts preparation |
| `GET /jobs`, `GET /jobs/{id}`, `GET /sources/{id}` | List/read saved source progress and state |
| `POST /jobs/{id}/cancel` | Cancel work and release its resources |
| `GET /sources/{id}/assets/{path}` | Source-scoped media with Range support; paths are validated |
| `PUT /sources/{id}/setup-assets/{kind}` | Upload a setup image with the current revision |
| `POST /sources/{id}/frame` | Capture a selected recording time using JSON `t` |
| `PUT /sources/{id}/calibration` | Save reviewed geometry, references, floor plan, drafts and approvals |
| `POST /sources/{id}/baseline-proposal` | Propose expected objects; does not grant approval |
| `POST /sources/{id}/analyze` | Start analysis with explicit `detection_only` |
| `GET /cameras`, `POST /cameras` | List reviewed camera setups or prepare a setup capture |
| `POST /live` | Start monitoring with `source_id` and `detection_only` |
| `DELETE /live/{id}` | Stop monitoring and release camera workers |

Source mutations use revision checks. A stale revision must be reloaded/reviewed,
not silently retried as an unconditional overwrite. Approved visual evidence
cannot be restored by submitting an old proposal after its source changed.

## Live protocol and replay

Connect to the relative WebSocket endpoint returned when creating a live
session: `/api/live/{id}/stream`. Browser commands include clock synchronization,
captured frames, staff actions, monitoring changes, renaming and stop. Frames
carry their sequence and capture time; the service reports analyzed evidence,
its age and session state. Late, duplicated or stale-generation evidence cannot
renew readiness. The [live contracts](../shared/live-contracts.ts) and
[service adapter](../service/live.py) define the exact transport.

Recorded callers use `createReplaySession(bundle, staffEvents)` and advance its
source time. `replay(bundle, time, staffEvents)` provides the convenience API for
single snapshots. Both recorded and live adapters use the shared rule core;
their source/capture clock semantics stay distinct.

## Configuration and limits

| Variable | Default / purpose |
| --- | --- |
| `TABLEWATCH_DATA_DIR` | Native `data/sources`; container `/data` |
| `TABLEWATCH_MODEL_DIR` | Native `models`; container `/models` |
| `TABLEWATCH_STATIC_DIR` | Native `dist`; container `/app/dist` |
| `TABLEWATCH_API_HOST` | Native `127.0.0.1`; container `0.0.0.0` behind the proxy |
| `TABLEWATCH_API_PORT` | `8000` |
| `TABLEWATCH_ALLOWED_ORIGINS` | Exact allowed browser origins; public Compose supplies its HTTPS domain |
| `TABLEWATCH_UPLOAD_BYTES` | `1000000000` bytes per recording |
| `TABLEWATCH_DURATION_SECONDS` | `600` seconds |
| `TABLEWATCH_FRAME_BYTES` | `2097152` decoded live-image bytes |

Setup images are limited to 12 MiB and 16 megapixels. Transport-level WebSocket
messages are bounded to twice the frame-byte limit plus 65,536 bytes, with image
validation and application limits applied afterward. HTTP body limits are checked
before multipart spooling. Large media can need more browser memory than its
compressed size; limits are ceilings, not performance guarantees.

Public proxy configuration is described in [Deployment](DEPLOYMENT.md). Never
commit passwords, `.env`, model binaries or saved source data.
