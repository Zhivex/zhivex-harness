"""Dependency-free contracts for the external comparison (not a public Harness API)."""
import hashlib
import json
import math
import random
from pathlib import Path

CANDIDATES = ("zhivex", "mini-swe-agent")
DEFAULT_LIMITS = {"steps": 24, "outputPerTurn": 2048, "inputTokens": 100000,
                  "outputTokens": 16000, "timeoutSeconds": 300, "memoryMb": 2048, "cpus": 2}


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else json.dumps(value, sort_keys=True).encode()).hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps(value, indent=2) + "\n")
    path.chmod(0o600)


def select_tasks(tasks, count, seed):
    ordered = sorted(tasks, key=lambda task: task["instance_id"])
    ids = [task["instance_id"] for task in ordered]
    if len(set(ids)) != len(ids) or not 1 <= count <= len(ids):
        raise ValueError("Invalid task selection")
    random.Random(seed).shuffle(ordered)
    return ordered[:count]


def public_task(task):
    # Never pass gold patches, test patches, hidden test names, or hints to agents.
    return {key: task[key] for key in ("instance_id", "repo", "base_commit", "problem_statement")}


def summarize(manifest, samples):
    if not manifest["tasks"] or manifest["repetitions"] < 1 or len({task["instance_id"] for task in manifest["tasks"]}) != len(manifest["tasks"]):
        raise ValueError("Invalid comparison matrix")
    expected = {(task["instance_id"], candidate, repetition)
                for task in manifest["tasks"] for candidate in CANDIDATES
                for repetition in range(manifest["repetitions"])}
    indexed = {}
    for row in samples:
        key = (row["instanceId"], row["candidate"], row["repetition"])
        if key not in expected or key in indexed:
            raise ValueError("Duplicate or unexpected comparison sample")
        if not isinstance(row.get("resolved"), bool) or row.get("gradingStatus") not in ("completed", "failed", "not-run"):
            raise ValueError("Invalid grading outcome")
        duration = row.get("totalDurationMs")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration < 0:
            raise ValueError("Invalid duration")
        indexed[key] = row
    groups = {}
    for candidate in CANDIDATES:
        rows = [indexed.get(key) for key in sorted(expected) if key[1] == candidate]
        present = [row for row in rows if row is not None]
        resolved = sum(row.get("resolved") is True for row in present)
        costs = [row.get("costUsd") for row in present]
        complete_cost = len(present) == len(rows) and all(
            isinstance(cost, (int, float)) and math.isfinite(cost) and cost >= 0 for cost in costs)
        durations = sorted(row["totalDurationMs"] for row in present if row.get("resolved") is True)
        groups[candidate] = {"planned": len(rows), "recorded": len(present), "resolved": resolved,
                             "candidateCaptured": sum(row.get("candidateCaptured") is True for row in present),
                             "candidateResolved": sum(row.get("candidateResolved") is True for row in present),
                             "candidateGraded": sum(row.get("candidateGradingStatus") == "completed" for row in present),
                             "resolutionRate": resolved / len(rows),
                             "missing": len(rows) - len(present),
                             "gradingFailures": sum(row.get("gradingStatus") != "completed" for row in present),
                             "usageComplete": len(present) == len(rows) and all(row.get("usageComplete") is True for row in present),
                             "totalCostUsd": sum(costs) if complete_cost else None,
                             "costPerResolvedUsd": sum(costs) / resolved if complete_cost and resolved else None,
                             "resolvedP50Ms": durations[max(0, math.ceil(len(durations) * .5) - 1)] if durations else None}
    # Each task is the independent unit; repetitions are first averaged within it.
    differences = []
    for task in manifest["tasks"]:
        rates = {candidate: sum(indexed.get((task["instance_id"], candidate, rep), {}).get("resolved") is True
                                 for rep in range(manifest["repetitions"])) / manifest["repetitions"]
                 for candidate in CANDIDATES}
        differences.append(rates["zhivex"] - rates["mini-swe-agent"])
    interval = None
    if len(differences) >= 2 and len(indexed) == len(expected):
        rng = random.Random(manifest["seed"])
        draws = sorted(sum(rng.choices(differences, k=len(differences))) / len(differences) for _ in range(2000))
        interval = [draws[49], draws[1949]]
    return {"schemaVersion": 1, "kind": "swebench-comparison", "manifestSha256": digest(manifest),
            "complete": len(indexed) == len(expected), "candidates": groups,
            "pairedTaskResolutionDifference": sum(differences) / len(differences),
            "pairedTaskBootstrap95": interval,
            "evidenceBoundary": "Local matched-model comparison. Missing and failed runs remain in the denominator. Small-sample intervals are exploratory. No safety superiority is inferred from SWE-bench correctness."}


def compare_source_entries(actual, expected):
    if actual.keys() != expected.keys():
        raise ValueError("Source paths differ")
    changes = 0
    for name, (mode, blob) in actual.items():
        expected_mode, expected_blob = expected[name]
        if blob != expected_blob or (mode != expected_mode and {mode, expected_mode} != {"100644", "100755"}):
            raise ValueError("Source content or file type differs")
        changes += mode != expected_mode
    return changes
