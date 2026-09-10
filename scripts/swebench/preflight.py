"""Exercise native Zhivex snapshots and Python before any paid comparison."""
import argparse
import json
import os
import subprocess
import tempfile
import uuid
from pathlib import Path
from common import digest, write_json
from run import extract, HERE, REPO

parser = argparse.ArgumentParser()
parser.add_argument("--prepared", required=True)
args = parser.parse_args()
root = Path(args.prepared).resolve()
manifest = json.loads((root / "manifest.json").read_text())
if not manifest["prepared"]:
    raise ValueError("Preparation incomplete")
import docker
client = docker.from_env(timeout=300)
driver_digest = digest((HERE / "zhivex-driver.ts").read_bytes())
results = []
for task in manifest["tasks"]:
    with tempfile.TemporaryDirectory(prefix="zhx-swe-preflight-") as tmp:
        extract(client, task["image"], Path(tmp))
        request = {"schemaVersion": 1, "runToken": uuid.uuid4().hex, "workspace": tmp,
                   "instanceId": task["instance_id"], "problem": task["problem_statement"],
                   "image": task["image"], "model": manifest["model"], "provider": manifest.get("provider", "openai"), "limits": manifest["limits"]}
        env = {key: os.environ[key] for key in ("PATH", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG") if key in os.environ}
        env["OPENAI_API_KEY"] = "preflight-does-not-call-provider"
        env["DASHSCOPE_API_KEY"] = "preflight-does-not-call-provider"
        result = subprocess.run([os.environ.get("BUN_EXECUTABLE", "bun"), "--no-env-file", "run",
                                 str(HERE / "zhivex-driver.ts"), "--preflight"],
                                input=json.dumps(request), capture_output=True, text=True,
                                cwd=REPO, env=env, timeout=180, check=True)
        row = json.loads(result.stdout)
        results.append(row)
        print(json.dumps({"instanceId": row["instanceId"], "status": row["status"], "failure": row["failure"]}), flush=True)
if driver_digest != digest((HERE / "zhivex-driver.ts").read_bytes()):
    raise ValueError("Driver changed during preflight")
write_json(root / "preflight.json", {"manifestSha256": digest(manifest), "driverSha256": driver_digest, "results": results})
raise SystemExit(0 if all(row["status"] == "preflight-passed" for row in results) else 1)
