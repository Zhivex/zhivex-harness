"""Pin a held-out selection and OCI images before either agent runs."""
import argparse
import base64
import hashlib
import json
import os
import subprocess
import urllib.request
from pathlib import Path
from common import compare_source_entries, DEFAULT_LIMITS, digest, public_task, select_tasks, write_json


def command(args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, timeout=1200, **kwargs).stdout.strip()


def image_info(image):
    return json.loads(command(["docker", "image", "inspect", image]))[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--count", type=int, default=5)
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--seed", type=int, default=20260908)
    parser.add_argument("--provider", choices=["openai", "qwen"], default="openai")
    parser.add_argument("--model")
    parser.add_argument("--revision", default="c104f840cc67f8b6eec6f759ebc8b2693d585d4a")
    parser.add_argument("--exclude-manifest", action="append", default=[], help="Exclude every task in previous development/pilot manifests")
    args = parser.parse_args()
    args.model = args.model or ("qwen3.8-flash" if args.provider == "qwen" else "gpt-5.6-luna")
    if not 1 <= args.count <= 100 or not 1 <= args.repetitions <= 10:
        parser.error("count/repetitions exceed bounded comparison limits")
    root = Path(args.output).resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.environ.setdefault("HF_HOME", str(root / "hf-cache"))
    from datasets import load_dataset
    from swebench.harness.test_spec.test_spec import make_test_spec
    dataset = "princeton-nlp/SWE-bench_Verified"
    exclusions = set()
    exclusion_receipts = []
    for filename in args.exclude_manifest:
        prior = json.loads(Path(filename).read_text())
        exclusions.update(task["instance_id"] for task in prior["tasks"])
        exclusion_receipts.append(digest(prior))
    available = [task for task in load_dataset(dataset, split="test", revision=args.revision) if task["instance_id"] not in exclusions]
    tasks = select_tasks(available, args.count, args.seed)
    write_json(root / "private-tasks.json", tasks)
    manifest = {"schemaVersion": 1, "dataset": dataset, "revision": args.revision,
                "selectedTasksSha256": digest(tasks), "excludedTaskIds": sorted(exclusions), "excludedManifestSha256": exclusion_receipts, "seed": args.seed,
                "repetitions": args.repetitions, "model": args.model,
                "provider": args.provider, "reasoning": "none" if args.provider == "qwen" else "low", "transport": "qwen-chat-completions" if args.provider == "qwen" else "openai-responses", "limits": DEFAULT_LIMITS,
                "versions": {"mini-swe-agent": "2.4.6", "swebench": "4.1.0"},
                "tasks": [public_task(task) for task in tasks],
                "environmentDifferences": ["Zhivex native OCI: read-only root and writable /workspace snapshot, operator auto-approval; mini: writable /testbed. Both deny container network and use the same derived image and CPU/memory limits.",
                                           "Zhivex tool-call limit is steps times eight; mini counts model steps and executes each response's actions. Tool counts are reported, not claimed equivalent.",
                                           "Input/output token ceilings are checked between model requests and can overshoot by one response; outputPerTurn is sent to both APIs."],
                "prepared": False}
    write_json(root / "manifest.json", manifest)
    # Resolve mutable tags once; bind both candidates and grading to inspected image IDs.
    command(["docker", "pull", "--platform", "linux/amd64", "node:22-bullseye-slim"])
    node = image_info("node:22-bullseye-slim")
    manifest["nodeImage"] = node["Id"]
    for task, selected in zip(tasks, manifest["tasks"]):
        print(f"Preparing {task['instance_id']}", flush=True)
        spec = make_test_spec(task, namespace="swebench", arch="x86_64")
        try:
            command(["docker", "pull", "--platform", "linux/amd64", spec.instance_image_key])
            base = image_info(spec.instance_image_key)
            tag = "zhx-" + base["Id"].split(":")[1][:16]
            spec.instance_image_tag = tag
            command(["docker", "tag", base["Id"], spec.instance_image_key])
            selected.update(evalImage=spec.instance_image_key, evalImageId=base["Id"], evalTag=tag)
            context = root / "build" / task["instance_id"]
            context.mkdir(parents=True)
            # Minimal additive runtime layer; no hidden evaluator data enters this image.
            (context / "Dockerfile").write_text(
                f"FROM {node['RepoDigests'][0]} AS node\nFROM {base['RepoDigests'][0]}\n"
                "COPY --from=node /usr/local/bin/node /usr/local/bin/node\n"
                'ENV PATH="/opt/miniconda3/envs/testbed/bin:/opt/miniconda3/bin:${PATH}"\n'
                "ENV PYTHONDONTWRITEBYTECODE=1\n"
                'ENV PYTHONPATH="/workspace:/workspace/src:/testbed:/testbed/src"\n')
            candidate_tag = "zhivex-swebench:" + digest({"base": base["Id"], "node": node["Id"], "pythonPathPolicy": "checkout-first-v1"})[:20]
            command(["docker", "build", "--platform", "linux/amd64", "-t", candidate_tag, str(context)])
            selected["image"] = image_info(candidate_tag)["Id"]
            checkout = command(["docker", "run", "--rm", "--platform", "linux/amd64", "--network", "none",
                                "--entrypoint", "/bin/bash", selected["image"], "-lc",
                                "cd /testbed && git rev-parse HEAD && git rev-parse HEAD^{tree} && git status --porcelain"]).splitlines()
            with urllib.request.urlopen(f"https://api.github.com/repos/{task['repo']}/git/commits/{task['base_commit']}", timeout=30) as response:
                upstream = json.load(response)
            # Official images may squash history. Compare the source tree, not synthetic commit IDs.
            if len(checkout) != 2:
                raise ValueError("Instance image contains initial working-tree changes")
            mode_changes = 0
            if checkout[1] != upstream["tree"]["sha"]:
                with urllib.request.urlopen(f"https://api.github.com/repos/{task['repo']}/git/trees/{task['base_commit']}?recursive=1", timeout=30) as response:
                    expected_tree = json.load(response)
                if expected_tree.get("truncated"):
                    raise ValueError("Upstream tree response truncated")
                expected = {entry["path"]: (entry["mode"], entry["sha"]) for entry in expected_tree["tree"] if entry["type"] != "tree"}
                tree = command(["docker", "run", "--rm", "--platform", "linux/amd64", "--network", "none",
                                "--entrypoint", "/bin/bash", selected["image"], "-lc", "cd /testbed && git ls-tree -rz HEAD"])
                actual = {}
                for entry in tree.split("\0"):
                    if entry:
                        metadata, filename = entry.split("\t", 1)
                        mode, kind, blob = metadata.split(" ")
                        actual[filename] = (mode, blob)
                changed = [name for name in actual.keys() & expected.keys() if actual[name][1] != expected[name][1]]
                if actual.keys() == expected.keys() and changed == ["pyproject.toml"] and actual["pyproject.toml"][0] in ("100644", "100755") and expected["pyproject.toml"][0] == "100644":
                    # Restore the public base-commit configuration changed by image packaging.
                    # Never normalize arbitrary source differences or use gold/test patches.
                    original_blob = expected["pyproject.toml"][1]
                    with urllib.request.urlopen(f"https://api.github.com/repos/{task['repo']}/git/blobs/{original_blob}", timeout=30) as response:
                        blob = json.load(response)
                    if blob["encoding"] != "base64":
                        raise ValueError("Unsupported blob encoding")
                    content = base64.b64decode(blob["content"])
                    if hashlib.sha1(b"blob " + str(len(content)).encode() + b"\0" + content).hexdigest() != original_blob:
                        raise ValueError("Upstream configuration blob differs")
                    selected["sourceRestoration"] = {"path": "pyproject.toml", "imageBlob": actual["pyproject.toml"][1], "upstreamBlob": original_blob, "packagedCandidateImage": selected["image"]}
                    (context / "upstream-pyproject.toml").write_bytes(content)
                    (context / "Dockerfile.restore").write_text(
                        f"FROM {candidate_tag}\nCOPY upstream-pyproject.toml /testbed/pyproject.toml\n"
                        "RUN chmod 644 /testbed/pyproject.toml && cd /testbed && git add pyproject.toml && git -c user.name=Benchmark -c user.email=benchmark@invalid commit -m restore-public-base-config\n")
                    command(["docker", "build", "--platform", "linux/amd64", "-f", str(context / "Dockerfile.restore"), "-t", candidate_tag + "-source", str(context)])
                    selected["image"] = image_info(candidate_tag + "-source")["Id"]
                    checkout = command(["docker", "run", "--rm", "--platform", "linux/amd64", "--network", "none", "--entrypoint", "/bin/bash", selected["image"], "-lc", "cd /testbed && git rev-parse HEAD && git rev-parse HEAD^{tree} && git status --porcelain"]).splitlines()
                    if len(checkout) != 2:
                        raise ValueError("Restored image is dirty")
                    tree = command(["docker", "run", "--rm", "--platform", "linux/amd64", "--network", "none", "--entrypoint", "git", selected["image"], "-C", "/testbed", "ls-tree", "-rz", "HEAD"])
                    actual = {}
                    for entry in tree.split("\0"):
                        if entry:
                            metadata, filename = entry.split("\t", 1)
                            mode, kind, blob = metadata.split(" ")
                            actual[filename] = (mode, blob)
                mode_changes = compare_source_entries(actual, expected)
            selected.update(checkoutHead=checkout[0], baseTree=checkout[1], upstreamTree=upstream["tree"]["sha"],
                            imageModeDifferences=mode_changes)

        except Exception as error:
            selected["preparationFailure"] = type(error).__name__
        write_json(root / "manifest.json", manifest)
    manifest["prepared"] = all("image" in task and "preparationFailure" not in task for task in manifest["tasks"])
    write_json(root / "manifest.json", manifest)
    print(json.dumps({"prepared": manifest["prepared"], "tasks": len(tasks), "manifestSha256": digest(manifest)}))
    return 0 if manifest["prepared"] else 1

if __name__ == "__main__":
    raise SystemExit(main())
