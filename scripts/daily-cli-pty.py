"""Run one installed CLI task with an explicit, bounded approval policy.

Input is a JSON file; stdout contains metrics and the local terminal text for the
calling evaluator only. The evaluator must not publish terminal/tool payloads.
"""
import json
import os
import pathlib
import pty
import re
import select
import subprocess
import sys
import time

spec = json.loads(pathlib.Path(sys.argv[1]).read_text())
master, slave = pty.openpty()
env = dict(os.environ, NO_COLOR="1", TERM="dumb")
argv = ["node", spec["cli"], "run", "--workspace", spec["workspace"],
        "--state-dir", spec["stateDirectory"],
        "--provider", spec["provider"], "--model", spec["model"],
        "--max-steps", str(spec["limits"]["maxSteps"]),
        "--max-input-tokens", str(spec["limits"]["maxInputTokens"]),
        "--max-output-tokens", str(spec["limits"]["maxOutputTokens"]),
        "--timeout-ms", str(spec["limits"]["timeoutMs"]),
        "--allow-check", "pilot", "--no-project-context", spec["prompt"]]
proc = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
os.close(slave)
data, handled, approvals, denials = b"", 0, 0, 0
started = time.monotonic()
timed_out = False
ansi = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")

def permitted(name, args):
    editable = spec.get("editable", [])
    if name in ("apply_patch", "apply_reviewed_edits"):
        changes = args.get("changes")
        return isinstance(changes, list) and 0 < len(changes) <= 4 and all(
            c.get("path") in editable and isinstance(c.get("content"), str)
            and len(c["content"]) <= 32768 for c in changes)
    if name == "apply_reviewed_replacement":
        return args.get("path") in editable and isinstance(args.get("newText"), str) and len(args["newText"]) <= 32768
    return name == "run_check" and args == {"check": "pilot", "expectedScript": "bun run pilot-check.ts"}

try:
    while True:
        if time.monotonic() - started > spec["limits"]["timeoutMs"] / 1000 + 15:
            timed_out = True
            proc.kill()
            break
        if select.select([master], [], [], 0.1)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            data += chunk
            if len(data) > 2 * 1024 * 1024:
                proc.kill()
                timed_out = True
                break
            clean = ansi.sub("", data.decode(errors="replace")).replace("\r", "")
            prompts = list(re.finditer(r"Approve\? \[y\]es/\[n\]o/\[v\]iew/\[q\]uit \(default: no\) ", clean))
            while len(prompts) > handled:
                end = prompts[handled].start()
                start = clean.rfind("Approval required ", 0, end)
                card = clean[start:end]
                match = re.search(r"\[local-tool\] ([A-Za-z0-9_]+)", card)
                allowed = False
                try:
                    payload = json.JSONDecoder().raw_decode(card[card.index("{"):])[0]
                    allowed = bool(match) and permitted(match.group(1), payload)
                except (ValueError, KeyError, TypeError):
                    pass
                approvals += int(allowed)
                denials += int(not allowed)
                os.write(master, b"y\n" if allowed else b"n\n")
                handled += 1
        elif proc.poll() is not None:
            break
    proc.wait(timeout=10)
finally:
    if proc.poll() is None:
        proc.kill()
        proc.wait()
    os.close(master)

print(json.dumps({"exitCode": proc.returncode, "timedOut": timed_out,
    "elapsedMs": round((time.monotonic() - started) * 1000), "approvals": approvals,
    "denials": denials, "terminal": ansi.sub("", data.decode(errors="replace")).replace("\r", "")}))
