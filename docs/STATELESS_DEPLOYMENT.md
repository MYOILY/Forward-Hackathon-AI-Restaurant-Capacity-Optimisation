---
title: Deploy the stateless recording demo with AWS SAM
owner: TurnTable maintainers
---

# Deploy the stateless recording demo with AWS SAM

This mode publishes a recordings-only website. Each visitor selects a local
video, reviews its tables, and sends sampled images to an AWS Lambda function
for analysis. Video, setup and results stay in the browser tab; refreshing or
closing it loses the session. The public API has no login. For a password-protected
shared workspace or live cameras, use [EC2 deployment](DEPLOYMENT.md).

## Why the demo uses Lambda

Lambda is the deployment choice for this hosted recording demo. It avoids making
the demo depend on an EC2 instance staying online: inference runs on demand when
a visitor submits frame batches. The compact YOLOX Tiny model is small enough to
package in the [Lambda container image](../Dockerfile.lambda), where its weights
are downloaded and verified during the build.

The intended subscription service needs **continuous near-real-time inference**
so restaurant staff can act on arrivals, departures and table changes during
service. Its persistent EC2 component maintains the live camera connection,
loaded model and ongoing evidence. The Lambda demo handles requests from
recordings and has no live-camera connection. See
[why the subscription needs continuous inference](ARCHITECTURE.md#why-the-subscription-needs-near-real-time-inference)
for the customer need and the work still required beyond this prototype.

This choice removes dependence on an operator-managed EC2 instance; it does not
guarantee uninterrupted availability. Cold starts, throttling and failed requests
can still affect the demo. See [Runtime and limits](#runtime-and-limits).

## Deployment steps

**From zero:** prepare an AWS account and your computer → sign in → validate →
create the image repository → build/push → deploy with SAM → publish the website →
check it. At the end of the event, follow [Teardown](#teardown-spin-down).
The main command sequence uses **3,008 MB, two inference threads and shared
concurrency**, the settings used for the competition account with a small quota.
Provisioned resources and API use can incur AWS charges.

| What you want to do | Start here |
| --- | --- |
| Set up an AWS account, permissions and tools | [Requirements](#aws-account-and-workstation-requirements) |
| Sign in from the terminal | [Configure AWS access](#configure-aws-access) |
| Try this mode without AWS | [Run locally](#run-locally) |
| Prepare tools and validate the templates | [Validate before provisioning](#validate-before-provisioning) |
| Handle an account with no reservable concurrency | [Small concurrency quotas](#accounts-with-a-small-concurrency-quota) |
| Create and publish the application | [Build and deploy](#build-and-deploy) |
| Confirm it works or diagnose a failed step | [Check the deployment](#check-the-deployment) |
| Understand architecture and request limits | [How it works](#how-this-deployment-works) and [Runtime and limits](#runtime-and-limits) |
| Measure capacity or review prior results | [Load and acceptance](#load-and-acceptance-checks) and [historical verification](VALIDATION.md#stateless-verification-record) |
| Publish changes to an existing site | [Update a deployed application](#update-a-deployed-application) |
| Delete the website, API and images | [Teardown](#teardown-spin-down) |
| Remove the remaining `turntable-stateless-images` stack | [Image-stack cleanup](#remove-turntable-stateless-images) |
| Recreate the deployment after deletion | [Start again](#start-again-after-teardown) |

## AWS account and workstation requirements

You need one active AWS account authorized to use the services below and cover
their usage charges. This guide uses the Sydney region, `ap-southeast-2`. A
personal account or an organization-provided account can work; restricted lab or
competition credentials must allow these resources. A GitHub account, paid domain,
EC2 server and Docker Hub account are not required to deploy a local repository
checkout. CloudFront supplies an HTTPS address. See [AWS SAM prerequisites](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/prerequisites.html).

The deployment identity needs these permissions, including cleanup permissions
if you will tear down the application. This is a capability checklist, not a
complete IAM policy; the repository does not provision the operator's access.

| Service | What the deployment operator needs to do |
| --- | --- |
| STS and Service Quotas | Read the caller identity and Lambda quotas |
| CloudFormation | Validate templates; create, read, update and delete both stacks |
| IAM | Create/manage/delete the Lambda execution role and its inline policy; pass that role to Lambda (`iam:PassRole`) |
| ECR | Create/manage/delete the dedicated repository and its policy; authenticate, push and read images |
| Lambda | Read account settings and functions; create/update/delete the container function, Function URL and invocation permissions; manage concurrency |
| S3 | Create/delete the private website bucket and its policy; list, upload and delete website objects |
| CloudFront | Manage/delete the distribution, origin access control and cache policy; create invalidations |
| CloudWatch Logs | Manage/delete the function's log group and retention; read logs for troubleshooting |

Your account must permit a public Lambda Function URL and this CloudFront/S3
configuration. Organization policies or permission boundaries may restrict
them even when an IAM policy grants access. The Lambda runtime role itself has
only logging permissions; it cannot provision the application.

### Install and check the tools

Use a macOS or Linux terminal, or a WSL environment on Windows. Run the project
commands from the repository root, containing `package.json` and `scripts/`.

| Tool | Install / purpose | Check |
| --- | --- | --- |
| AWS CLI v2 | [AWS CLI installation](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html); credentials and AWS commands | `aws --version` |
| AWS SAM CLI | [SAM installation](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html); validates and deploys the templates | `sam --version` |
| Docker with buildx | [Docker Desktop](https://docs.docker.com/desktop/); builds and smoke-tests the Linux x86-64 Lambda image | `docker info` and `docker buildx version` |
| Node.js 22.12+ and npm | [Node.js installation](https://nodejs.org/en/download); builds the website | `node --version` and `npm --version` |
| uv and Python 3.11 | [Install uv](../README.md#install-uv); prepares the project's Python environment | `uv --version` |
| Desktop Chrome or Edge | Runs the supported MP4/H.264 browser workflow | Open the published HTTPS site |

Docker must be **running**, not just installed. On macOS with Docker Desktop,
run `open -a Docker`, then wait until `docker info` succeeds. Leave several GB
of free disk for dependencies, model weights, image layers and build cache.
The helper builds `linux/amd64` even on an Apple Silicon Mac.

If you have not already installed the project dependencies, run these commands
in order; stop and fix any failure before continuing:

```sh
uv python install 3.11
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -r requirements.lock.txt
uv pip install --python .venv/bin/python --no-deps -e .
npm ci
.venv/bin/python --version
```

The Docker build downloads and verifies the Tiny model automatically. A separate
local model download and FFmpeg are needed for the local demo/browser validation,
not for publishing the AWS deployment. Internet access is needed to install
dependencies, download the model/base image and reach AWS.
The environment commands above prepare the full project for local checks too;
the deployment helper itself uses only Python's standard library.

### Configure AWS access

Use a deployment IAM identity or role. If your terminal already has working
credentials for the intended account, keep them and proceed to the identity
check below. Signing in to the AWS Console alone does not configure the CLI.

If your organization provides IAM Identity Center (SSO), configure a profile
using its start URL and SSO region, then sign in. The SSO region may differ from
the application's Sydney region. Choose the deployment account and role when
prompted. See [AWS CLI SSO configuration](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html).

```sh
aws configure sso --profile turntable-deploy
aws sso login --profile turntable-deploy
export AWS_PROFILE=turntable-deploy
```

If your account instead provides IAM access keys, use this alternative and enter
the credentials at the prompts, with region `ap-southeast-2` and output `json`:

```sh
aws configure --profile turntable-deploy
export AWS_PROFILE=turntable-deploy
```

Do not use root-account access keys or put credentials in repository files.
See [AWS root-user guidance](https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html).
The AWS CLI stores profile configuration outside the checkout. In a new terminal,
select your profile again; for expired SSO sessions, repeat `aws sso login`.
The helper and SAM inherit `AWS_PROFILE`, or you can pass `--profile` consistently
to each helper/AWS/SAM command. Confirm the account and role before provisioning:

```sh
aws --region ap-southeast-2 sts get-caller-identity
aws --region ap-southeast-2 lambda get-account-settings
```

Check that the returned account is the one you intend to deploy into. The Lambda
response reports the regional shared/concurrent quota; the preflight step below
checks whether your selected concurrency mode can use it. New accounts may have
reduced concurrency and memory quotas; do not assume the published platform
maximum is available. See [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html).

### What belongs in GitHub

The guide, templates, Dockerfile and deployment helper are shareable source.
Deployment does not commit or push anything to GitHub. The generated
`.turntable-work/` release files, `.env` files, models, dependencies and `dist/`
are ignored by [the repository's Git rules](../.gitignore). Release files contain
account-specific image coordinates, not AWS secret keys; keep them locally for
updates and rollback. A manually generated `samconfig.toml` is **not** covered
by those ignore rules: inspect it before committing, and exclude it locally if
you do not want to share its deployment coordinates.

## Run locally

Complete the [README's dependency and model installation](../README.md#2-install-dependencies-and-the-model).
Stop before `npm run dev:full`; if it is already running, stop it with Ctrl+C.
This mode has its own API. Start it in one terminal, from the repository root:

```sh
TABLEWATCH_ALLOWED_ORIGIN=http://127.0.0.1:5173 .venv/bin/python -m service.stateless_server --port 8001
```

Open another terminal in the same repository folder and start Vite:

```sh
VITE_PROCESSING_MODE=stateless VITE_STATELESS_API_URL=http://127.0.0.1:8001 npm run dev
```

Open [the local page](http://127.0.0.1:5173) in desktop Chrome or Edge. Use this
exact address because it matches the configured allowed origin. Keep both
terminals running. This mode offers MP4/H.264 recordings only, with no saved sources
or browser cameras. Choose `examples/demo/scene.mp4`, click **Set up tables manually**,
then follow the [reference and table review](SETUP.md#2-select-the-clean-reference)
using `examples/demo/clean-frame.jpg` and a schematic. Finish setup, click
**Analyze video**, then **Open results**. Preparation and replay use the same client-decoded frame
coordinate system. The original recording remains available locally for playback.
Frame identities describe transmitted browser captures; they do not assert
server verification of the whole original recording.

Stop both terminals with Ctrl+C when finished. Refreshing the page starts a new
empty session; there is no saved-source list to recover it from.

## Validate before provisioning

Complete [Requirements](#aws-account-and-workstation-requirements) and
[Configure AWS access](#configure-aws-access) first. You can skip starting the
local application.

Commands below run from the repository root. `stateless_deploy.py` prints its
commands without invoking SAM, AWS, Docker or npm unless `--execute` is supplied.
`--dry-run` makes that default explicit. Region defaults to `ap-southeast-2` and
stack name to `turntable-stateless`; pass `--region`, `--stack` and `--profile`
consistently when changing them.

```sh
.venv/bin/python scripts/stateless_deploy.py validate --stack turntable-stateless --region ap-southeast-2 --dry-run
.venv/bin/python scripts/stateless_deploy.py validate --stack turntable-stateless --region ap-southeast-2 --aws --execute && \
.venv/bin/python scripts/stateless_deploy.py preflight --stack turntable-stateless --region ap-southeast-2 --use-unreserved-concurrency --memory-mb 3008 --inference-threads 2 --execute
```

The first command previews validation; the next two actually validate and read
AWS quotas. None provisions infrastructure. Do not continue to build/deploy if
they fail. The helper chooses the template paths for you. If you invoke SAM
validation directly from the repository root, specify the template explicitly:

```sh
sam validate --lint --template-file infra/stateless/template.json --region ap-southeast-2
```

Plain `sam validate --lint` looks for a root `template.yml`, which this repository
does not contain. The helper validates both the app and image templates.

For software validation before a release, also run the following. These checks
need the [local model installation](../README.md#2-install-dependencies-and-the-model)
and FFmpeg; they do not deploy anything:

```sh
.venv/bin/python -m pytest tests/python/test_stateless_infra.py tests/python/test_stateless_frames.py
npm test
npx playwright install chromium
npm run test:stateless-browser
```

Stop the manually started local frame API before the browser suite; both use
port 8001. The stateless browser suite starts its own frame API and Vite servers. It requires
FFmpeg for small generated fixtures and an installed Playwright Chromium browser;
set `STATELESS_BROWSER_CHANNEL=chrome` to use installed desktop Chrome instead.
It checks the real setup-to-playback journey without persistent API endpoints,
tab isolation, refresh loss, and CFR, variable-rate, rotated and positive-start
MP4 timestamps against native playback. The existing local-mode browser suite
remains available with `npm run test:browser` (`PLAYWRIGHT_CHANNEL=chrome` selects
installed Chrome).

Offline validation checks resource boundaries, exact CORS, policy scope and
template dependency cycles. `validate --execute` runs `sam validate --lint` on
both templates. `validate --aws --execute` additionally calls AWS
`validate-template`; it does not create a stack. Preflight reads the regional
concurrency quota and existing reservation. In reserved mode, ten reserved
executions must leave at least AWS's required 100 unreserved. The shared mode
shown above instead requires a positive shared pool. An account with insufficient
capacity for its chosen mode needs a quota increase or released reservations.
Where AWS does not expose a memory quota, preflight says
so; deployment must still accept the selected memory allocation. Preflight
does not prove available runtime throughput or deployment IAM permissions.

### Accounts with a small concurrency quota

If preflight reports that zero slots are **reservable**, the account may still
have usable shared concurrency. For example, a regional quota of 10 with 10
unreserved executions can run up to ten invocations across functions using that
pool, but cannot reserve ten while leaving AWS's required 100 unreserved.
The script checks whether the function exists before reading its reservation;
an absent function is normal before the first deployment.

The [first-deployment sequence below](#build-and-deploy) already selects shared
concurrency. Pass `--use-unreserved-concurrency` to **both** preflight and deploy;
it is not a valid option for bootstrap, build-push, publish or teardown.

This sets the CloudFormation parameter `ConcurrencyMode=unreserved` and omits
`ReservedConcurrentExecutions`. It does **not** set the reservation to zero,
which would disable invocation. The shared quota is not a guarantee of idle
capacity: other functions compete for it, and increasing the regional quota
later also increases how far this function can scale. Browser retries still
handle throttling. The template and CLI retain `reserved` as their default;
repeat the option on subsequent deploys while using shared concurrency.

To retain a dedicated ten-invocation cap instead, request a regional quota of
at least 110, plus reservations belonging to other functions. Wait for approval,
then omit `--use-unreserved-concurrency` from preflight and deploy. Keep the
memory/thread options appropriate to that account.
See [AWS reserved concurrency rules](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)
and [Lambda account quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html).

## Build and deploy

Start your Docker engine and wait until `docker info` succeeds before building.
The CLI being installed is not enough: the local container engine must be
running. Leave several GB of free disk for the Python dependencies, model,
container layers and build cache. If Docker is running but `docker info` hangs,
check Docker Desktop's status and available disk before retrying.

`build-push` checks Docker's engine with a 15-second timeout before querying AWS
or starting the build. Build output uses `--progress=plain` so individual steps
remain visible. If the build command shows no progress and `docker info` also
hangs, cancel the stuck command with Ctrl+C and restore Docker Desktop first.
After the image repository stack succeeds, retry `build-push`; there is no need
to recreate the repository. This readiness check does not impose a 15-second
limit on the image build itself.

On macOS with Docker Desktop, `open -a Docker` starts the app. On other hosts,
start your installed Docker engine. In either case, wait for `docker info` to
succeed.

Use the sequence below for the first deployment after validation succeeds.
This template deploys a
prebuilt ECR digest; `sam deploy --guided` does not build that image. Continue
to `deploy` only after `build-push` succeeds and writes
`.turntable-work/stateless-release.json`. The helper supplies the existing ECR
repository and disables automatic S3 bucket resolution, so it does not require
the guided managed-repository prompts. Docker builds the deployment image
locally; Lambda executes it on AWS after deployment.

First create the dedicated image repository. Then build, verify the container's
handler and baked model with networking disabled, push the image and record its
digest. Use a new build ID for every release; ECR tags are immutable. The first
line generates a timestamped ID; keep that value when checking the deployed build.
This is an internal deployment identifier, not a version selector in the website.

```sh
DEPLOY_BUILD_ID="competition-$(date -u +%Y%m%d-%H%M%S)"
.venv/bin/python scripts/stateless_deploy.py preflight \
  --stack turntable-stateless --region ap-southeast-2 \
  --use-unreserved-concurrency --memory-mb 3008 --inference-threads 2 --execute && \
.venv/bin/python scripts/stateless_deploy.py bootstrap \
  --stack turntable-stateless --region ap-southeast-2 --execute && \
.venv/bin/python scripts/stateless_deploy.py build-push \
  --stack turntable-stateless --region ap-southeast-2 \
  --build-id "$DEPLOY_BUILD_ID" --execute && \
.venv/bin/python scripts/stateless_deploy.py deploy \
  --stack turntable-stateless --region ap-southeast-2 \
  --release .turntable-work/stateless-release.json \
  --use-unreserved-concurrency --memory-mb 3008 --inference-threads 2 --execute && \
.venv/bin/python scripts/stateless_deploy.py publish \
  --stack turntable-stateless --region ap-southeast-2 --execute
```

The `&&` separators stop the sequence at its first failure. The image stack
`turntable-stateless-images` creates only the ECR repository; the app stack
`turntable-stateless` is created by `deploy`. `build-push` writes the release file
only after a successful build, container check, push and digest lookup. A failed
later build can leave an **older** release file in place: its existence alone
does not mean the new image was built. Continue only after the intended build
succeeds. SAM reports a successful stack deployment before `publish` uploads
the website and prints its URLs. CloudFront provisioning can take several minutes.

`deploy` creates CloudFront independently of Lambda. The Function URL's CORS
origin is derived directly from that distribution's domain in CloudFormation,
so there is no circular dependency or wildcard-origin provisioning stage.
`publish` obtains the real Function URL from stack outputs, runs `npm ci` and a
fresh stateless build, and sets `VITE_STATELESS_API_URL` for that build. It uploads
only the validated `dist/` directory. Models, recordings and JSON result bundles
are rejected. Hashed assets upload before `index.html`; prior hashed files remain
available to already-open tabs. The HTML is uncached and explicitly invalidated.

### Optional: invoke SAM directly

Skip this section when using the helper sequence above. The Python commands wrap
SAM and the image/static publication steps. To run the
application deployment with SAM directly after `build-push`, load the verified
coordinates and deploy (shared concurrency shown for small accounts):

```sh
DEPLOY_IMAGE_URI=$(.venv/bin/python -c 'import json; print(json.load(open(".turntable-work/stateless-release.json"))["image_uri"])')
DEPLOY_BUILD_ID=$(.venv/bin/python -c 'import json; print(json.load(open(".turntable-work/stateless-release.json"))["build_id"])')
sam deploy --template-file infra/stateless/template.json \
  --stack-name turntable-stateless --region ap-southeast-2 \
  --image-repository "${DEPLOY_IMAGE_URI%@*}" \
  --capabilities CAPABILITY_IAM --no-resolve-s3 \
  --no-confirm-changeset --no-fail-on-empty-changeset \
  --parameter-overrides "ImageUri=$DEPLOY_IMAGE_URI" \
    "BuildId=$DEPLOY_BUILD_ID" ConcurrencyMode=unreserved MemorySize=3008 InferenceThreads=2 && \
.venv/bin/python scripts/stateless_deploy.py publish --execute
```

Run quota preflight first; direct SAM invocation does not run the helper's quota
or release-coordinate checks. Match the release's stack/region and add `--profile`
when using a named profile. The existing ECR repository is passed explicitly.
The templates fit inline, so deployment does not need a SAM-managed S3 artifact
bucket. The private website bucket remains the only application S3 bucket.

CloudFront signs access to a regular private S3 origin; the bucket is not an S3
website endpoint. Its policy allows reads only for this distribution. See
[AWS origin access control](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html).
Public Function URL invocation requires both narrowly conditioned permissions
included in the template. See [Lambda permission properties](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-permission.html).

## Check the deployment

After `publish` succeeds, open its printed `site_url`. You should see **Analyze
a video** with a recording selector, and no camera or saved-source choices.
Retrieve the deployed URLs again with:

```sh
.venv/bin/python scripts/stateless_deploy.py outputs --stack turntable-stateless --region ap-southeast-2 --execute
```

Append `frames/capabilities` to the returned `ApiUrl` (which already ends in `/`)
and open it in a browser. Its JSON should contain `"available": true` and the
`build_id` of your intended release. HTTP 200 alone is insufficient: this endpoint
also returns 200 when reporting unavailable models.

Process the small included demo through setup, **Analyze video** and **Open
results**, as described in [Run locally](#run-locally). Refresh afterward and
confirm that the session clears. The largest allowed recording needs a separate
[acceptance check](#load-and-acceptance-checks).

Before inviting participants, open the deployed site, check capabilities, run one
real recording through setup/analysis/playback, confirm camera/saved-source UI is
absent, and confirm no video/result objects appear in the static bucket. Exercise
failed requests, cancellation and browser refresh. CORS is managed by the Lambda
URL, while successful application responses use `Cache-Control: no-store`.

### If a step fails

| Last successful step or symptom | Next action |
| --- | --- |
| `docker info` fails or hangs | Start or repair the Docker engine and check free disk space before retrying `build-push`. |
| AWS credentials are missing/expired or the wrong account appears | Follow [Configure AWS access](#configure-aws-access); renew SSO if applicable and check STS identity again. |
| AWS reports `AccessDenied` | Check the deployment role's permissions and organization restrictions against [Requirements](#aws-account-and-workstation-requirements). A successful preflight does not test every provisioning permission. |
| `SAM Template Not Found` | Use the helper or pass `--template-file infra/stateless/template.json`; there is no root `template.yml`. |
| Preflight reports no reservable slots | Follow [small concurrency quotas](#accounts-with-a-small-concurrency-quota), or obtain the required quota. |
| AWS rejects memory above 3,008 MB | Use `--memory-mb 3008 --inference-threads 2` on preflight and deploy; recover an initial rollback before retrying. |
| `bootstrap` succeeded but the image did not build | Retry `build-push`; the image repository already exists. Do not deploy until a successful build writes a release file. |
| `build-push` succeeded but deployment failed | Keep the release file and retry `deploy` after resolving the error. If the first stack is in `ROLLBACK_COMPLETE`, follow [recovery](#recover-a-failed-first-deployment). |
| `deploy` succeeded but publication failed | Retry `publish`. There is no need to rebuild the image. |
| The page reports unavailable inference | Check `frames/capabilities`, the intended build ID and Lambda logs. Recheck the site/API configuration from the same release. |
| A local browser test cannot bind port 8001 | Stop the frame API you started manually; the test suite starts its own. |

Keep the successful release file before another build overwrites the default.
For later releases, use `build-push --build-id YOUR_NEW_ID --release-out
.turntable-work/releases/YOUR_NEW_ID.json --execute` and deploy that same file
with `--release`. Repeat your chosen region/profile/stack and concurrency mode.

## How this deployment works

[AWS SAM](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html)
is the deployment tool. The [application template](../infra/stateless/template.json)
declares the SAM transform and an `AWS::Serverless::Function`; SAM expands it into
CloudFormation resources. The helper uses `sam validate --lint` and `sam deploy`
for validation and provisioning. The image repository remains a small companion
CloudFormation template, also deployed through SAM.

The container is built with Docker, smoke-tested and pushed to ECR before SAM
deploys its immutable digest. There is no separate `sam build` step in this
workflow: AWS supports deploying functions built by other tools. See
[building outside SAM](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-using-build.html).

This deployment keeps each recording, calibration, checkpoint and result in its
browser tab. The browser samples the local video and sends bounded JSON frame
batches to a public Lambda Function URL. Lambda returns evidence and the next
checkpoint; subsequent requests can run in a fresh execution environment.
Each request carries the active model/config hashes and build ID obtained from
capabilities; workers reject an incompatible identity before inference.
The Python algorithms remain shared with the local processor. The browser runs
the TypeScript decisions and requests tabletop assessment only when needed.
The application uses one current recording format and the `/frames` API, with no
numbered formats or compatibility mode. Reprocess earlier exported recordings
through reviewed setup. Model/configuration hashes and build IDs are internal
evidence checks; they do not create a participant-facing version choice.

The deployment contains a private S3 bucket for the **built website only**,
CloudFront with origin access control, an ECR image repository, a Lambda function,
and its execution role/log group. The function can write logs; it has no S3,
database or queue permissions. There is no media bucket, saved job, camera
WebSocket, account system, or automatic server-side resume. Reloading/closing the
tab loses the session. Cancel stops browser requests and discards pending replies;
an already-running invocation may finish, with no result stored on the server.

## Runtime and limits

The Lambda image uses x86-64 Python 3.11 on Debian with the AWS runtime interface
client. Debian supports the current NumPy/SciPy binary wheels without depending
on the older Amazon Linux 2 runtime base. Core versions are constrained by
[the lockfile](../requirements.lock.txt); the image records `pip freeze` in
`runtime-packages.txt`. Supply `build-push --python-image` with a digest-pinned base when
exact base-image reproducibility is required. Deployments always use an immutable
ECR image digest, and checkpoints reject incompatible build/model/config IDs.

[Dockerfile.lambda](../Dockerfile.lambda) downloads and hash-verifies official
YOLOX Tiny during the build. Weights are baked into the image. There is no
invocation-time model download, Node subprocess, FFmpeg executable or video
normalization. The Python runtime interface client supports non-AWS base images;
Lambda images must target a single architecture and disable build provenance.
See [AWS Python container instructions](https://docs.aws.amazon.com/lambda/latest/dg/python-image.html).

The SAM template defaults to **3,008 MB**, **two inference threads** and a
**60-second timeout**, with reserved concurrency **10** by default. It uses no
provisioned concurrency, so cold starts remain possible. Ten reserved executions
cap simultaneous invocations; they do not limit the number of browser sessions.
For accounts unable to reserve capacity, the explicit
`--use-unreserved-concurrency` option shares the regional pool without a dedicated
reservation or function-specific cap. It does not prewarm execution environments.
Excess calls receive throttling and retry with jitter. The API is public:
exact-origin CORS controls browser access, not authentication or abuse prevention.
See [Lambda reserved concurrency](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html).

The defaults fit the account limit observed during the first deployment attempt.
Use `--memory-mb` and `--inference-threads` on both preflight and deploy to change
them. Their SAM parameters are `MemorySize` and `InferenceThreads`. For example,
after AWS permits a larger allocation, use `--memory-mb 6144 --inference-threads 4`
to test the original sizing. Lambda's environment settings override the image's
thread defaults, so changing these settings does not require rebuilding the image.
CPU allocation grows with memory; the 3,008 MB configuration requires its own
timing and maximum-recording checks before claiming throughput. See
[Lambda memory configuration](https://docs.aws.amazon.com/lambda/latest/dg/configuration-memory.html).

The shared [frame limits](../shared/frame-batch-limits.json) currently allow:

| Boundary | Ceiling |
| --- | --- |
| Local recording selection | 1,000,000,000 bytes; 600 seconds |
| Encoded request or response JSON | 4 MiB |
| Frames per observation batch | 8 |
| Processing frame dimensions | 1280 × 720 |
| One encoded image's decoded bytes | 2 MiB |
| Tables / tracks | 32 / 256 |
| Checkpoint JSON | 1 MiB |
| Target sampling | 8 Hz, actual captured timestamps retained |

An 80-second recording supplies roughly 640 sampled frames, or 80 observation
requests with full eight-frame batches, plus any requested surface assessments.
This is 20% fewer target samples than at 10 Hz; wall-clock improvement depends on
decoding, transfer and assessment work as well as inference. Sampling retains the
actual decoded presentation timestamps and does not change the original video's
playback rate. The existing local-server and live-camera modes still use 10 Hz.

All limits apply together; eight large images may exceed the JSON body limit.
Base64 and checkpoint overhead count toward the body limit. The client adjusts
batches to fit. A 1 GB local file is never posted as a single request. The ceilings
are validation limits, **not measured performance guarantees**. The Function URL
uses buffered JSON responses, below the platform's 6 MB invocation envelope.
See [Function URL configuration](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-url.html).

## Load and acceptance checks

The load harness defaults to ten parallel clients with one sequential checkpoint
chain per client. It repeats the first request before committing to verify that
retrying identical bytes produces the same evidence. It checks response/run/frame
identities and checkpoint continuation; 429 and transient failures retry with
jitter. It emits only aggregate counts, durations and error categories.

```sh
.venv/bin/python scripts/stateless_load.py --url http://127.0.0.1:8001
.venv/bin/python scripts/stateless_load.py --url https://YOUR_FUNCTION_URL --clients 10 --batches 3
.venv/bin/python scripts/stateless_load.py --url https://YOUR_FUNCTION_URL --clients 100 --batches 1
```

The default fixture is a tiny generated constant-color frame. It exercises the
real model when used against a real endpoint, but it is not restaurant footage or
a worst-case compute benchmark. `--request-file path/to/observe-request.json`
accepts an existing protocol body with representative frames and tables; the
harness repeats its frames at increasing timestamps within the supplied duration.
It never stores frames, checkpoints or responses. Do not redirect request payloads
into logs. The harness can incur Lambda charges when pointed at AWS.

The 1 GB/600-second client acceptance check is separate: test browser decode,
memory, actual capture timestamps, throttling/retries, accumulated evidence and
end-to-end completion with a representative longest recording. It is not covered
by the small synthetic load run. Inspect Lambda `Duration`,
`ConcurrentExecutions`, `Throttles` and `Max Memory Used`. Handled HTTP 4xx/5xx
responses are not necessarily counted by Lambda's `Errors` metric; application
logs contain only operation, HTTP status and duration for that reason.

Previous software checks, local timing results and AWS provisioning attempts are
preserved in the [stateless verification record](VALIDATION.md#stateless-verification-record).
Those records are dated evidence, not guarantees about a new deployment.

## Update, rollback and teardown

### Recover a failed first deployment

If the first application create fails (for example, AWS rejects the requested
memory), automatic rollback removes its partial resources. A stack in
`ROLLBACK_COMPLETE` must be deleted before creating it again. This differs from
`UPDATE_ROLLBACK_COMPLETE`, where an existing working stack can be updated.
See [CloudFormation stack states](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/view-stack-events.html).

After correcting the template, the following sequence waits for the failed
first create to roll back, deletes only its application stack record, and retries
using the already-built image. The separate `turntable-stateless-images` stack,
ECR image and local release file are preserved. Run from the repository root;
adjust the stack, region and profile consistently if using non-default values.
The first waiter intentionally stops this sequence if the stack is in a state
other than initial-create rollback; inspect the state before taking further action.

```sh
aws --region ap-southeast-2 cloudformation wait stack-rollback-complete --stack-name turntable-stateless && \
aws --region ap-southeast-2 cloudformation delete-stack --stack-name turntable-stateless && \
aws --region ap-southeast-2 cloudformation wait stack-delete-complete --stack-name turntable-stateless && \
.venv/bin/python scripts/stateless_deploy.py deploy --release .turntable-work/stateless-release.json --use-unreserved-concurrency --memory-mb 3008 --inference-threads 2 --execute && \
.venv/bin/python scripts/stateless_deploy.py publish --execute
```

### Update a deployed application

An ordinary update does not require deleting either stack. Choose the command
sequence according to what changed:

| Change | Run |
| --- | --- |
| Frontend only: labels, layout or browser controls | `publish` |
| Python inference, image dependencies, model, or shared sampling/protocol/configuration | `build-push` → `deploy` → `publish` from the same source checkout |
| Lambda memory or inference thread settings only | `deploy` with the existing release file and new settings |

For a frontend-only change:

```sh
.venv/bin/python scripts/stateless_deploy.py publish --stack turntable-stateless --region ap-southeast-2 --execute
```

For a complete code update, run this from the intended source checkout. It saves
a separate release file so the previous coordinates are not overwritten. Keep
the original `.turntable-work/stateless-release.json` too if it is your rollback
target. The image repository must still exist; otherwise start with bootstrap.

```sh
DEPLOY_BUILD_ID="competition-$(date -u +%Y%m%d-%H%M%S)"
DEPLOY_RELEASE=".turntable-work/releases/$DEPLOY_BUILD_ID.json"
.venv/bin/python scripts/stateless_deploy.py build-push \
  --stack turntable-stateless --region ap-southeast-2 \
  --build-id "$DEPLOY_BUILD_ID" --release-out "$DEPLOY_RELEASE" --execute && \
.venv/bin/python scripts/stateless_deploy.py deploy \
  --stack turntable-stateless --region ap-southeast-2 --release "$DEPLOY_RELEASE" \
  --use-unreserved-concurrency --memory-mb 3008 --inference-threads 2 --execute && \
.venv/bin/python scripts/stateless_deploy.py publish \
  --stack turntable-stateless --region ap-southeast-2 --execute
```

Repeat [Check the deployment](#check-the-deployment) after publication. Active
checkpoints belong to a build and may require users to restart browser analysis
after an update. Old hashed static assets remain until teardown; this does not
guarantee an old open tab remains compatible with a newly deployed worker.

Release files record the stack, region, image digest and build ID. They do not
record memory, thread count, concurrency mode or the matching frontend source
revision. Keep those settings and the associated source commit/checkout with your
local release notes. Verify STS identity when switching accounts: the release
check enforces stack and region, not the identity of your current AWS credentials.

### Roll back to a retained release

Use the source checkout matching the previous release, including its frontend,
then redeploy the retained image and publish that checkout. Replace the example
path below with the actual saved release file; its image must still exist in ECR.
Do not rebuild/publish the newer frontend over the old worker during rollback.

```sh
DEPLOY_RELEASE=.turntable-work/releases/REPLACE_WITH_PREVIOUS_BUILD_ID.json
.venv/bin/python scripts/stateless_deploy.py deploy \
  --stack turntable-stateless --region ap-southeast-2 --release "$DEPLOY_RELEASE" \
  --use-unreserved-concurrency --memory-mb 3008 --inference-threads 2 --execute && \
.venv/bin/python scripts/stateless_deploy.py publish \
  --stack turntable-stateless --region ap-southeast-2 --execute
```

These commands restore the shared-concurrency, 3,008 MB/two-thread configuration.
Use the recorded settings instead if that earlier release had different ones.

### Teardown (spin down)

Closing your browser or stopping Docker does not remove AWS resources. There is
no server process on your laptop to stop after deployment. To remove this
application, run the helper **before manually deleting its stack**: it needs the
stack outputs to discover the website bucket. Deleting a stack alone can fail
when its S3 bucket is nonempty; the helper empties the bucket first. See
[CloudFormation deletion troubleshooting](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/troubleshooting.html).

For a full reset, preview the operations:

```sh
.venv/bin/python scripts/stateless_deploy.py teardown \
  --stack turntable-stateless --region ap-southeast-2 \
  --delete-images --dry-run
```

Dry-run prints placeholder bucket/distribution identifiers because it makes no
AWS calls. Confirm the selected account and inspect the real stack outputs, then
run deletion:

```sh
aws --region ap-southeast-2 sts get-caller-identity && \
.venv/bin/python scripts/stateless_deploy.py outputs --stack turntable-stateless --region ap-southeast-2 --execute
```

```sh
.venv/bin/python scripts/stateless_deploy.py teardown \
  --stack turntable-stateless --region ap-southeast-2 \
  --delete-images --execute
```

This takes the website and API offline and deletes, in order:

1. The website files in the dedicated static S3 bucket.
2. `turntable-stateless`: its S3 bucket/policy, CloudFront distribution and related
   resources, Lambda function/URL/permissions, execution role and log group.
3. All Docker images in the dedicated `turntable-stateless-frames` ECR repository,
   the repository itself, and the `turntable-stateless-images` stack.

The helper waits for stack deletion. CloudFront removal can take several minutes;
leave the terminal running until it finishes. Deleting the ECR images also removes
the images needed for rollback. Local code, recordings, release files, `dist/`,
Docker images and build cache on your computer remain. There are no participant
videos or results stored on AWS to clean up.

If you want to remove the website/API but **keep the image repository for reuse**,
use this instead of the full deletion command:

```sh
.venv/bin/python scripts/stateless_deploy.py teardown \
  --stack turntable-stateless --region ap-southeast-2 --execute
```

Neither variant removes unrelated resources or any separate SAM-managed artifact
stack/bucket created by earlier `sam deploy --guided` attempts. The helper's
normal deployment path does not create those managed artifacts. Review them
separately in CloudFormation/S3 if you used that earlier path; they may be shared
with other SAM applications.

#### Remove turntable-stateless-images

`turntable-stateless-images` is a separate CloudFormation stack that manages the
`turntable-stateless-frames` ECR repository containing Lambda's Docker images.
The full teardown command with `--delete-images` removes it automatically after
the main application stack. Deleting only `turntable-stateless` leaves this image
stack and repository in place.

##### If the application stack was already deleted

The helper cannot run teardown again once its application stack outputs are
gone. If only bootstrap ran, or the app was deleted while ECR was retained,
confirm the app is gone and the selected account is correct. Then remove the
dedicated repository and image stack directly:

```sh
aws --region ap-southeast-2 ecr delete-repository \
  --repository-name turntable-stateless-frames --force && \
aws --region ap-southeast-2 cloudformation delete-stack \
  --stack-name turntable-stateless-images && \
aws --region ap-southeast-2 cloudformation wait stack-delete-complete \
  --stack-name turntable-stateless-images
```

This deletes **all stored deployment images**, including rollback images. You
must build and push an image again before redeploying. Do not use this cleanup
while a deployed Lambda still needs images from that repository.

If the repository is already absent but the image stack still exists, skip the
ECR deletion and run only:

```sh
aws --region ap-southeast-2 cloudformation delete-stack \
  --stack-name turntable-stateless-images && \
aws --region ap-southeast-2 cloudformation wait stack-delete-complete \
  --stack-name turntable-stateless-images
```

To check both stack records after a full teardown:

```sh
aws --region ap-southeast-2 cloudformation describe-stacks --stack-name turntable-stateless
aws --region ap-southeast-2 cloudformation describe-stacks --stack-name turntable-stateless-images
```

After successful deletion, each should report that the stack does not exist.
`AccessDenied` or a credentials/network error is not proof of deletion. If a stack
is in `DELETE_FAILED`, inspect its resource events and resolve the reported
blocker before retrying cleanup.

### Start again after teardown

Keep your repository and installed tools. Sign in again if needed, then repeat
[Validate before provisioning](#validate-before-provisioning) and
[Build and deploy](#build-and-deploy) with a new build ID. Bootstrap recreates the
image stack after a full teardown; a fresh build/push is required because the old
ECR images were deleted. Old local release files still exist but point to those
deleted images, so do not use them as proof of a new successful build.

If you retained ECR, you can reuse its compatible release file and matching
checkout with `deploy` → `publish`, or run the full build sequence for new code.
Always repeat the shared-concurrency and memory/thread options on deploy.
The recreated app can have new website and API URLs. `publish` reads the new API
URL automatically; use `outputs --execute` to get the current website address.
Repeat the demo setup → analysis → playback check before sharing it.
