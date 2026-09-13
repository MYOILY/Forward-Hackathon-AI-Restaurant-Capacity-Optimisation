# Deploy on an EC2 CPU instance

This is the deployment for continuous real-time camera computation and a
persistent shared workspace. The hosted recording demo uses
[Lambda](STATELESS_DEPLOYMENT.md#why-the-demo-uses-lambda) so it does not depend on
keeping this EC2 instance running; its compact model processes frame batches on
demand. Live camera monitoring requires the EC2 service in this project's hosted
setup.

The EC2 deployment uses one Linux `amd64` instance running Docker Compose:
Caddy provides password-protected HTTPS and proxies to one private application
container. This is a single shared workspace. Everyone with the credentials can
access its saved sources; there is no per-user or per-restaurant isolation.

You provision the EC2 instance and DNS yourself; Compose starts the application
on that host. The separate stateless deployment helper can create AWS resources
when run with `--execute`. For a first local run, start with the
[README](../README.md#start-locally).

Follow **Prepare the host → Configure HTTPS and access → Install the CPU model
and start → Check the deployment**. Run commands from the repository root on
the instance. The storage and recovery sections are for ongoing operation.

## Prepare the host

Use an x86_64 Ubuntu LTS EC2 instance with Docker Engine and the Compose plugin.
An `m7i.xlarge` with four vCPUs and 16 GiB RAM is a starting configuration for
validation, not a measured concurrency or camera-throughput guarantee. Start
with 50 GiB of encrypted EBS storage and expand based on retained recordings and
measured disk use. See [AWS instance specifications](https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html)
and [Docker's Ubuntu installation guide](https://docs.docker.com/engine/install/ubuntu/).

Assign a stable address and point a domain's DNS record to it. Allow inbound TCP
80 and 443. The supplied proxy also publishes UDP 443 for HTTP/3; allow it if
using HTTP/3. Restrict SSH to the administrator's source IP. Do not expose port
8000, Vite, or a Docker daemon port. See
[AWS security-group examples](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/security-group-rules-reference.html).

Copy or clone this repository onto the instance. Exclude development environments,
test artifacts and user example media. Keep one application replica and one
Uvicorn worker; active jobs and live sessions are coordinated within that process.

## Configure HTTPS and access

```sh
cp -n .env.example .env
docker run --rm -it caddy:2.10.2-alpine caddy hash-password
```

The copy command preserves an existing `.env`. Open `.env` in your text editor.
The [included template](../.env.example) lists every required setting.
Enter a password at the Caddy prompt. Set `DOMAIN` to your real public DNS name without
a scheme, path or port; choose `BASIC_AUTH_USER`; place the generated bcrypt hash
in `BASIC_AUTH_HASH`. Keep the hash in single quotes in `.env` so its dollar signs
are preserved. Do not use the example placeholders or commit `.env`.

Keep `TABLEWATCH_MODEL_HOST_DIR=./models` for the commands below. If you use
another directory, change the download destination, Docker bind mount and file
permissions below to use that same directory. Public Compose derives the
exact allowed HTTPS origin from `DOMAIN`. It requires all public access settings;
the container preflight also rejects placeholders or malformed credentials.

Caddy manages public TLS certificates and redirects HTTP to HTTPS. The same
authentication boundary covers the UI, API, source assets and WebSocket upgrade;
the backend has no published host port. HTTPS is also required for browser camera
access away from localhost. See [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https),
[password authentication](https://caddyserver.com/docs/caddyfile/directives/basic_auth)
and [WebSocket proxying](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

## Install the CPU model and start

If using the native environment from the README, download the model with:

```sh
.venv/bin/python -m processor download-model --model tiny --model-dir models
```

Then run the following sequence to build and start the deployment. It also works
on a Docker-only host: the download command reuses an existing verified model if
you installed it natively. Run each command in order and stop if any command fails:

```sh
python3 scripts/validate_deployment.py
mkdir -p models
docker compose build tablewatch
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/models:/models" tablewatch-cpu:local python -m processor download-model --model tiny --model-dir /models
chmod -R a+rX models
docker compose up -d
docker compose ps
```

The downloader verifies the pinned official model bytes. Its downloaded file can
be readable only by its owner; `chmod` makes this model directory and its public
model files readable by application container UID 10001. Apply that permission
step even if you downloaded the model using the native environment. The
running application mounts models read-only. Tiny is needed for both person and
surface checks; Nano/S are optional evaluation choices.

## Check the deployment

Wait for `docker compose ps` to show the application as healthy, then open your
HTTPS domain. You should be prompted for the username and password you chose.
After signing in, you should see the recording/camera setup screen.

`GET /api/live` checks liveness;
`GET /api/ready` returns 200 when the verified detector and surface models are
available and 503 otherwise. `/api/health` supplies detailed capability state to
the UI. Missing models do not prevent manual video drafting. The container health
check uses liveness so absent models do not block access to setup. In the signed-in
browser, open `https://YOUR_DOMAIN/api/ready` (replace `YOUR_DOMAIN` with your
domain) and confirm that it reports `"ready": true`. A healthy container alone
does not prove model readiness.

Complete the [demo walkthrough](SETUP.md#try-the-demo) to check upload, review,
analysis and playback. Select the demo files from the computer running your
browser; they do not need to be placed in a server media folder.

Before sharing credentials, verify unauthorized requests cannot read the UI,
health details, assets or API; then test upload, camera permission, WSS monitoring
and video seeking while authenticated. Run the [validation checks](VALIDATION.md)
against this host before making deployment performance claims.

### Troubleshooting

| Symptom | Next check |
| --- | --- |
| Configuration rejected | Replace every placeholder in `.env`, keep the bcrypt hash single-quoted, and rerun `python3 scripts/validate_deployment.py`. |
| HTTPS is unavailable | Confirm DNS points to this instance, inbound TCP 80/443 is allowed, and inspect `docker compose logs --tail=100 caddy`. |
| Readiness returns 503 | Open `/api/health` after signing in. Check that `models/yolox_tiny.onnx` exists and repeat the model-directory permission step. Restart `tablewatch` after correcting it. |
| The browser cannot access its camera | Allow camera permission on the HTTPS site and confirm that another application is not holding the device. |

## Storage, logs and restart

The `tablewatch_tablewatch-data` volume contains saved sources. Caddy keeps
certificate/configuration state in its own volumes. Docker stores these on the
host disk; stopping containers does not copy data off the instance. Keep the EBS
volume and backups when replacing an instance.

```sh
docker compose logs --tail=100 tablewatch caddy
docker compose restart tablewatch
docker compose down
```

Do not add `-v` to `down` when retaining data. Completed sources reload after a
restart. Interrupted analysis is reported as interrupted/failed and can be
started again after review; live sessions must be restarted by their browser.
Uploads and saved references persist. Live camera frames remain transient and
live video is not recorded.

Stop the application before a consistent data backup. Use an EBS snapshot or a
volume backup with the instance's chosen backup policy; retain the matching
application image/configuration and model identities. Restore to an isolated
instance first, then verify source manifests, assets, model readiness and a
completed recording before directing the domain to it.

For an update, retain the previous image tag/digest and back up data first. Build
and validate the new image, then run `docker compose up -d`. To roll back, restore
the known working code/image and corresponding data backup if stored formats
changed. Reprocess unsupported saved recordings through reviewed setup; do not
rewrite their evidence to make them appear current.

## Local container alternative

This path needs a running Docker engine and Compose, but no domain or `.env`.
From the repository root, first build the image and install the model:

```sh
mkdir -p models
docker compose -f compose.local.yaml build tablewatch
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/models:/models" tablewatch-cpu:local python -m processor download-model --model tiny --model-dir /models
chmod -R a+rX models
docker compose -f compose.local.yaml up -d
```

Open [localhost](http://127.0.0.1:8000). This configuration has no public proxy and
binds only loopback. It uses a separate Compose project/data volume from public
deployment. Model-free manual drafting is supported; install the verified model
before automatic processing. Stop this instance with
`docker compose -f compose.local.yaml down`; omit `-v` to retain saved sources.
For native development use [the README](../README.md).
