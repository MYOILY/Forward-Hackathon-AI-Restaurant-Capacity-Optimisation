"""Offline deployment policy and concurrent client-protocol checks.

These tests make no AWS calls. Inference is injected; checkpointing and protocol
validation use the real stateless processor and tracker implementation.
"""

from concurrent.futures import ThreadPoolExecutor
import copy
import json
from pathlib import Path
import threading
from types import SimpleNamespace

import pytest

from scripts import stateless_deploy as deployment
from scripts import stateless_load as load


def test_template_is_single_static_bucket_and_logs_only_function_with_exact_origin():
    assert deployment.validate_templates()["offline_template_checks"] == "passed"
    template = json.loads(deployment.TEMPLATE.read_text())
    assert template["Transform"] == "AWS::Serverless-2016-10-31"
    resources = template["Resources"]
    bucket = resources["StaticBucket"]["Properties"]
    assert "WebsiteConfiguration" not in bucket
    assert "NotificationConfiguration" not in bucket
    assert "LifecycleConfiguration" not in bucket
    function = resources["FrameFunction"]["Properties"]
    assert resources["FrameFunction"]["Type"] == "AWS::Serverless::Function"
    assert function["ImageUri"] == {"Ref": "ImageUri"}
    assert "Code" not in function and "AutoPublishAlias" not in function
    assert "Layers" not in function
    assert not any(resource["Type"] in {"AWS::Lambda::Version", "AWS::Lambda::Alias"} for resource in resources.values())
    assert function["MemorySize"] == {"Ref": "MemorySize"}
    memory = template["Parameters"]["MemorySize"]
    assert memory["Type"] == "Number"
    assert (memory["Default"], memory["MinValue"], memory["MaxValue"]) == (3008, 3008, 10240)
    threads = template["Parameters"]["InferenceThreads"]
    assert threads["Type"] == "Number"
    assert threads["Default"] == 2 and threads["AllowedValues"] == [1, 2, 4]
    environment = function["Environment"]["Variables"]
    assert environment["TABLEWATCH_INTRA_THREADS"] == {"Ref": "InferenceThreads"}
    assert environment["OMP_NUM_THREADS"] == {"Ref": "InferenceThreads"}
    assert environment["OPENBLAS_NUM_THREADS"] == "1"
    assert template["Parameters"]["ConcurrencyMode"]["Default"] == "reserved"
    assert set(template["Parameters"]["ConcurrencyMode"]["AllowedValues"]) == {"reserved", "unreserved"}
    assert template["Conditions"]["ReserveConcurrency"] == {"Fn::Equals": [{"Ref": "ConcurrencyMode"}, "reserved"]}
    assert function["ReservedConcurrentExecutions"] == {"Fn::If": ["ReserveConcurrency", 10, {"Ref": "AWS::NoValue"}]}
    assert resources["Distribution"]["Properties"]["DistributionConfig"]["Origins"][0]["OriginAccessControlId"] == {"Ref": "OriginAccess"}


def test_offline_validation_rejects_hidden_storage_permissions(tmp_path, monkeypatch):
    template = json.loads(deployment.TEMPLATE.read_text())
    template["Resources"]["FunctionRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"][0]["Action"].append("s3:PutObject")
    candidate = tmp_path / "unsafe.json"
    candidate.write_text(json.dumps(template))
    monkeypatch.setattr(deployment, "TEMPLATE", candidate)
    with pytest.raises(AssertionError):
        deployment.validate_templates()


@pytest.mark.parametrize("unreserved,current,passed", [(110, 0, True), (109, 0, False), (100, 10, True), (10, 0, False)])
def test_preflight_leaves_required_unreserved_capacity(unreserved, current, passed):
    settings = {"AccountLimit": {"ConcurrentExecutions": 1000, "UnreservedConcurrentExecutions": unreserved}}
    if passed:
        assert deployment.check_capacity(settings, current)["requested_reservation"] == 10
    else:
        with pytest.raises(ValueError, match="100 unreserved"):
            deployment.check_capacity(settings, current)


def test_preflight_does_not_treat_missing_account_values_as_capacity():
    with pytest.raises(ValueError, match="did not return"):
        deployment.check_capacity({})


def test_low_quota_account_requires_explicit_unreserved_opt_in():
    settings = {"AccountLimit": {"ConcurrentExecutions": 10, "UnreservedConcurrentExecutions": 10}}
    with pytest.raises(ValueError, match="100 unreserved"):
        deployment.check_capacity(settings)
    summary = deployment.check_capacity(settings, use_unreserved_concurrency=True)
    assert summary["regional_concurrency"] == 10
    assert summary["requested_reservation"] is None
    assert summary["concurrency_mode"] == "unreserved"
    assert summary["available_shared_concurrency"] == 10


@pytest.mark.parametrize("total,unreserved,current", [(0, 0, 0), (10, 0, 0), (-1, 10, 0), (10, -1, 0), (10, 10, -1), (True, 10, 0), (10, "10", 0), (10, 10, None), (10, 11, 0), (10, 10, 1)])
def test_unreserved_preflight_rejects_invalid_or_unavailable_capacity(total, unreserved, current):
    settings = {"AccountLimit": {"ConcurrentExecutions": total, "UnreservedConcurrentExecutions": unreserved}}
    with pytest.raises(ValueError):
        deployment.check_capacity(settings, current, use_unreserved_concurrency=True)


def test_unreserved_preflight_accounts_for_releasing_existing_function_reservation():
    settings = {"AccountLimit": {"ConcurrentExecutions": 10, "UnreservedConcurrentExecutions": 0}}
    summary = deployment.check_capacity(settings, 10, use_unreserved_concurrency=True)
    assert summary["existing_function_reservation"] == 10
    assert summary["requested_reservation"] is None
    assert summary["available_shared_concurrency"] == 10


@pytest.mark.parametrize("memory_mb", [3008, 6144])
def test_memory_preflight_ignores_separate_microvm_memory_quota(memory_mb):
    quotas = {"Quotas": [{"QuotaName": "Max allocated MicroVM memory", "Value": 8.0, "Unit": "Gigabytes", "QuotaCode": "L-CD1C0CC4"}]}
    assert deployment.check_memory_capacity(quotas, memory_mb=memory_mb) == f"not exposed by quota API; AWS must accept {memory_mb} MB during deployment"


def test_memory_preflight_rejects_insufficient_function_memory():
    quotas = {"Quotas": [{"QuotaName": "Function memory allocation", "Value": 3072, "Unit": "Megabytes"}]}
    with pytest.raises(ValueError, match="6144 MB"):
        deployment.check_memory_capacity(quotas, memory_mb=6144)


@pytest.mark.parametrize("quota_mb", [3008, 3072])
def test_memory_preflight_accepts_default_allocation_in_restricted_accounts(quota_mb):
    quotas = {"Quotas": [{"QuotaName": "Function memory allocation", "Value": quota_mb, "Unit": "Megabytes"}]}
    assert deployment.check_memory_capacity(quotas) == "checked"


@pytest.mark.parametrize("value,unit", [(6144, "Megabytes"), (6144, "MiB"), (6144, "MB"), (6, "Gigabytes"), (6, "GiB"), (6, "GB")])
def test_memory_preflight_normalizes_function_memory_units(value, unit):
    quotas = {"Quotas": [{"QuotaName": "Function memory allocation", "Value": value, "Unit": unit}]}
    assert deployment.check_memory_capacity(quotas, memory_mb=6144) == "checked"


@pytest.mark.parametrize("memory_mb", [3008, 6144])
def test_memory_preflight_does_not_claim_unknown_units_were_checked(memory_mb):
    quotas = {"Quotas": [{"QuotaName": "Function memory allocation", "Value": 10000, "Unit": "Unknown"}]}
    assert deployment.check_memory_capacity(quotas, memory_mb=memory_mb) == f"function memory quota has unrecognized units; AWS must accept {memory_mb} MB during deployment"


@pytest.mark.parametrize("configuration,memory_mb,inference_threads", [([], 3008, 2), (["--memory-mb", "6144", "--inference-threads", "4"], 6144, 4), (["--memory-mb", "10240", "--inference-threads", "1"], 10240, 1)])
def test_preflight_skips_concurrency_lookup_for_absent_function(monkeypatch, capsys, configuration, memory_mb, inference_threads):
    calls = []
    def aws(self, *command, **kwargs):
        calls.append(command[:2])
        responses = {
            ("sts", "get-caller-identity"): {},
            ("lambda", "get-account-settings"): {"AccountLimit": {"ConcurrentExecutions": 10, "UnreservedConcurrentExecutions": 10}},
            ("lambda", "list-functions"): {"Functions": [{"FunctionName": "another-function"}]},
            ("service-quotas", "list-service-quotas"): {"Quotas": [{"QuotaName": "Max allocated MicroVM memory", "Value": 8.0, "Unit": "Gigabytes", "QuotaCode": "L-CD1C0CC4"}]},
        }
        assert command[:2] in responses, f"Unexpected AWS call: {command}"
        return json.dumps(responses[command[:2]])
    monkeypatch.setattr(deployment.Runner, "aws", aws)
    assert deployment.main(["preflight", "--use-unreserved-concurrency", "--execute", *configuration]) == 0
    assert ("lambda", "list-functions") in calls
    assert ("lambda", "get-function-concurrency") not in calls
    summary = json.loads(capsys.readouterr().out)
    assert summary["concurrency_mode"] == "unreserved"
    assert summary["memory_mb"] == memory_mb
    assert summary["inference_threads"] == inference_threads
    assert summary["memory_quota"] == f"not exposed by quota API; AWS must accept {memory_mb} MB during deployment"


@pytest.mark.parametrize("raw,current", [
    ("", 0),
    (" \n\t", 0),
    ("{}", 0),
    ('{"ReservedConcurrentExecutions": 0}', 0),
    ('{"ReservedConcurrentExecutions": 7}', 7),
    ("malformed nonempty JSON", None),
])
def test_preflight_reads_optional_reservation_without_hiding_malformed_json(monkeypatch, capsys, raw, current):
    def aws(self, *command, **kwargs):
        if command[:2] == ("lambda", "get-function-concurrency"):
            return raw
        responses = {
            ("sts", "get-caller-identity"): {},
            ("lambda", "get-account-settings"): {"AccountLimit": {"ConcurrentExecutions": 20, "UnreservedConcurrentExecutions": 10}},
            ("lambda", "list-functions"): {"Functions": [{"FunctionName": "turntable-stateless-frames"}]},
            ("service-quotas", "list-service-quotas"): {"Quotas": []},
        }
        assert command[:2] in responses, f"Unexpected AWS call: {command}"
        return json.dumps(responses[command[:2]])
    monkeypatch.setattr(deployment.Runner, "aws", aws)
    args = ["preflight", "--use-unreserved-concurrency", "--execute"]
    if current is None:
        with pytest.raises(json.JSONDecodeError):
            deployment.main(args)
        return
    assert deployment.main(args) == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["existing_function_reservation"] == current
    assert summary["available_shared_concurrency"] == 10 + current


@pytest.mark.parametrize("denied_operation", ["list-functions", "get-function-concurrency"])
def test_preflight_propagates_function_lookup_permission_errors(monkeypatch, denied_operation):
    calls = []
    denied = deployment.subprocess.CalledProcessError(254, ["aws", "lambda", denied_operation], stderr="AccessDeniedException")
    def aws(self, *command, **kwargs):
        calls.append(command[:2])
        if command[:2] == ("lambda", denied_operation):
            raise denied
        responses = {
            ("sts", "get-caller-identity"): {},
            ("lambda", "get-account-settings"): {"AccountLimit": {"ConcurrentExecutions": 10, "UnreservedConcurrentExecutions": 10}},
            ("lambda", "list-functions"): {"Functions": [{"FunctionName": "turntable-stateless-frames"}]},
        }
        assert command[:2] in responses, f"Unexpected AWS call: {command}"
        return json.dumps(responses[command[:2]])
    monkeypatch.setattr(deployment.Runner, "aws", aws)
    with pytest.raises(deployment.subprocess.CalledProcessError) as error:
        deployment.main(["preflight", "--use-unreserved-concurrency", "--execute"])
    assert error.value is denied
    if denied_operation == "get-function-concurrency":
        assert calls.index(("lambda", "list-functions")) < calls.index(("lambda", "get-function-concurrency"))


@pytest.mark.parametrize("opt_in,mode,unreserved,current", [(False, "reserved", 110, 0), (True, "unreserved", 10, 0), (True, "unreserved", 0, 10)])
@pytest.mark.parametrize("configuration,memory_mb,inference_threads", [([], 3008, 2), (["--memory-mb", "6144", "--inference-threads", "4"], 6144, 4)])
def test_deploy_propagates_concurrency_mode_through_preflight_and_stack(monkeypatch, capsys, opt_in, mode, unreserved, current, configuration, memory_mb, inference_threads):
    deployed = []
    def aws(self, *command, **kwargs):
        responses = {
            ("sts", "get-caller-identity"): {},
            ("lambda", "get-account-settings"): {"AccountLimit": {"ConcurrentExecutions": unreserved + current, "UnreservedConcurrentExecutions": unreserved}},
            ("lambda", "list-functions"): {"Functions": [{"FunctionName": "turntable-stateless-frames"}] if current else []},
            ("lambda", "get-function-concurrency"): {"ReservedConcurrentExecutions": current},
            ("service-quotas", "list-service-quotas"): {"Quotas": []},
        }
        assert command[:2] in responses, f"Unexpected AWS call: {command}"
        return json.dumps(responses[command[:2]])
    monkeypatch.setattr(deployment.Runner, "aws", aws)
    monkeypatch.setattr(deployment.Runner, "deploy_stack", lambda self, stack, template, parameters: deployed.append(parameters))
    monkeypatch.setattr(deployment.Runner, "outputs", lambda self, stack, defaults: defaults)
    uri = f"123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/turntable-stateless-frames@sha256:{'0' * 64}"
    args = ["deploy", "--image-uri", uri, "--build-id", "offline-test", "--execute", *configuration]
    if opt_in:
        args.append("--use-unreserved-concurrency")
    assert deployment.main(args) == 0
    assert deployed == [{"ImageUri": uri, "BuildId": "offline-test", "ConcurrencyMode": mode, "MemorySize": memory_mb, "InferenceThreads": inference_threads}]
    summary = json.loads(capsys.readouterr().out.splitlines()[0])
    assert summary["memory_mb"] == memory_mb
    assert summary["inference_threads"] == inference_threads
    assert summary["memory_quota"] == f"not exposed by quota API; AWS must accept {memory_mb} MB during deployment"


@pytest.mark.parametrize("opt_in,mode", [(False, "reserved"), (True, "unreserved")])
@pytest.mark.parametrize("configuration,memory_mb,inference_threads", [([], 3008, 2), (["--memory-mb", "6144", "--inference-threads", "4"], 6144, 4)])
def test_deploy_dry_run_prints_selected_concurrency_mode_without_subprocesses(monkeypatch, capsys, opt_in, mode, configuration, memory_mb, inference_threads):
    monkeypatch.setattr(deployment.subprocess, "run", lambda *args, **kwargs: pytest.fail("Dry run attempted a subprocess"))
    uri = f"123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/turntable-stateless-frames@sha256:{'0' * 64}"
    args = ["deploy", "--image-uri", uri, "--build-id", "offline-test", "--dry-run", *configuration]
    if opt_in:
        args.append("--use-unreserved-concurrency")
    assert deployment.main(args) == 0
    output = capsys.readouterr().out
    assert f"ConcurrencyMode={mode}" in output
    assert f"MemorySize={memory_mb}" in output
    assert f"InferenceThreads={inference_threads}" in output


@pytest.mark.parametrize("action", ["preflight", "deploy"])
@pytest.mark.parametrize("configuration", [["--memory-mb", "3007"], ["--memory-mb", "10241"], ["--memory-mb", "3008.5"], ["--inference-threads", "0"], ["--inference-threads", "3"], ["--inference-threads", "2.5"]])
def test_cli_rejects_invalid_memory_or_threads_before_aws(monkeypatch, action, configuration):
    monkeypatch.setattr(deployment.Runner, "aws", lambda *args, **kwargs: pytest.fail("Invalid configuration reached AWS"))
    monkeypatch.setattr(deployment.Runner, "deploy_stack", lambda *args, **kwargs: pytest.fail("Invalid configuration reached SAM"))
    monkeypatch.setattr(deployment.subprocess, "run", lambda *args, **kwargs: pytest.fail("Invalid configuration launched a subprocess"))
    with pytest.raises(SystemExit) as error:
        deployment.main([action, "--execute", *configuration])
    assert error.value.code == 2


@pytest.mark.parametrize("application", [False, True])
def test_stack_deployment_uses_sam_with_existing_image_repository(monkeypatch, application):
    commands = []
    runner = deployment.Runner(SimpleNamespace(region="ap-southeast-2", profile="competition", execute=True))
    monkeypatch.setattr(runner, "command", lambda command, **kwargs: commands.append((command, kwargs)))
    repo = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/turntable-stateless-frames"
    parameters = {"ImageUri": f"{repo}@sha256:{'a' * 64}", "BuildId": "competition-001", "ConcurrencyMode": "unreserved", "MemorySize": 3008, "InferenceThreads": 2} if application else {"ApplicationStack": "turntable-stateless"}
    runner.deploy_stack("turntable-stateless", deployment.TEMPLATE if application else deployment.ECR_TEMPLATE, parameters)
    command, kwargs = commands[0]
    assert command[:2] == ["sam", "deploy"]
    assert command[command.index("--region") + 1] == "ap-southeast-2"
    assert command[command.index("--profile") + 1] == "competition"
    assert "--no-resolve-s3" in command and "--resolve-s3" not in command
    assert "--resolve-image-repos" not in command
    assert "--no-confirm-changeset" in command
    assert kwargs["env"]["SAM_CLI_TELEMETRY"] == "0"
    if application:
        assert command[command.index("--image-repository") + 1] == repo
        assert f"ImageUri={parameters['ImageUri']}" in command
        assert "ConcurrencyMode=unreserved" in command
        assert "MemorySize=3008" in command
        assert "InferenceThreads=2" in command
    else:
        assert "--image-repository" not in command


@pytest.mark.parametrize("with_aws", [False, True])
def test_validation_runs_sam_lint_and_optional_aws_validation(monkeypatch, capsys, with_aws):
    calls = []
    monkeypatch.setattr(deployment.Runner, "sam", lambda self, *command: calls.append(("sam", *command)))
    monkeypatch.setattr(deployment.Runner, "aws", lambda self, *command, **kwargs: calls.append(("aws", *command)))
    assert deployment.main(["validate", "--execute", *(["--aws"] if with_aws else [])]) == 0
    assert calls[:2] == [("sam", "validate", "--lint", "--template-file", str(path)) for path in (deployment.ECR_TEMPLATE, deployment.TEMPLATE)]
    assert len(calls) == (4 if with_aws else 2)
    if with_aws:
        assert all(call[:3] == ("aws", "cloudformation", "validate-template") for call in calls[2:])
    summary = json.loads(capsys.readouterr().out)
    assert summary["sam_template_validation"] == "passed"
    assert summary["aws_template_validation"] == ("passed" if with_aws else "not run")


@pytest.mark.parametrize("failure", ["unavailable", "missing_executable", "timeout", "empty_version"])
def test_build_push_stops_before_aws_or_build_when_docker_is_not_ready(monkeypatch, tmp_path, failure):
    calls = []
    def run(command, **kwargs):
        calls.append((command, kwargs))
        assert command == ["docker", "info", "--format", "{{.ServerVersion}}"]
        assert kwargs["timeout"] == 15
        if failure == "unavailable":
            raise deployment.subprocess.CalledProcessError(1, command, stderr="Cannot connect to the Docker daemon")
        if failure == "missing_executable":
            raise FileNotFoundError("docker")
        if failure == "timeout":
            raise deployment.subprocess.TimeoutExpired(command, kwargs["timeout"])
        return deployment.subprocess.CompletedProcess(command, 0, stdout=b" \n")
    monkeypatch.setattr(deployment.subprocess, "run", run)
    release = tmp_path / "release.json"
    with pytest.raises(ValueError) as error:
        deployment.main(["build-push", "--build-id", "offline-test", "--release-out", str(release), "--execute"])
    assert len(calls) == 1
    assert not release.exists()
    assert "Docker" in str(error.value)
    if failure == "timeout":
        assert "15" in str(error.value)


def test_build_push_checks_docker_before_aws_and_streams_plain_build_progress(monkeypatch, tmp_path, capsys):
    calls = []
    repo = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/turntable-stateless-frames"
    digest = f"sha256:{'a' * 64}"
    def run(command, **kwargs):
        calls.append((command, kwargs))
        if command[:2] == ["docker", "info"]:
            stdout = "28.0.0\n"
        elif "describe-stacks" in command:
            stdout = json.dumps({"Stacks": [{"Outputs": [
                {"OutputKey": "RepositoryUri", "OutputValue": repo},
                {"OutputKey": "RepositoryName", "OutputValue": "turntable-stateless-frames"},
            ]}]})
        elif "get-login-password" in command:
            stdout = "test-password"
        elif "describe-images" in command:
            stdout = json.dumps({"imageDetails": [{"imageDigest": digest}]})
        else:
            assert command[:3] == ["docker", "buildx", "build"] or command[:2] in [
                ["docker", "run"], ["docker", "login"], ["docker", "push"],
            ], f"Unexpected command: {command}"
            stdout = ""
        return deployment.subprocess.CompletedProcess(command, 0, stdout=stdout.encode())
    monkeypatch.setattr(deployment.subprocess, "run", run)
    release = tmp_path / "release.json"
    assert deployment.main(["build-push", "--build-id", "offline-test", "--release-out", str(release), "--execute"]) == 0
    assert calls[0][0] == ["docker", "info", "--format", "{{.ServerVersion}}"]
    assert calls[0][1]["timeout"] == 15
    assert "describe-stacks" in calls[1][0]
    build, options = calls[2]
    assert build[:3] == ["docker", "buildx", "build"]
    assert "--progress=plain" in build
    assert options["stdout"] is None
    assert options["timeout"] is None
    assert json.loads(release.read_text())["image_uri"] == f"{repo}@{digest}"
    out = capsys.readouterr().out
    assert "--progress=plain" in out
    assert "test-password" not in out


def test_dry_run_all_commands_never_launch_subprocesses(monkeypatch, capsys):
    def unexpected(*args, **kwargs):
        pytest.fail("Dry run attempted a subprocess")
    monkeypatch.setattr(deployment.subprocess, "run", unexpected)
    digest = "0" * 64
    for action in ("validate", "preflight", "bootstrap", "publish", "outputs", "teardown"):
        assert deployment.main([action, "--dry-run"]) == 0
    assert deployment.main(["build-push", "--build-id", "offline-test", "--dry-run"]) == 0
    assert deployment.main(["deploy", "--image-uri", f"123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/turntable-stateless-frames@sha256:{digest}", "--build-id", "offline-test", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "VITE_PROCESSING_MODE=stateless" in out
    assert "--platform linux/amd64" in out
    assert "--provenance=false" in out
    assert "docker info --format" in out
    assert "--progress=plain" in out
    assert "/frames/capabilities" in out
    assert "/v1/" not in out
    assert "sam deploy" in out and "sam validate --lint" in out
    assert "cloudformation deploy" not in out
    assert all("--delete" not in line for line in out.splitlines() if " s3 sync " in line)


@pytest.mark.parametrize("name", ["recording.mp4", "bundle.json", "weights.onnx", "capture.webm"])
def test_static_publisher_rejects_media_results_and_models(tmp_path, name):
    (tmp_path / "index.html").write_text("<!doctype html>")
    (tmp_path / name).write_bytes(b"not a static site asset")
    with pytest.raises(ValueError, match="Unexpected static artifact"):
        deployment.static_files(tmp_path)


def test_static_publisher_rejects_symlink_escape(tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html>")
    (tmp_path / "app.js").symlink_to(Path(__file__))
    with pytest.raises(ValueError, match="symlinks"):
        deployment.static_files(tmp_path)


def test_publisher_accepts_generated_static_outputs(tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html>")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app-abc.js").write_text("export {}")
    assert len(deployment.static_files(tmp_path)) == 2


def test_load_retries_same_bytes_and_checkpoint_after_429():
    encoded = load.json_bytes({"checkpoint": {"last_index": 8}})
    sent, slept = [], []
    def transport(url, body, timeout, origin):
        sent.append(body)
        return (429, {"Retry-After": "1"}, {"code": "throttled"}) if len(sent) == 1 else (200, {}, {"ok": True})
    result, count, statuses = load.post_with_retry("http://localhost", encoded, timeout=1, retries=1, transport=transport, sleeper=slept.append)
    assert result == {"ok": True} and count == 2
    assert sent[0] is encoded and sent[1] is encoded
    assert statuses == {"429": 1, "200": 1} and slept[0] >= 1


def test_load_does_not_retry_unavailable_model():
    with pytest.raises(load.LoadFailure, match="model_unavailable"):
        load.post_with_retry("http://localhost", b"{}", timeout=1, retries=5, transport=lambda *args: (503, {}, {"code": "model_unavailable", "error": "Model missing"}), sleeper=lambda _: pytest.fail("Must not retry missing model"))


@pytest.mark.parametrize("clients,batches,verify_retry", [(10, 3, True), (100, 1, False)])
def test_isolated_client_chains_and_burst_with_forced_retries_and_fresh_workers(clients, batches, verify_retry):
    from processor.models import MODEL_HASHES
    from service.stateless import StatelessProcessor
    class Detector:
        sha256 = MODEL_HASHES["tiny"]
        last_timing = {}
        def __init__(self, mode):
            pass
        def detect(self, frame):
            return [{"class_id": 0, "score": .95, "box": [.2, .2, .4, .7]}]
    def worker():
        return StatelessProcessor(detector_factory=Detector, availability=lambda: (True, None), build_id="load-test")
    capabilities = worker().capabilities()
    seen, lock = {}, threading.Lock()
    def transport(url, body, timeout, origin):
        assert url == "http://localhost/frames/observe-batch"
        payload = json.loads(body)
        assert "protocol_version" not in payload
        with lock:
            request_id = payload["request_id"]
            seen[request_id] = seen.get(request_id, 0) + 1
            count = seen[request_id]
        if count == 1:
            return 429, {}, {"code": "throttled"}
        # New instance on every invocation: no residency assumptions.
        return 200, {}, worker().process("observe-batch", payload)
    args = SimpleNamespace(url="http://localhost", batches=batches, timeout=5, retries=2, origin=None, verify_retry=verify_retry)
    barrier = threading.Barrier(clients)
    with ThreadPoolExecutor(max_workers=clients) as pool:
        results = list(pool.map(lambda index: load.client_chain(index, load.synthetic_request(), args, capabilities, barrier, transport=transport), range(clients)))
    assert len(results) == clients
    assert all(result["completed_batches"] == batches and result["attempts"] == batches * 2 + int(verify_retry) for result in results)
    assert len(seen) == clients * batches


def test_load_rejects_foreign_checkpoint_before_commit():
    from service.stateless import StatelessProcessor
    class EmptyDetector:
        last_timing = {}
        def __init__(self, mode):
            pass
        def detect(self, frame):
            return []
    processor = StatelessProcessor(detector_factory=EmptyDetector, availability=lambda: (True, None), build_id="test")
    request = load.synthetic_request(processor.capabilities())
    response = processor.process("observe-batch", request)
    response["checkpoint"]["identity"]["run_id"] = "another-client"
    with pytest.raises(load.LoadFailure, match="checkpoint_identity_run_id"):
        load.validate_response(request, response, processor.capabilities())
