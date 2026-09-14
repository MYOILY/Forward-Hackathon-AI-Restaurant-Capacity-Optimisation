# TurnTable

## Try the live demo

[![Try the live demo](docs/images/try-live-demo.svg)](https://d3t6xslmmc2oy2.cloudfront.net/)

**[Try it live here](https://d3t6xslmmc2oy2.cloudfront.net/) — no installation needed.**
Open the recording demo in desktop Chrome or Edge.

[Get the sample recordings and clean references](examples/demo/) · [Follow the screen-by-screen guide](docs/USAGE.md)

---

TurnTable turns a fixed-camera restaurant recording or browser camera into a
reviewed table map. CPU person tracking and reference-image comparison help staff
see which tables are occupied, need a reset, or have enough evidence to be ready.
Uncertain evidence remains visible, and staff can override the displayed status.

The intended subscription service gives restaurant staff an updated view of
their tables throughout service, helping them decide where to seat guests and
which tables need attention. This needs **near-real-time inference**: repeatedly
analyzing fresh camera images and updating table status as evidence changes.
Our intended service uses persistent EC2 compute to keep the model and active
camera session running. The Lambda recording demo lets customers try the
workflow. Read [why the subscription needs continuous inference](docs/ARCHITECTURE.md#why-the-subscription-needs-near-real-time-inference)
for the customer need, architecture choice and current prototype limits.

**Prefer a local setup? [Start locally](#start-locally), then follow the [demo walkthrough](docs/SETUP.md#try-the-demo).**
You will upload the included recording, mark a table, and open its analyzed video
with a table map and evidence. You do not need AWS, Docker, a camera or a floor-plan
image for this first run.

Already have the app open? Use the [screen-by-screen usage guide](docs/USAGE.md)
to learn what each section and control does.

The repository includes [two demo recordings, each with its own clean reference](examples/demo/).
It contains no pre-approved table setup or independent restaurant labels. Model
weights are downloaded separately during installation. Your files are only loaded
when you select them in the application.

## Start locally

### 1. Check the prerequisites

The commands below use a macOS or Linux shell. Windows users need a Linux
environment such as WSL; these commands do not run unchanged in PowerShell.
The recorded software checks were run on macOS ARM; see
[Validation](docs/VALIDATION.md) for platform coverage.

Clone or download this repository, then open a terminal in its top-level folder:
the folder containing `package.json`, `pyproject.toml` and this README. All commands
in this guide run there.

| Install | Purpose | Check in your terminal |
| --- | --- | --- |
| [Node.js](https://nodejs.org/en/download) 22.12 or later, with npm | Runs the web app and shared decision engine | `node --version` and `npm --version` |
| [uv](#install-uv) | Installs Python and the project's Python dependencies | `uv --version` |
| [FFmpeg](https://ffmpeg.org/download.html), including ffprobe | Reads and normalizes uploaded recordings | `ffmpeg -version` and `ffprobe -version` |

If a check says `command not found`, install that tool using the linked instructions
and reopen your terminal. The next step installs Python 3.11 through uv. Initial
installation and model download need internet access.

#### Install uv

If `uv --version` already works, skip this section. Otherwise, choose **one**
installation method. You do not need Python installed first.

On macOS, Linux, or inside a Windows WSL terminal, run the
[official standalone installer](https://docs.astral.sh/uv/getting-started/installation/#standalone-installer):

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh
```

If you already use Homebrew, you can use this **instead**:

```sh
brew install uv
```

Close and reopen your terminal after installation, return to the repository
folder, then check:

```sh
uv --version
```

You should see `uv` followed by a version number. If the standalone installer
succeeded but you still see `command not found`, add its default installation
directory to the current terminal's command search path and check again:

```sh
export PATH="$HOME/.local/bin:$PATH"
uv --version
```

If the installer reported a different directory, use that directory instead.
For other installation methods, see the [official uv installation guide](https://docs.astral.sh/uv/getting-started/installation/).
On Windows, install and run uv inside WSL for this project's Linux-style commands.
Once the version check works, continue with step 2 below.

### 2. Install dependencies and the model

Run each command in order. If one fails, resolve the error before continuing.

```sh
uv python install 3.11
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -r requirements.lock.txt
uv pip install --python .venv/bin/python --no-deps -e .
npm ci
.venv/bin/python -m processor download-model --model tiny --model-dir models
```

The model command downloads and verifies `models/yolox_tiny.onnx`. You do not
need to activate `.venv`: the commands use its Python executable explicitly.

### 3. Start the application

```sh
npm run dev:full
```

Leave this terminal running. It starts both the Python service on port 8000 and
the web app on port 5173. Open [TurnTable locally](http://127.0.0.1:5173).
You should see **Start with your restaurant.** with recording and camera choices.
Continue with [Try the demo](docs/SETUP.md#try-the-demo).

Press **Ctrl+C** in the terminal to stop both services. To return later, run
`npm run dev:full` again and reopen the same URL. Saved sources are stored in
`data/sources/`; they can be reopened through **Saved sources & jobs**.

### If something goes wrong

| What you see | What to do |
| --- | --- |
| `.venv/bin/python` is missing or a Python import fails | Return to step 2 and complete both Python package-install commands. |
| The page opens but says the service is unavailable | Use `npm run dev:full`, keep its terminal open, and check that terminal for an error. `npm run dev` alone starts only the web app. |
| Port 8000 or 5173 is already in use | Stop your previous TurnTable terminal with Ctrl+C. For another port pair, run `TABLEWATCH_API_PORT=8002 TABLEWATCH_UI_PORT=5174 TABLEWATCH_ALLOWED_ORIGINS=http://127.0.0.1:5174 npm run dev:full`, then open `http://127.0.0.1:5174`. |
| Automatic analysis is unavailable | Rerun the model-download command from step 2, then restart the application. Manual drafting works without weights; analysis and object proposals require them. |
| Upload fails during preparation | Check that both `ffmpeg` and `ffprobe` are available. Try the bundled demo before troubleshooting your own video. |
| Setup cannot continue, or every table is grey | Follow [setup troubleshooting](docs/SETUP.md#when-you-cannot-continue). Grey can mean missing or uncertain evidence; it is not necessarily an application error. |

## Choose a deployment when you need one

| Your goal | Use | Where recordings and setup live |
| --- | --- | --- |
| Try the demo or develop on your computer | [Start locally](#start-locally) | Local service storage; completed sources survive a restart |
| Run a localhost container | [Local Docker setup](docs/DEPLOYMENT.md#local-container-alternative) | A local Docker data volume |
| Run continuous real-time camera monitoring or share saved recordings behind a password | [EC2 deployment](docs/DEPLOYMENT.md) | One persistent server workspace shared by everyone with access |
| Publish the recordings-only demo with temporary browser sessions | [Stateless Lambda deployment](docs/STATELESS_DEPLOYMENT.md) | Each browser tab; refreshing loses its session |

### Stateless recording demo

The hosted demo lets prospective customers try table setup, analysis and the
dashboard using a recording. Lambda was chosen for the demo
so its availability does not depend on keeping an EC2 instance running. The
compact YOLOX Tiny model fits in the Lambda container image and processes
recording frames on demand. See [the deployment rationale](docs/STATELESS_DEPLOYMENT.md#why-the-demo-uses-lambda)
for the scope of this choice.

The [Lambda deployment](docs/STATELESS_DEPLOYMENT.md) keeps videos, setup and
results in each browser tab. A static page sends bounded frame batches to a
public CPU Lambda; portable checkpoints preserve tracking across requests.
This mode supports recordings only. It creates no server media storage or saved
jobs. AWS SAM templates, image/deployment scripts and a concurrent load harness are
included; AWS throughput and maximum-size recording acceptance still need testing.

### Shared workspace on an EC2 CPU instance

The intended subscription service needs continuous processing while a restaurant
is operating. The persistent EC2 service keeps the model loaded during a camera
session, retains tracking and table evidence across frames, and sends updated
status to the dashboard. This supports decisions about seating and cleaning as
conditions change. Near-real-time updates still include the
[evidence-confirmation waits](docs/BEHAVIOR.md#people-and-tabletop-timing).

The current implementation is a prototype with one shared workspace and one
active analysis or camera session per service instance. Customer accounts,
subscription billing and isolation between restaurants are still needed for the
commercial service; latency and camera capacity also need measurement. See
[Architecture](docs/ARCHITECTURE.md#why-the-subscription-needs-near-real-time-inference)
for the rationale and [Deployment](docs/DEPLOYMENT.md) for operator instructions.

## Documentation

Read **Setup** for the first run, **Usage** for the screen controls, and **Behavior**
for status rules. Use the other pages when
you need to develop, deploy or evaluate the application.

| Read | Purpose |
| --- | --- |
| [Setup](docs/SETUP.md) | Uploads, cameras, clean references, table mapping and approvals |
| [Usage](docs/USAGE.md) | Screenshot tour of each setup step, dashboard section and staff control |
| [Behavior](docs/BEHAVIOR.md) | Status rules, timing, uncertainty and manual controls |
| [Architecture](docs/ARCHITECTURE.md) | Why the subscription needs near-real-time inference, plus components, evidence and storage |
| [Reference](docs/REFERENCE.md) | Commands, interfaces and configuration |
| [Deployment](docs/DEPLOYMENT.md) | EC2, HTTPS, models, persistence and recovery |
| [Stateless deployment](docs/STATELESS_DEPLOYMENT.md) | AWS account/tools, SAM deployment, updates, teardown and rebuilding from zero |
| [Validation](docs/VALIDATION.md) | Tests, reproducible evaluation and evidence limits |

## Development checks

```sh
.venv/bin/python scripts/check_repository.py
.venv/bin/python -m pytest tests/python -m 'not integration and not surface_integration'
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

See [Validation](docs/VALIDATION.md) for integration checks and their prerequisites.
Tests use small, identified fixtures separate from user examples.

TurnTable is a fixed-camera prototype. A change from an approved setup is not
proof of dirt or sanitation. Software tests and generated image fixtures do not
establish restaurant accuracy; that requires independent labels and a separate
held-out real recording. [Further example material
required](docs/VALIDATION.md#further-example-material-required) lists what that
set must contain.
