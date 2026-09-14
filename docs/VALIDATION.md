# Validate the application

Tests use controlled inputs under [tests/fixtures](../tests/fixtures/), separate
from the bundled [demo](../examples/demo/) and user-supplied recordings.
A passing simulated test is software
evidence, not proof of physical-camera throughput or restaurant accuracy.

For the stateless recording deployment, add
`tests/python/test_stateless_frames.py` and
`tests/python/test_stateless_infra.py` to focused checks. They exercise portable
checkpoint parity, request bounds, source isolation, retries and deployment
resource constraints. The ten-client mock workload does not contact AWS. See
[the stateless validation steps](STATELESS_DEPLOYMENT.md#validate-before-provisioning)
and [load/acceptance procedure](STATELESS_DEPLOYMENT.md#load-and-acceptance-checks)
for separate real-model, Docker, deployed burst and 1 GB/600-second browser checks.

## Reproducible software checks

Install dependencies using the [README](../README.md), then run:

```sh
.venv/bin/python scripts/check_repository.py
.venv/bin/python -m pytest tests/python -m 'not integration and not surface_integration'
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

These software layers are run locally on macOS ARM. No CI workflow is
committed to this repository, so no automated Linux run exists.
It does not claim a real camera, real restaurant recording, or AWS benchmark.
Browser fixtures exercise the actual setup/playback interfaces with controlled
service replies; they do not put sample routes or default media in the application.

Coverage includes root fresh setup and unavailable service/models; manual video
drafting; reference and floor-plan uploads; table corners, people zones and map
rotation; approval/draft/revision boundaries; source transfers; live lifecycle;
playback; current status rules; and explicit rejection of legacy bundles.

The independent evidence audit distinguishes initial readiness from recovery
after a cleaning alert. It checks capture identity, freshness and confirmation
rather than accepting a recorded green label as its own proof. Shared interval,
provenance and integrity tests remain even where old-format scenarios were removed.

## Actual CPU model checks

The small identified test images are included under `tests/fixtures`. Download
the official detector models separately; weights are not included in the
repository or EC2 application image. The separate Lambda image downloads and
verifies Tiny at build time, then bakes it into that image:

```sh
.venv/bin/python -m processor download-model --model tiny --model-dir models
.venv/bin/python -m processor download-model --model nano --model-dir models
.venv/bin/python -m processor download-model --model s --model-dir models
YOLOX_MODEL_DIR="$PWD/models" YOLOX_TEST_IMAGE="$PWD/tests/fixtures/bus.jpg" .venv/bin/python -m pytest tests/python -m 'integration and not surface_integration'
YOLOX_MODEL_DIR="$PWD/models" .venv/bin/python -m pytest tests/python -m surface_integration
```

These tests exercise verified CPU weights with public or identified generated
images. A missing model or fixture is reported explicitly; a skipped required
layer cannot establish complete evaluation. The CPU surface fixtures retain
their original source and review provenance. No obsolete Qwen tests are required.

Run CPU gateway/upload/persistence checks in the same runtime as a local test
service, using disposable test storage and verified models. The scripts default
to `http://127.0.0.1:8000`; set `TABLEWATCH_CHECK_BASE_URL` to the isolated test
service's address when using another port. Provider and platform details describe
the check process, so run it inside the application container for container evidence.

```sh
.venv/bin/python scripts/make_cpu_fixture.py /tmp/tablewatch-cpu.mp4
.venv/bin/python scripts/check_cpu_upload.py /tmp/tablewatch-cpu.mp4 /tmp/tablewatch-upload.json
.venv/bin/python scripts/check_cpu_container.py tests/fixtures/surface/ai-t1-reference.png /tmp/tablewatch-live.json
# Restart the same test service, keeping its data directory, then:
.venv/bin/python scripts/check_cpu_persistence.py /tmp/tablewatch-restart.json /tmp/tablewatch-upload.json /tmp/tablewatch-live.json
```

These scripts create sources and jobs. Their output is integration evidence,
not a camera-capacity measurement. Never use a populated demo workspace for a
restart experiment. `check_proxy.py --url https://YOUR_DOMAIN --user YOUR_USER`
prompts for the password and verifies the public access boundary. Supply
`--video-source-id` and `--camera-source-id` for disposable reviewed sources to
include Range and WSS checks; omitted evidence is reported as skipped.

For a local TLS check with an installed Caddy binary and a disposable service on
another port, run `scripts/check_local_proxy.py --help`. The harness uses the
submitted authentication/proxy rules, a temporary CA and disposable credentials.
It verifies certificates without installing a system trust root. This checks the
proxy boundary; public certificate issuance still requires the deployed domain.

## Evaluate your restaurant footage

This is an advanced workflow for measuring performance. You do not need labels
or an evaluation run to follow the [demo walkthrough](SETUP.md#try-the-demo).

Record a main clip and a distinct held-out clip. Label the source video referenced
by each bundle independently of detector outputs, with physical occupancy, observable periods
and expected service outcomes. Freeze configuration before evaluating the held-out
recording. Approval of setup images does not supply ground truth.

1. Upload and review each recording through the shared-workspace UI, then run
   **Analyze recording**. Each completed source has a `bundle.json` and referenced
   assets under `data/sources/SOURCE_ID/` by default. See
   [finding a saved source](REFERENCE.md#reanalyze-a-reviewed-recording).
2. Inspect the video referenced by each bundle. For normalized uploads, use that
   source timeline and hash. Author labels independently of predictions, following
   the [label format and example](REFERENCE.md#evaluation-label-format).
3. Save the two annotation files as `data/main-labels.json` and
   `data/heldout-labels.json`. Replace `SOURCE_ID` in this structure-only check
   with the matching source ID, and repeat it for the held-out source and labels:

```sh
.venv/bin/python - data/sources/SOURCE_ID data/main-labels.json <<'PY'
import json
import sys
from pathlib import Path
from evaluator.labels import validate_labels
from processor.io import validate_bundle

path = Path(sys.argv[1])
bundle_path = path / "bundle.json" if path.is_dir() else path
bundle = json.loads(bundle_path.read_text())
labels = json.loads(Path(sys.argv[2]).read_text())
validate_bundle(bundle)
validate_labels(labels, bundle)
print("Bundle and label structure passed; annotation accuracy was not checked.")
PY
```

After both checks pass, run the evaluator. Replace `MAIN_SOURCE_ID` and
`HELDOUT_SOURCE_ID` with your two completed source IDs:

```sh
.venv/bin/python -m evaluator \
  --bundle data/sources/MAIN_SOURCE_ID --labels data/main-labels.json \
  --held-out-bundle data/sources/HELDOUT_SOURCE_ID --held-out-labels data/heldout-labels.json \
  --models tiny --model-dir models --out output/evaluation
```

`--bundle` and `--held-out-bundle` accept either a source directory or its
`bundle.json` file. Keep each bundle's referenced assets in place. Paths above
are user-provided outputs and independent labels; no labels for real recordings
ship with the repository. The evaluator
checks required software/model layers, replays the production decision engine,
audits evidence independently and runs repeated main trials plus held-out
evaluation. Run benchmarks exclusively, without builds or other inference tests
competing for CPU. `--fixture-only` and `--skip-tests` are diagnostic options and
cannot produce complete real-video validation.

## Deployment acceptance

Build and run the Linux `amd64` image on a native x86 CPU host. Confirm verified
inference, memory use, upload bounds, cancellation, model readiness and reopening
completed data after restart. ARM emulation or a passing image build is not an EC2
throughput result.

Through Caddy, check unauthorized UI/API/media/WebSocket access is rejected,
authorized same-origin traffic works, unlisted origins fail, Range requests and
seeking work, and live frames use WSS. Test HTTP-to-HTTPS redirect and certificate
issuance on the actual domain. See [Deployment](DEPLOYMENT.md).

## Verification record

The following historical checks ran before the stateless deployment and
single-format simplification, using this repository's installed dependencies and
test fixtures. They do not establish validation of the current checkout. See
[stateless verification record](#stateless-verification-record) for its
dated results and rerun the commands above after changes.

| Check | Result |
| --- | --- |
| Python behavior and configuration | 403 passed; five model integration tests selected separately |
| Actual CPU model integration | All five passed with separately downloaded, hash-verified Tiny, Nano and S weights |
| TypeScript unit tests | 329 passed |
| Browser scenarios | 81 passed with `npm run test:browser -- --trace=off` |
| Production frontend and unused TypeScript checks | Passed |
| Public and local Compose configuration | Both parsed successfully; public-setting rejection tests passed |
| Repository boundaries and documentation | Local links passed; no source dependency on the original project; example folders contain only placeholders |
| Native CPU upload and live processing | Passed using synthetic test media; the uploaded clip produced nine real surface assessments and initial readiness at seven seconds |
| Native service restart | Saved video results and approved video/camera baselines survived a stop and restart |
| Native Caddy HTTPS/WSS | Authentication, rejected origins, HTTP redirect, authenticated video Range and live WebSocket exchange passed with no skipped proxy checks |

Actual-model and native service checks ran on macOS ARM using ONNX Runtime's CPU
detector. They establish execution with real weights, not Linux image behavior or
EC2 capacity. The proxy used temporary local TLS certificates with verification
enabled; no public domain or system trust store was changed.

The Linux `amd64` container build and container-runtime checks remain unverified:
the available Docker client could not connect to a working engine, and no CI
workflow is committed to run the build elsewhere. Public certificate
issuance, EC2 performance, physical cameras and independently labelled restaurant
footage remain deployment or field-validation work.

## Documentation walkthrough check

On 14 September 2026, the revised [demo walkthrough](SETUP.md#try-the-demo) was
followed in desktop Chrome against an isolated native service on macOS ARM using
the existing installed dependencies and verified Tiny model. It completed video
upload, clean-photo selection, schematic selection, the four review steps for one
table, setup approval, full recorded analysis and opening completed playback.
The screenshots in the guide come from that run with the bundled demo.

The 40 existing deployment-configuration tests passed. Local documentation
links/anchors/images, shell-block syntax, the public environment template and the
synthetic label example were also checked. This was not a fresh dependency
installation, an AWS deployment, a Linux container run or an accuracy evaluation.
The older verification records below retain their original scope.

## Stateless verification record

The following record was moved from the stateless deployment guide during the
documentation review. It preserves the original results and limitations; it is
not a fresh execution of those checks. Current procedures remain in
[Stateless deployment](STATELESS_DEPLOYMENT.md#load-and-acceptance-checks).

Before the single-format simplification, local model-backed checks ran against
the ten-slot HTTP adapter on macOS ARM,
using two generated 160 × 90 test frames per request (about 117 KB of JSON), two
checkpoint batches per client, and a duplicate first request per client:

| Concurrent clients | Completed clients | HTTP 200 / retried 429 | Total wall time |
| --- | --- | --- | --- |
| 10 | 10 | 30 / 1 | 2.510 s |
| 25 | 25 | 75 / 21 | 2.486 s |

Both runs verified run/frame/checkpoint isolation and identical-request retry
results using the actual Tiny model. They exercised small synthetic images; warm
model state and machine load can differ between runs, so these timings cannot be
extrapolated to full recordings or compared as a scaling benchmark. The offline
tests also exercised a 100-client burst with injected detections and real
checkpoint/tracker code.

Current-format verification on 14 September 2026 passed 363 web unit tests,
455 Python tests (including 19 infrastructure/load-harness tests), all 81 local
browser cases and all five stateless browser cases. The stateless journey used
the real Tiny model through `/frames`. Type checking, both frontend build modes,
offline template validation and repository documentation/boundary checks passed.
The Python count combines the main run with successful reruns of five cases
interrupted by disk exhaustion. The browser checks also fixed a test helper to
wait for replacement video metadata before seeking. Generated video fixtures use
separate temporary directories to avoid cross-suite cleanup races.

Five actual-model Python integration tests were excluded. Two existing
live-camera scheduling assertions still expect one inference call but receive
two; they also failed before this format change, with the original validation
module restored. They remain separate local-mode validation issues. The
load-harness tests cover isolated clients and a synthetic 100-client burst using
the current `/frames` contract. The earlier real-model load timings above were
recorded before the API-path rename and are not current AWS measurements.

Local protocol/algorithm tests, template checks and load runs do not establish
AWS performance. On 14 September 2026, AWS validated both CloudFormation
templates, including the optional shared-concurrency configuration. A read-only
check in `ap-southeast-2` confirmed a regional quota of 10 and an unreserved pool
of 10, which cannot support the default reservation. Preflight passed with
`--use-unreserved-concurrency`; function memory was not exposed by the quota API
and must still be accepted at deployment. The check excludes the separate
MicroVM memory quota and converts known function-memory units before comparing.
After switching provisioning to SAM, both templates passed `sam validate --lint`
with SAM CLI 1.166.1 and AWS `validate-template`. All 80 infrastructure/load-harness
tests passed after making memory and inference threads configurable, including
quota comparisons against the selected memory and SAM parameter propagation.
The image repository was provisioned and `build-push` completed with the verified
container smoke check and an immutable release file. The first application
deployment failed because AWS imposed a 3,008 MB function-memory limit that was
not exposed by Service Quotas. The revised template and read-only preflight pass
with defaults of 3,008 MB and two threads. Application provisioning at those
settings, deployed load tests and longest-recording acceptance remain unverified.

## Further example material required

This repository ships two unlabelled [demo clips](../examples/demo/) and no
venue mappings or real-recording labels. The documentation's synthetic label
example only illustrates file structure. Every result above rests on synthetic fixtures and
self-recorded material. Those establish that
the pipeline executes; they do not establish restaurant accuracy. The following
example material is still required before any accuracy claim is made:

| Needed | Why it is missing today |
| --- | --- |
| Held-out fixed-camera recordings from more than one venue | The bundled study-space demos are not a held-out, multi-venue restaurant dataset |
| A clean reference frame per venue and per camera move | Reference comparison is only as good as its approved baseline |
| Floor plans matching each recording | Map positions are currently checked against schematic plans |
| Independent occupancy and reset labels with timestamps | `evaluator` can score against labels, but no labelled set exists |
| Adversarial clips: occlusion, crowding, off-camera clearing, low light, reflective tabletops | Failure modes are described in [Behavior](BEHAVIOR.md) but not measured |

Until a labelled, held-out set exists, treat reported timings as execution
evidence only. Select recordings from any local folder. `examples/mappings`
remains an optional folder for your own plans; its contents stay untracked, and
`scripts/check_repository.py` requires it to hold only `.gitkeep` for a clean submission.
