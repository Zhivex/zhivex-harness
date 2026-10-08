"""PTY acceptance of the installed Code tutorial. Python is test tooling only."""
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

installed = pathlib.Path(sys.argv[1])
evidence = pathlib.Path(sys.argv[2])
workspace = pathlib.Path(tempfile.mkdtemp(prefix="code-pty-"))
env = {k: v for k, v in os.environ.items() if k in ("PATH", "LANG", "TMPDIR")}
env.update(TERM="xterm-256color", NO_COLOR="1")
transcript = bytearray()


class Console:
    def __init__(self, target=workspace, columns=110, rows=30):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        self.child = subprocess.Popen(["node", str(installed / "examples/first-use.mjs"), "--workspace", str(target)],
                                      stdin=slave, stdout=slave, stderr=slave, cwd=target, env=env)
        os.close(slave)
        self.pending = b""

    def read(self, marker, timeout=25):
        deadline = time.monotonic() + timeout
        def position():
            if marker == "\n> ":
                match = re.search(rb"\n> (?=\r?\n|\x1b)", self.pending)
                return match.start() if match else -1
            return self.pending.find(marker.encode())
        while position() < 0:
            if time.monotonic() > deadline:
                raise AssertionError((marker, self.pending[-6000:].decode(errors="replace")))
            if select.select([self.master], [], [], .1)[0]:
                try:
                    chunk = os.read(self.master, 65536)
                except OSError:
                    raise AssertionError((marker, self.pending[-6000:].decode(errors="replace")))
                self.pending += chunk
                transcript.extend(chunk)
        end = position() + len(marker.encode())
        result, self.pending = self.pending[:end], self.pending[end:]
        return result.decode(errors="replace")

    def send(self, text):
        os.write(self.master, text.encode())

    def prompt(self):
        return self.read("\n> ")

    def command(self, text):
        self.send(text + "\n")
        marker = ("Captured checkpoint" if text.startswith("/checkpoint capture") else
                  "Current digest:" if text.startswith("/checkpoint review") else
                  "RESTORE BLOCKED" if text.startswith("/checkpoint retry") else {
                    "Inspect fixture": "Offline fixture ready.", "/pricing": "Catalog prices are advisory.",
                    "/pending": "Pending approval:", "/budget off": "Finish or deny",
                    "/approve": "Offline edit task finished.", "/usage": "estimated USD limit:",
                    "/activity": "Activity history", "/continue": "Offline check task finished."
                  }.get(text))
        prefix = self.read(marker) if marker else ""
        return prefix + self.prompt()

    def permission(self, decision):
        frame = self.read("PgUp/PgDn review")
        assert "Reject" in frame and "Allow once" in frame
        self.send(decision + "\r")

    def close(self):
        if self.child.poll() is None:
            self.send("/exit\n")
        deadline = time.monotonic() + 10
        while self.child.poll() is None and time.monotonic() < deadline:
            if select.select([self.master], [], [], .1)[0]:
                try:
                    chunk = os.read(self.master, 65536)
                    transcript.extend(chunk)
                except OSError:
                    break
        try:
            assert self.child.wait(timeout=2) == 0
        finally:
            if self.child.poll() is None:
                self.child.kill()
            os.close(self.master)


console = None
try:
    console = Console()
    console.prompt()
    assert "Offline fixture ready" in console.command("Inspect fixture")
    review = console.command("/review Inspect fixture")
    assert "Running review · 0s · step 0" in review
    assert "[explorer]" in review and "[reviewer]" in review
    capture = console.command('/checkpoint capture ["greeting.mjs"]')
    checkpoint = re.search(r"Captured checkpoint ([a-f0-9-]+)", capture).group(1)
    assert "Price: unknown" in console.command("/pricing") or "Estimated USD" in console.command("/pricing")
    console.send("/budget 1\n")
    console.read("Pricing JSON file")
    console.send("prices.json\n")
    console.read("Type budget")
    console.send("budget\n")
    assert "per new run" in console.prompt()

    console.send("Fix greeting\n")
    diff = console.read("Permission required")
    assert "Waiting for model response · 0s · step 0" in diff
    assert "---" in diff and "+++" in diff and "-export const greeting" in diff and "+export const greeting" in diff
    assert "Hi, ${name}" in (workspace / "greeting.mjs").read_text()
    console.permission("Leave pending")
    assert "paused" in console.prompt()
    assert "waiting_approval" in console.command("/pending") or "Pending approval" in console.command("/pending")
    assert "Finish or deny" in console.command("/budget off")
    console.close()
    console = Console()
    assert "Pending approval" in console.prompt()
    approved = console.command("/approve")
    assert "Hello, ${name}!" in (workspace / "greeting.mjs").read_text()
    usage = console.command("/usage")
    assert "/ 1 limit" in usage and "not an invoice" in usage

    console.send("Check greeting\n")
    console.read("Run check: test")
    console.read("Permission required")
    console.permission("Allow once")
    checked = console.prompt()
    assert "exit 0" in checked and "1 passed, 0 failed" in checked
    checked_usage = console.command("/usage")
    assert "2 calls" in checked_usage and "0.000060 / 1 limit" in checked_usage
    assert "run_check" in console.command("/activity") or "check" in console.command("/activity")
    console.send("Interrupt fixture\n")
    console.read("press Ctrl+C now")
    # An in-flight request has no final usage receipt: never present it as free.
    console.read("Run est. unknown INCOMPLETE")
    console.send("\x03")
    interrupted = console.prompt()
    assert "Progress saved" in interrupted or "Session retained" in interrupted
    interrupted_usage = console.command("/usage")
    assert "INCOMPLETE" in interrupted_usage and "estimated USD unknown / 1 limit" in interrupted_usage
    console.close()
    console = Console()
    console.prompt()
    continued = console.command("/continue")
    assert "new run" in continued and "Offline check task finished" in continued
    continued_usage = console.command("/usage")
    assert "1 calls" in continued_usage and "0.000030 / 1 limit" in continued_usage

    review = console.command("/checkpoint review " + checkpoint)
    assert "Current digest:" in review and "-export const greeting" in review and "+export const greeting" in review
    console.send("/checkpoint restore " + checkpoint + "\n")
    console.read("Type prepare")
    console.send("prepare\n")
    prepared = console.read("Type restore")
    operation = re.search(r"Restore operation ([a-f0-9-]+)", prepared).group(1)
    # External changes after review must reject the restore and its original retry.
    (workspace / "greeting.mjs").write_text("user edit after review\n")
    console.send("restore\n")
    assert "conflicts" in console.prompt()
    retry = console.command("/checkpoint retry " + operation)
    assert "Stale patch" in retry or "conflict" in retry
    assert (workspace / "greeting.mjs").read_text() == "user edit after review\n"
    # A new operator review is required to adopt new contents; the old op remains.
    console.send("/checkpoint restore " + checkpoint + "\n")
    console.read("Type prepare")
    console.send("prepare\n")
    console.read("Type restore")
    console.send("restore\n")
    assert "completed" in console.prompt()
    assert "Hi, ${name}" in (workspace / "greeting.mjs").read_text()
    console.close()

    # Separate clean session: explicit denial changes no files; no price means unknown.
    other = pathlib.Path(tempfile.mkdtemp(prefix="code-deny-"))
    console = Console(other)
    console.prompt()
    console.send("Fix greeting\n")
    console.read("Permission required")
    console.permission("Reject")
    console.prompt()
    assert "Hi, ${name}" in (other / "greeting.mjs").read_text()
    assert "estimated USD unknown" in console.command("/usage")
    console.close()
    # Narrow and ordinary terminal review uses the same installed artifact.
    # Paging, resize and clipboard packets must not submit approval decisions.
    for columns in (44, 80):
        narrow = pathlib.Path(tempfile.mkdtemp(prefix="code-review-width-"))
        console = Console(narrow, columns=columns, rows=24)
        console.prompt()
        console.send("Fix greeting\n")
        frame = console.read("PgUp/PgDn review")
        assert "Reject" in frame and "Allow once" in frame and "Leave pending" in frame
        assert "Model openai/gpt-5.6-luna" in frame and "Context ~" in frame
        assert "estimatedUsd" not in frame  # Diff before technical JSON.
        console.send("\x1b[6~")
        console.read("PgUp/PgDn review")
        console.send("\x1b[200~Allow once\x1b[201~\r")
        # Wait for actual paste processing, not a buffered pager redraw: macOS
        # may otherwise coalesce the fresh answer into the discarded packet.
        console.read("Paste ignored · fresh keys required")
        assert "Hi, ${name}" in (narrow / "greeting.mjs").read_text()
        console.send("Reject\r")
        rejected = console.prompt()
        assert "1 rejected decisions" in rejected and "Conversation: completed" in rejected
        assert "Hi, ${name}" in (narrow / "greeting.mjs").read_text()
        console.close()
        import shutil
        shutil.rmtree(narrow)
    console = None
    import shutil
    shutil.rmtree(other)

    # An insufficient task policy refuses provider dispatch; later budget changes
    # configure future tasks and cannot replenish this task's established account.
    exhausted = pathlib.Path(tempfile.mkdtemp(prefix="code-exhausted-task-"))
    console = Console(exhausted)
    console.prompt()
    (exhausted / ".gitignore").write_text(".zhivex-harness/\n.tutorial*\n")
    for args in (["init"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "baseline"]):
        subprocess.run(["git", *args], cwd=exhausted, env=env, check=True, capture_output=True)
    console.send("/budget 0.000001\n")
    console.read("Pricing JSON file")
    console.send("prices.json\n")
    console.read("Type budget")
    console.send("budget\n")
    console.prompt()
    console.command('/task start {"goal":"Fix greeting","paths":["greeting.mjs"],"checks":["test"],"budget":{"inputTokens":60000,"outputTokens":8192,"totalTokens":68192}}')
    console.send("Fix greeting\n")
    exhausted_result = console.prompt()
    assert "BUDGET" in exhausted_result
    assert not (exhausted / ".tutorial-requests.jsonl").exists()
    policy = console.command("/usage")
    assert "/ 0.000001 limit" in policy
    exhausted_authority = re.search(r"Task budget authority: (\S+)", policy).group(1)
    console.close()
    console = Console(exhausted)
    assert exhausted_authority in console.prompt()
    assert exhausted_authority in console.command("/usage")
    console.send("/budget 1\n")
    console.read("Pricing JSON file")
    console.send("prices.json\n")
    console.read("Type budget")
    console.send("budget\n")
    assert "future tasks" in console.prompt()
    retained_policy = console.command("/usage")
    assert exhausted_authority in retained_policy and "/ 0.000001 limit" in retained_policy
    console.send("/task revise Try again under the retained policy\n")
    console.prompt()
    assert not (exhausted / ".tutorial-requests.jsonl").exists()
    console.close()
    console = None
    shutil.rmtree(exhausted)

    # Guided delivery: actual installed CLI, synthetic model, real Git/edit/check/state.
    guided = pathlib.Path(tempfile.mkdtemp(prefix="code-guided-task-"))
    console = Console(guided)
    console.prompt()
    (guided / ".gitignore").write_text(".zhivex-harness/\n.tutorial*\n")
    for args in (["init"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "baseline"]):
        subprocess.run(["git", *args], cwd=guided, env=env, check=True, capture_output=True)
    console.send("/budget 1\n")
    console.read("Pricing JSON file")
    console.send("prices.json\n")
    console.read("Type budget")
    console.send("budget\n")
    console.prompt()
    draft = console.command('/task start {"goal":"Fix greeting","paths":["greeting.mjs"],"checks":["test"],"constraints":["Keep the named export"],"budget":{"inputTokens":60000,"outputTokens":8192,"totalTokens":68192}}')
    assert "Task draft" in draft and "Baseline inspected" in draft
    console.send("Fix greeting\n")
    console.read("Permission required")
    console.permission("Allow once")
    console.read("Run check: test")
    console.read("Permission required")
    console.permission("Allow once")
    delivered = console.prompt()
    assert "task evidence: pending_review" in delivered and "test: exit 0" in delivered
    review_requests = (guided / ".tutorial-requests.jsonl").read_text()
    reviewed = console.command("/review Inspect this guided task")
    assert "Task: Fix greeting" in reviewed and "test: exit 0" in reviewed
    assert "[explorer]" not in reviewed and "[reviewer]" not in reviewed
    connection = console.command("/connection")
    assert "Connection tests are unavailable during a guided task" in connection
    assert (guided / ".tutorial-requests.jsonl").read_text() == review_requests
    console.send("/task keep\n")
    console.read("Type keep")
    console.send("keep\n")
    console.prompt()
    console.close()
    console = Console(guided)
    reopened = console.prompt()
    assert "Task: Fix greeting" in reopened and "Human decision: kept" in reopened
    assert "Keep the named export" in reopened
    (guided / "greeting.mjs").write_text('export const greeting = () => "external change";\n')
    assert "STALE EVIDENCE" in console.command("/task review")
    assert "stale" in console.command("/task keep")
    console.send("/task revise Check greeting again; preserve the external change\n")
    console.read("Run check: test")
    console.read("Permission required")
    console.permission("Allow once")
    failed_task = console.prompt()
    assert "task evidence: incomplete" in failed_task and "test: exit 1" in failed_task
    assert "Task budget authority:" in console.command("/usage")
    console.send("Interrupt fixture\n")
    console.read("press Ctrl+C now")
    console.send("\x03")
    console.prompt()
    before_restart = console.command("/usage")
    assert "Unknown consumption held:" in before_restart and "blocked by incomplete consumption" in before_restart
    authority = re.search(r"Task budget authority: (\S+)", before_restart).group(1)
    requests = (guided / ".tutorial-requests.jsonl").read_text()
    console.close()
    console = Console(guided)
    reopened = console.prompt()
    assert authority in reopened and "blocked by incomplete consumption" in reopened
    console.send("/continue\n")
    blocked = console.prompt()
    assert "TASK_BUDGET_UNCERTAIN" in blocked
    assert (guided / ".tutorial-requests.jsonl").read_text() == requests
    console.close()
    console = Console(guided)
    restored_block = console.prompt()
    assert authority in restored_block and "blocked by incomplete consumption" in restored_block
    assert authority in console.command("/usage")
    console.close()
    console = None
    shutil.rmtree(guided)
    print("Installed Code PTY journeys passed (offline).")
finally:
    if console:
        try:
            console.close()
        except Exception:
            pass
    evidence.mkdir(parents=True, exist_ok=True)
    plain = re.sub(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|[78])", "", transcript.decode(errors="replace")).replace("\r", "")
    (evidence / "installed-journey-transcript.txt").write_text(plain)
    import shutil
    shutil.rmtree(workspace)
