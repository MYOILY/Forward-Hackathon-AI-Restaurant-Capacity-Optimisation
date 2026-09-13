# TableWatch

TableWatch turns a fixed-camera restaurant recording or browser camera into a
reviewed table map. CPU person tracking and reference-image comparison help staff
see which tables are occupied, need a reset, or have enough evidence to be ready.
Uncertain evidence remains visible, and staff can override the displayed status.

The application starts with **video or camera setup**. Upload a recording, choose
a clean reference, provide a floor plan or choose a schematic, and review each
table before starting analysis. No example footage, saved restaurant data, model
weights, or automatically approved tables are included.

## Start locally

Install Python 3.11, Node.js 22.12 or later, npm, uv, and FFmpeg/ffprobe. From this
directory:

```sh
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -r requirements.lock.txt
uv pip install --python .venv/bin/python --no-deps -e .
npm ci
.venv/bin/python -m processor download-model --model tiny --model-dir models
npm run dev:full
```

Open [TableWatch locally](http://127.0.0.1:5173). Manual video drafting works
without detector weights when **Draw tables manually** is selected; automatic
proposals and analysis need the verified model. Detection-only monitoring skips
tabletop assessment and cannot establish automatic readiness.

A [demo clip](examples/demo/) is included so the flow can be run without your
own footage: a 7.4 MiB fixed-camera recording of a shared study space with a
matching clean reference. It demonstrates that the pipeline runs; it is not
restaurant footage and carries no labels.

The empty [video folder](examples/videos/) and [mapping folder](examples/mappings/)
are for files you provide. Select their files through setup. They are not
automatically imported, approved, or served by the application.

## Deploy on an EC2 CPU instance

The default Docker Compose configuration serves the application through a
password-protected HTTPS proxy. It requires a domain, credentials, verified
model files, and persistent storage. Follow [Deployment](docs/DEPLOYMENT.md).
For a localhost container without the proxy, use
`docker compose -f compose.local.yaml up -d --build`.

This repository prepares a deployment; it does not create AWS resources. The
hosted application uses one shared workspace. Uploaded recordings and saved
setup images are stored on the server. Browser camera frames are sent to that
server for analysis, but live video is not recorded.

## Documentation

| Read | Purpose |
| --- | --- |
| [Setup](docs/SETUP.md) | Uploads, cameras, clean references, table mapping and approvals |
| [Behavior](docs/BEHAVIOR.md) | Status rules, timing, uncertainty and manual controls |
| [Architecture](docs/ARCHITECTURE.md) | Component responsibilities, evidence and storage |
| [Reference](docs/REFERENCE.md) | Commands, interfaces and configuration |
| [Deployment](docs/DEPLOYMENT.md) | EC2, HTTPS, models, persistence and recovery |
| [Validation](docs/VALIDATION.md) | Tests, reproducible evaluation and evidence limits |

## Development checks

```sh
.venv/bin/python -m pytest tests/python -m 'not integration'
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

See [Validation](docs/VALIDATION.md) for integration checks and their prerequisites.
Tests use small, identified fixtures separate from user examples.

TableWatch is a fixed-camera prototype. A change from an approved setup is not
proof of dirt or sanitation. Software tests and generated image fixtures do not
establish restaurant accuracy; that requires independent labels and a separate
held-out real recording. [Further example material
required](docs/VALIDATION.md#further-example-material-required) lists what that
set must contain.
