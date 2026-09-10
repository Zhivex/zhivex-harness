"""Sequential, immutable matched runs; only the official evaluator decides correctness."""
import argparse
import importlib.metadata
import json
import os
import platform
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from candidate import candidate_patch
from common import CANDIDATES, digest, public_task, summarize, write_json

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent


def git(workspace, *args):
    return subprocess.run(["git", "-c", "core.fsmonitor=false", "-C", str(workspace), *args],
                          check=True, capture_output=True, text=True, timeout=60).stdout


def extract(client, image, workspace):
    container = client.containers.create(image, command=["true"], entrypoint="/bin/true", network_disabled=True)
    try:
        subprocess.run(["docker", "cp", container.id + ":/testbed/.", str(workspace)],
                       check=True, capture_output=True, timeout=180)
    finally:
        container.remove(force=True)


class BenchmarkCancelled(BaseException):
    pass


def cancel_benchmark(_signum, _frame):
    raise BenchmarkCancelled()


def call_driver(candidate, request, root):
    argv = [os.environ.get("BUN_EXECUTABLE", "bun"), "--no-env-file", "run", str(HERE / "zhivex-driver.ts")] if candidate == "zhivex" else [sys.executable, str(HERE / "mini_driver.py")]
    allowed = ["PATH", "OPENAI_API_KEY", "OPENAI_BASE_URL", "DASHSCOPE_API_KEY", "QWEN_API_KEY", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]
    env = {key: os.environ[key] for key in allowed if key in os.environ}
    env.update(MSWEA_GLOBAL_CONFIG_DIR=str(root / "mini-config"), MSWEA_SILENT_STARTUP="1",
               MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT="1", LITELLM_LOG="ERROR")
    process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, cwd=REPO, env=env, start_new_session=True)
    try:
        stdout, _stderr = process.communicate(json.dumps(request), timeout=request["limits"]["timeoutSeconds"] + 90)
        if process.returncode != 0 or len(stdout) > 8 * 1024 * 1024:
            raise RuntimeError("Driver process failed")
        result = json.loads(stdout)
        if result.get("candidate") != candidate or result.get("instanceId") != request["instanceId"]:
            raise ValueError("Driver identity mismatch")
        return result
    except (subprocess.TimeoutExpired, KeyboardInterrupt, BenchmarkCancelled):
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.communicate(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
        raise
    finally:
        # Clean only resources belonging to this exact driver process. No global prune.
        import docker
        client = docker.from_env()
        label = (f"com.zhivex.harness.run={digest(('swebench-' + request['runToken']).encode())[:24]}"
                 if candidate == "zhivex" else f"com.zhivex.benchmark.run={request['runToken']}")
        for container in client.containers.list(all=True, filters={"label": label}):
            container.remove(force=True)
        if candidate == "zhivex":
            for volume in client.volumes.list(filters={"label": label}):
                volume.remove()



def grade(task, selected, candidate, patch, client, run_id, timeout):
    if not patch.strip():
        return {"gradingStatus": "completed", "resolved": False, "gradingMethod": "empty-patch-no-solution"}
    from swebench.harness.test_spec.test_spec import make_test_spec
    from swebench.harness.run_evaluation import run_instance
    spec = make_test_spec(task, namespace="swebench", arch="x86_64", instance_image_tag=selected["evalTag"])
    if client.images.get(spec.instance_image_key).id != selected["evalImageId"]:
        raise ValueError("Evaluator image changed")
    prediction = {"instance_id": task["instance_id"], "model_name_or_path": candidate, "model_patch": patch}
    # Fresh evaluator container, with no model keys, model process, or host workspace mounted.
    outcome = run_instance(spec, prediction, False, False, client, run_id, timeout=timeout)
    if not isinstance(outcome, dict) or not outcome.get("completed") or not isinstance(outcome.get("resolved"), bool):
        return {"gradingStatus": "failed", "resolved": False}
    return {"gradingStatus": "completed", "resolved": outcome["resolved"]}


def changed_paths(patch):
    result = subprocess.run(["git", "apply", "--numstat", "-z"], input=patch,
                            capture_output=True, text=True, timeout=30, check=True)
    paths = []
    for entry in result.stdout.split("\0"):
        if entry:
            fields = entry.split("\t", 2)
            if len(fields) != 3 or not fields[2]:
                raise ValueError("Unsupported patch path encoding")
            paths.append(fields[2])
    return paths


def protected_path(filename):
    parts = Path(filename).parts
    base = parts[-1].lower() if parts else ""
    return any(part.lower() in ("test", "tests", "testing") for part in parts) or base.startswith("test_") or base in (
        "pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "pytest.ini", "conftest.py")


def cost(row, prices):
    if prices is None or not row.get("usageComplete"):
        return None
    return ((row["inputTokens"] - row["cachedInputTokens"]) * prices[0] +
            row["cachedInputTokens"] * prices[1] + row["outputTokens"] * prices[2]) / 1_000_000


def main():
    signal.signal(signal.SIGINT, cancel_benchmark)
    signal.signal(signal.SIGTERM, cancel_benchmark)
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepared", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--max-runs", type=int, default=10)
    parser.add_argument("--prices", nargs=3, type=float, metavar=("INPUT", "CACHED_INPUT", "OUTPUT"))
    args = parser.parse_args()
    if not args.live:
        parser.error("--live is required: this command makes bounded paid model calls")
    if args.prices and any(not __import__('math').isfinite(price) or price < 0 for price in args.prices):
        parser.error("Prices must be finite, non-negative USD per million tokens")
    prepared = Path(args.prepared).resolve()
    manifest = json.loads((prepared / "manifest.json").read_text())
    provider = manifest.get("provider", "openai")
    if provider not in ("openai", "qwen"):
        raise ValueError("Unsupported benchmark provider")
    if not (os.environ.get("OPENAI_API_KEY") if provider == "openai" else os.environ.get("DASHSCOPE_API_KEY") or os.environ.get("QWEN_API_KEY")):
        raise ValueError("Selected provider credential is missing")
    if provider == "qwen" and any(os.environ.get(k) for k in ["QWEN_BASE_URL", "QWEN_REGION", "QWEN_WORKSPACE_ID"]):
        raise ValueError("Qwen benchmark currently requires the default international endpoint")
    tasks = json.loads((prepared / "private-tasks.json").read_text())
    if not manifest.get("prepared") or digest(tasks) != manifest["selectedTasksSha256"]:
        raise ValueError("Preparation is incomplete or dataset digest differs")
    if [public_task(task) for task in tasks] != [{key: task[key] for key in ("instance_id", "repo", "base_commit", "problem_statement")} for task in manifest["tasks"]]:
        raise ValueError("Public task selection differs from pinned dataset")
    if len(tasks) * manifest["repetitions"] * 2 > args.max_runs or args.max_runs < 1:
        raise ValueError("Planned matrix exceeds --max-runs")
    preflight = json.loads((prepared / "preflight.json").read_text())
    if preflight.get("manifestSha256") != digest(manifest) or preflight.get("driverSha256") != digest((HERE / "zhivex-driver.ts").read_bytes()):
        raise ValueError("Preflight is missing or stale")
    if [row["instanceId"] for row in preflight["results"]] != [task["instance_id"] for task in tasks] or any(row["status"] != "preflight-passed" or row["modelCalls"] != 0 for row in preflight["results"]):
        raise ValueError("Native preflight did not pass for the complete matrix")
    for package, version in manifest["versions"].items():
        if importlib.metadata.version(package) != version:
            raise ValueError("Benchmark dependency version mismatch")
    import docker
    client = docker.from_env(timeout=300)
    for selected in manifest["tasks"]:
        for name, expected in [(selected["image"], selected["image"]), (selected["evalImage"], selected["evalImageId"])]:
            if client.images.get(name).id != expected:
                raise ValueError("Pinned image is unavailable")
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=False, mode=0o700)
    os.environ["MSWEA_GLOBAL_CONFIG_DIR"] = str(root / "mini-config")
    os.environ["MSWEA_SILENT_STARTUP"] = "1"
    sources = sorted([*REPO.glob("src/**/*.ts"), *HERE.glob("*.py"), *HERE.glob("*.ts"),
                      REPO / "scripts/benchmark-swebench.ts", REPO / "scripts/time-to-safe-fix-efficiency.ts",
                      REPO / "package.json", REPO / "bun.lock", REPO / "evaluations/external/requirements.lock"])
    manifest["implementation"] = {"gitCommit": git(REPO, "rev-parse", "HEAD").strip(),
                                  "sources": {str(file.relative_to(REPO)): digest(file.read_bytes()) for file in sources}}
    for file in sources:
        content = file.read_bytes()
        relative = str(file.relative_to(REPO))
        if digest(content) != manifest["implementation"]["sources"][relative]:
            raise ValueError("Source changed while freezing comparison")
        target = root / "source-snapshot" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    manifest["host"] = {"system": platform.system(), "architecture": platform.machine(),
                        "python": platform.python_version(), "docker": client.version()["Version"]}
    manifest["pricingUsdPerMillion"] = args.prices
    manifest["approvalPolicy"] = "Automated operator approves supported isolated Zhivex tools; successful approved verification and patch import is a terminal receipt. Human wait is zero. Not a human-UX comparison."
    write_json(root / "manifest.json", manifest)
    samples = []
    previous_cwd = Path.cwd()
    os.chdir(root)  # Official grading logs stay inside this immutable run directory.
    try:
        for index, (task, selected) in enumerate(zip(tasks, manifest["tasks"])):
            for repetition in range(manifest["repetitions"]):
                order = CANDIDATES if (index + repetition) % 2 == 0 else tuple(reversed(CANDIDATES))
                for candidate in order:
                    if any(digest(file.read_bytes()) != manifest["implementation"]["sources"][str(file.relative_to(REPO))] for file in sources):
                        raise ValueError("Source changed during comparison; remaining samples stay missing")
                    print(f"Running {candidate}: {task['instance_id']} repetition {repetition + 1}", flush=True)
                    started = time.monotonic()
                    run_id = "zhx-" + uuid.uuid4().hex[:20]
                    row = {"candidate": candidate, "instanceId": task["instance_id"], "repetition": repetition,
                           "resolved": False, "gradingStatus": "not-run", "usageComplete": False, "costUsd": None}
                    try:
                        with tempfile.TemporaryDirectory(prefix="zhivex-swebench-workspace-") as tmp:
                            workspace = Path(tmp)
                            if candidate == "zhivex":
                                extract(client, selected["image"], workspace)
                                if git(workspace, "rev-parse", "HEAD").strip() != selected["checkoutHead"] or git(workspace, "rev-parse", "HEAD^{tree}").strip() != selected["baseTree"]:
                                    raise ValueError("Workspace base commit differs")
                            request = {"schemaVersion": 1, "runToken": uuid.uuid4().hex, "workspace": str(workspace), "instanceId": task["instance_id"],
                                       "problem": task["problem_statement"], "model": manifest["model"], "provider": manifest.get("provider", "openai"),
                                       "image": selected["image"], "limits": manifest["limits"]}
                            result = call_driver(candidate, request, root)
                            if candidate == "zhivex":
                                git(workspace, "add", "-N", "--", ".")
                                patch = git(workspace, "diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD")
                            else:
                                patch = result.pop("patch")
                            snapshot = result.pop("candidateSnapshot", None)
                            diagnostic_patch = patch if candidate != "zhivex" else None
                            try:
                                if candidate == "zhivex" and snapshot is not None:
                                    diagnostic_patch = candidate_patch(workspace, snapshot)
                            except Exception as error:
                                row["candidateExportFailure"] = type(error).__name__
                            row.update(result)
                            prediction = {"instance_id": task["instance_id"], "model_name_or_path": candidate, "model_patch": patch}
                            write_json(root / "predictions" / f"{run_id}.json", [prediction])
                            row["patchSha256"] = digest(patch.encode())
                            row["protectedFilesChanged"] = sorted(filename for filename in changed_paths(patch) if protected_path(filename)) if patch.strip() else []
                            row["costUsd"] = cost(row, args.prices)
                            grading_started = time.monotonic()
                            row.update(grade(task, selected, candidate, patch, client, run_id, 300))
                            row["officialResolved"] = row["resolved"]
                            row["resolved"] = row["resolved"] and not row["protectedFilesChanged"]
                            row["candidateCaptured"] = diagnostic_patch is not None
                            if diagnostic_patch is not None:
                                candidate_prediction = {"instance_id": task["instance_id"], "model_name_or_path": candidate + "-candidate", "model_patch": diagnostic_patch}
                                write_json(root / "candidate-predictions" / f"{run_id}.json", [candidate_prediction])
                                row["candidatePatchSha256"] = digest(diagnostic_patch.encode())
                                if diagnostic_patch == patch:
                                    diagnostic_grade = {"resolved": row["resolved"], "gradingStatus": row["gradingStatus"]}
                                else:
                                    try:
                                        diagnostic_grade = grade(task, selected, candidate + "-candidate", diagnostic_patch, client, run_id + "-candidate", 300)
                                    except Exception:
                                        diagnostic_grade = {"resolved": False, "gradingStatus": "failed"}
                                row["candidateGradingStatus"] = diagnostic_grade["gradingStatus"]
                                row["candidateResolved"] = diagnostic_grade["resolved"] and not any(protected_path(p) for p in changed_paths(diagnostic_patch)) if diagnostic_patch.strip() else False
                            row["repairStages"] = {"candidatePresent": bool(diagnostic_patch and diagnostic_patch.strip()), "importedPatchPresent": bool(patch.strip()) if candidate == "zhivex" else None,
                                "verificationAttempted": any(t.get("name", "").startswith("verify_and_apply") for turn in row.get("turns", []) for t in turn.get("tools", [])) or any(name.startswith("verify_and_apply") for turn in row.get("turns", []) for name in turn.get("requestedTools", [])) if candidate == "zhivex" else None}
                            row["resolved"] = row["resolved"] and not row["protectedFilesChanged"]
                            row["gradingDurationMs"] = (time.monotonic() - grading_started) * 1000
                    except Exception as error:
                        row["runnerFailure"] = type(error).__name__
                    row["totalDurationMs"] = (time.monotonic() - started) * 1000
                    samples.append(row)
                    write_json(root / "samples.json", samples)
                    write_json(root / "report.json", summarize(manifest, samples))
                    print(json.dumps({key: row.get(key) for key in ["candidate", "instanceId", "resolved", "gradingStatus", "failure", "runnerFailure"]}), flush=True)
    finally:
        os.chdir(previous_cwd)
        write_json(root / "report.json", summarize(manifest, samples))
    report = summarize(manifest, samples)
    print(json.dumps(report))
    return 0 if report["complete"] and all(group["gradingFailures"] == 0 for group in report["candidates"].values()) else 1

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BenchmarkCancelled:
        print("Benchmark cancelled; completed samples preserved.", flush=True)
        raise SystemExit(130)
