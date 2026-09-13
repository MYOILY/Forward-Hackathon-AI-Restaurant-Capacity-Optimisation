# Commands and interfaces

Run commands from the repository root. The Python service and processor require
Python 3.11. The shared headless decision engine requires Node.js. Video
normalization uses FFmpeg/ffprobe. Install the complete locked environment as
shown in the [README](../README.md).

## Processor

```sh
.venv/bin/python -m processor --help
.venv/bin/python -m processor download-model --model tiny --model-dir models
.venv/bin/python -m processor prepare --video examples/videos/restaurant.mp4 --out data/review --model-dir models
.venv/bin/python -m processor analyze --video examples/videos/restaurant.mp4 --layout data/review/layout.json --out data/analysis --model-dir models
```

The filenames in these examples are supplied by you; the repository does not
contain that recording. Preparation proposes geometry and captures genuine
source references. Review and approve the setup before analysis; use the UI for
the complete guided reference and inventory approval workflow.

`--model tiny` is the default detector. Nano and S remain optional CPU detector
choices, but automatic tabletop checks use the verified Tiny model.
`--skip-surface` produces explicitly incomplete detection-only analysis.
`--provenance` identifies real, AI-generated or synthetic footage. Supplying a
provenance label does not replace actual model evidence or independent labels.
Run each subcommand with `--help` for its exact supported arguments.

Only the current bundle format is accepted. Old policy-selection and Qwen CLI
options have been removed. The saved schema, policy and evidence identifiers
retain their existing values because validation and hashes depend on them.

## Browser and service entry points

| Command | Purpose |
| --- | --- |
| `npm run dev:full` | Start the service and Vite together |
| `npm run service` | Start the Python service alone |
| `npm run dev` | Start Vite; the setup screen still needs the service |
| `npm run build` | Type-check and build the production UI |
| `npm test` | Run TypeScript behavioral tests |
| `npm run test:browser` | Run browser checks with controlled fixtures |

`/` opens fresh setup. Saved-source and setup links select server-managed source
IDs; example folders are not scanned. The service serves the production UI from
the configured static directory. API requests stay on the same origin in a
hosted deployment.

## HTTP API

All paths below are under `/api`. The public deployment authenticates every
request at the proxy, including health and asset requests. See
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
source time. `replay(bundle, time, staffEvents)` remains the compatibility API for
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
