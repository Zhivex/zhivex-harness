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
    def __init__(self, target=workspace):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 110, 0, 0))
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
                  "Session retained" if text.startswith("/checkpoint retry") else {
                    "Inspect fixture": "Offline fixture ready.", "/pricing": "Catalog prices are advisory.",
                    "/pending": "Pending approval:", "/budget off": "Finish or deny",
                    "/approve": "Offline edit task finished.", "/usage": "Next run estimated USD limit:",
                    "/activity": "Activity history", "/continue": "Offline check task finished."
                  }.get(text))
        prefix = self.read(marker) if marker else ""
        return prefix + self.prompt()

    def permission(self, decision):
        frame = self.read("↑↓ navigate")
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
    assert "run_check" in console.command("/activity") or "check" in console.command("/activity")
    console.send("Interrupt fixture\n")
    console.read("press Ctrl+C now")
    console.send("\x03")
    interrupted = console.prompt()
    assert "Progress saved" in interrupted or "Session retained" in interrupted
    console.close()
    console = Console()
    console.prompt()
    continued = console.command("/continue")
    assert "new run" in continued and "Offline check task finished" in continued

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
    console = None
    import shutil
    shutil.rmtree(other)
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
