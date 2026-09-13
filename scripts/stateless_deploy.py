"""Build and deploy the stateless recording demo with AWS SAM. Default: print commands only.

AWS changes require --execute. The static publisher accepts only this project's
fresh dist/ output; it never accepts a recording or analysis-results directory.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
INFRA = ROOT / "infra" / "stateless"
TEMPLATE = INFRA / "template.json"
ECR_TEMPLATE = INFRA / "ecr.json"
RESERVED = 10
DEFAULT_MEMORY_MB = 3008
DEFAULT_INFERENCE_THREADS = 2
STATIC_SUFFIXES = {".html", ".js", ".css", ".svg", ".png", ".jpg", ".jpeg", ".ico", ".woff", ".woff2", ".webp", ".txt", ".webmanifest"}


def validate_templates() -> dict:
    """Offline structural and deployment-policy checks, not AWS schema validation."""
    template = json.loads(TEMPLATE.read_text())
    ecr = json.loads(ECR_TEMPLATE.read_text())
    resources = template["Resources"]
    assert template["Transform"] == "AWS::Serverless-2016-10-31"
    allowed = {"AWS::S3::Bucket", "AWS::S3::BucketPolicy", "AWS::CloudFront::OriginAccessControl", "AWS::CloudFront::CachePolicy", "AWS::CloudFront::Distribution", "AWS::Logs::LogGroup", "AWS::IAM::Role", "AWS::Serverless::Function", "AWS::Lambda::Url", "AWS::Lambda::Permission"}
    assert all(resource["Type"] in allowed for resource in resources.values())
    assert sum(item["Type"] == "AWS::S3::Bucket" for item in resources.values()) == 1
    function = resources["FrameFunction"]["Properties"]
    assert resources["FrameFunction"]["Type"] == "AWS::Serverless::Function"
    assert function["ImageUri"] == {"Ref": "ImageUri"} and "Code" not in function
    assert "AutoPublishAlias" not in function and "Events" not in function and "FunctionUrlConfig" not in function
    assert function["PackageType"] == "Image" and function["Architectures"] == ["x86_64"]
    assert function["MemorySize"] == {"Ref": "MemorySize"} and function["Timeout"] == 60
    memory = template["Parameters"]["MemorySize"]
    assert (memory["Type"], memory["Default"], memory["MinValue"], memory["MaxValue"]) == ("Number", DEFAULT_MEMORY_MB, 3008, 10240)
    threads = template["Parameters"]["InferenceThreads"]
    assert threads["Type"] == "Number" and threads["Default"] == DEFAULT_INFERENCE_THREADS and threads["AllowedValues"] == [1, 2, 4]
    assert all(function["Environment"]["Variables"][name] == {"Ref": "InferenceThreads"} for name in ("TABLEWATCH_INTRA_THREADS", "OMP_NUM_THREADS"))
    mode = template["Parameters"]["ConcurrencyMode"]
    assert mode["Default"] == "reserved" and mode["AllowedValues"] == ["reserved", "unreserved"]
    assert template["Conditions"]["ReserveConcurrency"] == {"Fn::Equals": [{"Ref": "ConcurrencyMode"}, "reserved"]}
    assert function["ReservedConcurrentExecutions"] == {"Fn::If": ["ReserveConcurrency", RESERVED, {"Ref": "AWS::NoValue"}]}
    assert "VpcConfig" not in function and "ProvisionedConcurrencyConfig" not in function
    assert function["ImageConfig"]["Command"] == ["service.stateless.lambda_handler"]
    cors = resources["FunctionUrl"]["Properties"]
    assert cors["AuthType"] == "NONE" and cors["InvokeMode"] == "BUFFERED"
    assert cors["Cors"]["AllowOrigins"] == [{"Fn::Sub": "https://${Distribution.DomainName}"}]
    assert resources["PublicInvokePermission"]["Properties"]["InvokedViaFunctionUrl"] is True
    assert resources["PublicUrlPermission"]["Properties"]["FunctionUrlAuthType"] == "NONE"
    policies = resources["FunctionRole"]["Properties"]["Policies"]
    actions = {action for policy in policies for statement in policy["PolicyDocument"]["Statement"] for action in statement["Action"]}
    assert actions == {"logs:CreateLogStream", "logs:PutLogEvents"}
    assert all(resources["StaticBucket"]["Properties"]["PublicAccessBlockConfiguration"].values())
    assert resources["OriginAccess"]["Properties"]["OriginAccessControlConfig"]["SigningBehavior"] == "always"
    assert ecr["Resources"]["Images"]["Properties"]["ImageTagMutability"] == "IMMUTABLE"
    # Ensure Ref/GetAtt dependencies form a DAG, including CORS -> distribution.
    def refs(value):
        if isinstance(value, dict):
            if "Ref" in value:
                yield value["Ref"]
            if "Fn::GetAtt" in value:
                yield value["Fn::GetAtt"][0]
            if isinstance(value.get("Fn::Sub"), str):
                yield from (name.split(".")[0] for name in re.findall(r"\$\{([^}]+)\}", value["Fn::Sub"]))
            for item in value.values():
                yield from refs(item)
        elif isinstance(value, list):
            for item in value:
                yield from refs(item)
    visiting, visited = set(), set()
    def visit(name):
        assert name not in visiting, f"CloudFormation circular dependency at {name}"
        if name in visited:
            return
        visiting.add(name)
        for dependency in set(refs(resources[name])) & resources.keys():
            visit(dependency)
        visiting.remove(name)
        visited.add(name)
    for name in resources:
        visit(name)
    return {"offline_template_checks": "passed", "sam_template_validation": "not run", "aws_template_validation": "not run", "resources": len(resources)}


def check_capacity(settings: dict, existing_reserved: int = 0, *, use_unreserved_concurrency: bool = False) -> dict:
    limits = settings.get("AccountLimit", {})
    unreserved = limits.get("UnreservedConcurrentExecutions")
    total = limits.get("ConcurrentExecutions")
    if any(type(value) is not int or value < 0 for value in (unreserved, total, existing_reserved)):
        raise ValueError("AWS did not return concurrency limits; cannot pass quota preflight")
    pool = unreserved + existing_reserved
    if pool > total:
        raise ValueError("AWS returned inconsistent concurrency limits; retry quota preflight")
    summary = {"regional_concurrency": total, "unreserved_concurrency": unreserved, "existing_function_reservation": existing_reserved}
    if use_unreserved_concurrency:
        if pool <= 0:
            raise ValueError("No shared Lambda concurrency is available; increase the regional quota or release an existing reservation first")
        return {**summary, "concurrency_mode": "unreserved", "requested_reservation": None, "available_shared_concurrency": pool,
                "concurrency_note": "Shared with other regional functions; no dedicated capacity or function-specific ten-execution cap. This is a quota, not currently idle capacity."}
    available = pool - 100
    if available < RESERVED:
        raise ValueError(f"Lambda quota cannot reserve {RESERVED} executions while leaving AWS's required 100 unreserved; only {max(0, available)} slots are reservable (regional quota: {total}, shared pool after releasing this function's reservation: {pool}). Increase the regional concurrency quota by at least {RESERVED - available}, or pass --use-unreserved-concurrency to both preflight and deploy to share that pool without a function-specific cap.")
    return {**summary, "concurrency_mode": "reserved", "requested_reservation": RESERVED}


def check_memory_capacity(quotas: dict, memory_mb: int = DEFAULT_MEMORY_MB) -> str:
    """Only compare function memory, in known units; MicroVM quotas are separate."""
    memory = [item for item in quotas.get("Quotas", [])
              if "function" in item.get("QuotaName", "").lower()
              and "memory" in item.get("QuotaName", "").lower()
              and "microvm" not in item.get("QuotaName", "").lower()]
    if not memory:
        return f"not exposed by quota API; AWS must accept {memory_mb} MB during deployment"
    unknown_unit = False
    for item in memory:
        factor = {"megabytes": 1, "mib": 1, "mb": 1, "gigabytes": 1024, "gib": 1024, "gb": 1024}.get(str(item.get("Unit", "")).lower())
        if factor is None:
            unknown_unit = True
            continue
        value = item.get("Value")
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            raise ValueError("AWS returned an invalid function memory quota; cannot pass quota preflight")
        if value * factor < memory_mb:
            raise ValueError(f"This account's function memory quota is {value * factor:g} MB, below the requested {memory_mb} MB")
    if unknown_unit:
        return f"function memory quota has unrecognized units; AWS must accept {memory_mb} MB during deployment"
    return "checked"


def static_files(directory: Path) -> list[Path]:
    if not directory.is_dir() or not (directory / "index.html").is_file():
        raise ValueError("A freshly built dist/index.html is required")
    files = []
    for path in sorted(directory.rglob("*")):
        if path.is_symlink():
            raise ValueError("Static output must not contain symlinks")
        if path.is_file():
            if path.suffix.lower() not in STATIC_SUFFIXES:
                raise ValueError(f"Unexpected static artifact type: {path.suffix or '(none)'}; recordings, JSON results and model files cannot be published")
            if path.stat().st_size > 20 * 1024 * 1024:
                raise ValueError("Static artifact exceeds 20 MiB; refusing possible media content")
            files.append(path)
    return files


class Runner:
    def __init__(self, args):
        self.args = args
        self.execute = args.execute

    def command(self, command, *, capture=False, input_bytes=None, env=None, show=True, timeout=None):
        if show:
            print(shlex.join(map(str, command)), flush=True)
        if not self.execute:
            return ""
        result = subprocess.run(list(map(str, command)), cwd=ROOT, input=input_bytes, stdout=subprocess.PIPE if capture else None, check=True, timeout=timeout, env={**os.environ, "AWS_PAGER": "", "AWS_CLI_AUTO_PROMPT": "off", **(env or {})})
        return result.stdout.decode().strip() if capture else ""

    def check_docker(self):
        try:
            version = self.command(["docker", "info", "--format", "{{.ServerVersion}}"], capture=True, timeout=15)
        except subprocess.TimeoutExpired:
            raise ValueError("Docker engine did not respond within 15 seconds. Check free disk space, start or restart Docker Desktop, and wait for docker info to succeed before retrying build-push.") from None
        except (FileNotFoundError, subprocess.CalledProcessError):
            raise ValueError("Docker engine is unavailable. Ensure Docker Desktop is installed and running, and docker info succeeds before retrying build-push.") from None
        if self.execute and not version:
            raise ValueError("Docker did not return a server version. Wait for docker info to succeed before retrying build-push.")

    def aws(self, *command, capture=True):
        args = ["aws", "--region", self.args.region, "--no-cli-pager"]
        if self.args.profile:
            args += ["--profile", self.args.profile]
        return self.command([*args, *command, "--output", "json"], capture=capture)

    def sam(self, *command):
        args = ["sam", *command, "--region", self.args.region]
        if self.args.profile:
            args += ["--profile", self.args.profile]
        return self.command(args, env={"SAM_CLI_TELEMETRY": "0"})

    def outputs(self, stack, defaults):
        result = self.aws("cloudformation", "describe-stacks", "--stack-name", stack)
        if not self.execute:
            return defaults
        return {item["OutputKey"]: item["OutputValue"] for item in json.loads(result)["Stacks"][0].get("Outputs", [])}

    def deploy_stack(self, stack, template, parameters):
        # All image bytes are already verified and pushed to ECR. These small
        # templates contain no local artifacts needing a SAM-managed S3 bucket.
        image_options = ["--image-repository", parameters["ImageUri"].split("@", 1)[0]] if "ImageUri" in parameters else []
        self.sam("deploy", "--stack-name", stack, "--template-file", str(template), "--capabilities", "CAPABILITY_IAM", "--no-fail-on-empty-changeset", "--no-confirm-changeset", "--no-resolve-s3", "--no-progressbar", *image_options, "--parameter-overrides", *[f"{key}={value}" for key, value in parameters.items()])

    def preflight(self):
        self.aws("sts", "get-caller-identity")
        raw = self.aws("lambda", "get-account-settings")
        if not self.execute:
            if self.args.use_unreserved_concurrency:
                print(f"Check: shared concurrency must be positive; no dedicated capacity or function-specific ten-execution cap. Confirm {self.args.memory_mb} MB is permitted by this account.")
            else:
                print(f"Check: ten reserved executions must leave at least 100 unreserved; confirm {self.args.memory_mb} MB is permitted by this account.")
            return
        current = 0
        # First deployments have no function yet. A successful, paginated list
        # avoids an expected ResourceNotFound error without hiding IAM failures.
        names = json.loads(self.aws("lambda", "list-functions"))["Functions"]
        if any(item["FunctionName"] == f"{self.args.stack}-frames" for item in names):
            current_raw = self.aws("lambda", "get-function-concurrency", "--function-name", f"{self.args.stack}-frames")
            # AWS CLI may emit no JSON when the function has no reservation.
            # Only an empty successful response is optional; malformed JSON
            # and command failures must still stop preflight.
            current = json.loads(current_raw).get("ReservedConcurrentExecutions", 0) if current_raw.strip() else 0
        summary = check_capacity(json.loads(raw), current, use_unreserved_concurrency=self.args.use_unreserved_concurrency)
        quotas = json.loads(self.aws("service-quotas", "list-service-quotas", "--service-code", "lambda"))
        summary["memory_mb"] = self.args.memory_mb
        summary["inference_threads"] = self.args.inference_threads
        summary["memory_quota"] = check_memory_capacity(quotas, self.args.memory_mb)
        print(json.dumps(summary))


def image_parameters(args):
    uri, build = args.image_uri, args.build_id
    if args.release:
        try:
            release = json.loads(args.release.read_text())
        except FileNotFoundError:
            raise ValueError(f"Release file not found: {args.release}. Complete build-push successfully before deploy; it writes this file after the image is verified and pushed. Run publish only after deploy succeeds.") from None
        if release.get("region") != args.region or release.get("stack") != args.stack:
            raise ValueError("Release file belongs to a different region or stack")
        uri, build = release["image_uri"], release["build_id"]
    if not uri or not build:
        raise ValueError("Supply --release or both --image-uri and --build-id")
    expression = json.loads(TEMPLATE.read_text())["Parameters"]["ImageUri"]["AllowedPattern"]
    if not re.fullmatch(expression, uri) or f".ecr.{args.region}." not in uri:
        raise ValueError("Use an immutable ECR image digest in the selected region")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", build):
        raise ValueError("Build ID must contain 1-128 letters, digits, dot, dash or underscore")
    return uri, build


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["validate", "preflight", "bootstrap", "build-push", "deploy", "publish", "outputs", "teardown"])
    parser.add_argument("--stack", default="turntable-stateless")
    parser.add_argument("--region", default="ap-southeast-2")
    parser.add_argument("--profile")
    execution = parser.add_mutually_exclusive_group()
    execution.add_argument("--execute", action="store_true", help="Run the printed commands; may create or delete AWS resources")
    execution.add_argument("--dry-run", action="store_true", help="Print commands only (the default)")
    parser.add_argument("--aws", action="store_true", help="With validate --execute, also call AWS validate-template")
    parser.add_argument("--use-unreserved-concurrency", action="store_true", help="With preflight/deploy, share the regional concurrency pool instead of reserving and capping this function at ten executions")
    parser.add_argument("--memory-mb", type=int, default=DEFAULT_MEMORY_MB, help="Lambda memory for preflight/deploy, 3008-10240 MB (default: 3008; subject to account quota)")
    parser.add_argument("--inference-threads", type=int, choices=[1, 2, 4], default=DEFAULT_INFERENCE_THREADS, help="ONNX/OpenMP threads for preflight/deploy (default: 2)")
    parser.add_argument("--build-id")
    parser.add_argument("--python-image", default="python:3.11-slim-bookworm", help="Python 3.11 base image; use a digest-pinned reference for repeatable image rebuilds")
    parser.add_argument("--image-uri")
    parser.add_argument("--release", type=Path)
    parser.add_argument("--release-out", type=Path, default=ROOT / ".turntable-work" / "stateless-release.json")
    parser.add_argument("--delete-images", action="store_true", help="With teardown, also delete the dedicated ECR image repository and image stack")
    args = parser.parse_args(argv)
    if not 3008 <= args.memory_mb <= 10240:
        parser.error("--memory-mb must be between 3008 and 10240")
    if args.use_unreserved_concurrency and args.action not in {"preflight", "deploy"}:
        parser.error("--use-unreserved-concurrency applies only to preflight and deploy")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,39}", args.stack):
        parser.error("stack must be 1-40 lowercase letters, digits or dashes, starting with a letter")
    if not re.fullmatch(r"[a-z]{2}-[a-z]+-\d", args.region):
        parser.error("region must be a standard commercial AWS region")
    runner = Runner(args)
    summary = validate_templates()
    image_defaults = {"RepositoryUri": f"000000000000.dkr.ecr.{args.region}.amazonaws.com/{args.stack}-frames", "RepositoryName": f"{args.stack}-frames"}
    site_defaults = {"ApiUrl": "https://FUNCTION_ID.lambda-url.REGION.on.aws/", "SiteUrl": "https://DISTRIBUTION.cloudfront.net", "StaticBucket": "STATIC_BUCKET_FROM_STACK", "DistributionId": "DISTRIBUTION_ID_FROM_STACK"}
    if args.action == "validate":
        for template in (ECR_TEMPLATE, TEMPLATE):
            runner.sam("validate", "--lint", "--template-file", str(template))
        if args.execute:
            summary["sam_template_validation"] = "passed"
        if args.aws:
            for template in (ECR_TEMPLATE, TEMPLATE):
                runner.aws("cloudformation", "validate-template", "--template-body", f"file://{template}")
            if args.execute:
                summary["aws_template_validation"] = "passed"
        print(json.dumps(summary))
    elif args.action == "preflight":
        runner.preflight()
    elif args.action == "bootstrap":
        runner.deploy_stack(f"{args.stack}-images", ECR_TEMPLATE, {"ApplicationStack": args.stack})
        print(json.dumps(runner.outputs(f"{args.stack}-images", image_defaults)))
    elif args.action == "build-push":
        if not args.build_id or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", args.build_id):
            raise ValueError("build-push requires a unique --build-id valid as an immutable image tag")
        runner.check_docker()
        outputs = runner.outputs(f"{args.stack}-images", image_defaults)
        repo, name = outputs["RepositoryUri"], outputs["RepositoryName"]
        image = f"{repo}:{args.build_id}"
        runner.command(["docker", "buildx", "build", "--platform", "linux/amd64", "--provenance=false", "--progress=plain", "--load", "--file", "Dockerfile.lambda", "--build-arg", f"BUILD_ID={args.build_id}", "--build-arg", f"PYTHON_IMAGE={args.python_image}", "--tag", image, "."])
        smoke = "import json,sys; assert sys.version_info[:2]==(3,11); from service.stateless import lambda_handler; r=lambda_handler({'version':'2.0','rawPath':'/frames/capabilities','requestContext':{'http':{'method':'GET'}}},None); assert r['statusCode']==200,r['statusCode']; b=json.loads(r['body']); assert b['available'] is True; print('Lambda handler and baked model smoke check passed')"
        runner.command(["docker", "run", "--rm", "--platform", "linux/amd64", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m", "--network", "none", "--entrypoint", "python", image, "-c", smoke])
        # Never echo the ECR login password, including on command failure.
        password = runner.command(["aws", "--region", args.region, *(["--profile", args.profile] if args.profile else []), "ecr", "get-login-password"], capture=True)
        runner.command(["docker", "login", "--username", "AWS", "--password-stdin", repo.split("/")[0]], input_bytes=(password + "\n").encode())
        runner.command(["docker", "push", image])
        raw = runner.aws("ecr", "describe-images", "--repository-name", name, "--image-ids", f"imageTag={args.build_id}")
        if args.execute:
            digest = json.loads(raw)["imageDetails"][0]["imageDigest"]
            release = {"stack": args.stack, "region": args.region, "build_id": args.build_id, "image_uri": f"{repo}@{digest}", "python_image": args.python_image}
            args.release_out.parent.mkdir(parents=True, exist_ok=True)
            args.release_out.write_text(json.dumps(release, indent=2) + "\n")
            print(f"Wrote deployment coordinates to {args.release_out}")
    elif args.action == "deploy":
        uri, build = image_parameters(args)
        runner.preflight()
        runner.deploy_stack(args.stack, TEMPLATE, {"ImageUri": uri, "BuildId": build, "ConcurrencyMode": "unreserved" if args.use_unreserved_concurrency else "reserved", "MemorySize": args.memory_mb, "InferenceThreads": args.inference_threads})
        print(json.dumps(runner.outputs(args.stack, site_defaults)))
        print("Infrastructure ready. Run publish to build with the actual API URL and upload static assets.")
    elif args.action == "publish":
        outputs = runner.outputs(args.stack, site_defaults)
        runner.command(["npm", "ci"])
        print("Build environment: VITE_PROCESSING_MODE=stateless; VITE_STATELESS_API_URL=stack ApiUrl")
        runner.command(["npm", "run", "build"], env={"VITE_PROCESSING_MODE": "stateless", "VITE_STATELESS_API_URL": outputs["ApiUrl"]})
        if args.execute:
            static_files(ROOT / "dist")
        bucket = f"s3://{outputs['StaticBucket']}"
        # Hashed assets first, index last. Do not delete old hashed files while
        # an open browser may still reference them during a deployment.
        runner.aws("s3", "sync", str(ROOT / "dist"), bucket, "--exclude", "index.html", "--cache-control", "public,max-age=31536000,immutable", capture=False)
        runner.aws("s3", "cp", str(ROOT / "dist" / "index.html"), f"{bucket}/index.html", "--cache-control", "no-cache,max-age=0,must-revalidate", "--content-type", "text/html", capture=False)
        runner.aws("cloudfront", "create-invalidation", "--distribution-id", outputs["DistributionId"], "--paths", "/index.html", "/")
        print(json.dumps({"site_url": outputs["SiteUrl"], "api_url": outputs["ApiUrl"]}))
    elif args.action == "outputs":
        print(json.dumps(runner.outputs(args.stack, site_defaults), indent=2))
    elif args.action == "teardown":
        outputs = runner.outputs(args.stack, site_defaults)
        runner.aws("s3", "rm", f"s3://{outputs['StaticBucket']}", "--recursive", capture=False)
        runner.aws("cloudformation", "delete-stack", "--stack-name", args.stack)
        runner.aws("cloudformation", "wait", "stack-delete-complete", "--stack-name", args.stack)
        if args.delete_images:
            images = runner.outputs(f"{args.stack}-images", image_defaults)
            runner.aws("ecr", "delete-repository", "--repository-name", images["RepositoryName"], "--force")
            runner.aws("cloudformation", "delete-stack", "--stack-name", f"{args.stack}-images")
            runner.aws("cloudformation", "wait", "stack-delete-complete", "--stack-name", f"{args.stack}-images")
        else:
            print("Application removed; dedicated ECR images retained. Use --delete-images to remove them as well.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, AssertionError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f"Stateless deployment stopped: {error}", file=sys.stderr)
        raise SystemExit(1)
