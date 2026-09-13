# Deploy on an EC2 CPU instance

The default deployment is one Linux `amd64` EC2 instance running Docker Compose:
Caddy provides password-protected HTTPS and proxies to one private application
container. This is a single shared workspace. Everyone with the credentials can
access its saved sources; there is no per-user or per-restaurant isolation.

No AWS resources are created by this repository. Configure the host and DNS
before attempting certificate issuance.

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
cp .env.example .env
docker run --rm -it caddy:2.10.2-alpine caddy hash-password
```

Enter a password at the prompt. Set `DOMAIN` to your real public DNS name without
a scheme, path or port; choose `BASIC_AUTH_USER`; place the generated bcrypt hash
in `BASIC_AUTH_HASH`. Keep the hash in single quotes in `.env` so its dollar signs
are preserved. Do not use the example placeholders or commit `.env`.

`TABLEWATCH_MODEL_HOST_DIR` defaults to `./models`. Public Compose derives the
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

For a Docker-only host, build first and download through an isolated container:

```sh
mkdir -p models
docker compose build tablewatch
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/models:/models" tablewatch-cpu:local python -m processor download-model --model tiny --model-dir /models
python3 scripts/validate_deployment.py
docker compose up -d --build
docker compose ps
```

The downloader verifies the pinned official model bytes. Ensure the model
directory is traversable and its files readable by container UID 10001. The
running application mounts models read-only. Tiny is needed for both person and
surface checks; Nano/S are optional evaluation choices.

Open your HTTPS domain and authenticate. `GET /api/live` checks liveness;
`GET /api/ready` returns 200 when the verified detector and surface models are
available and 503 otherwise. `/api/health` supplies detailed capability state to
the UI. Missing models do not prevent manual video drafting. The container health
check uses liveness so absent models do not block access to setup.

Before sharing credentials, verify unauthorized requests cannot read the UI,
health details, assets or API; then test upload, camera permission, WSS monitoring
and video seeking while authenticated. Run the [validation checks](VALIDATION.md)
against this host before making deployment performance claims.

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
changed. Do not rewrite schema identifiers or old evidence to force compatibility.

## Local container alternative

```sh
docker compose -f compose.local.yaml up -d --build
```

Open [localhost](http://127.0.0.1:8000). This configuration has no public proxy and
binds only loopback. It uses a separate Compose project/data volume from public
deployment. Model-free manual drafting is supported; install the verified model
before automatic processing. For native development use [the README](../README.md).
