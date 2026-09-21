"""Offline PTY coverage for first-run setup, saved profiles and service console entry."""
import fcntl
import json
import os
import pathlib
import pty
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

repo = pathlib.Path(__file__).resolve().parent.parent
root = pathlib.Path(tempfile.mkdtemp(prefix="zhx-entry-", dir="/tmp"))
env = {k: v for k, v in os.environ.items() if k in ("PATH", "TMPDIR", "LANG")}
env.update(HOME=str(root), ZHIVEX_HARNESS_CONFIG_DIR=str(root / "config"), TERM="xterm-256color", NO_COLOR="1", ZHIVEX_HARNESS_CREDENTIAL_STORE="disabled")
cli = ["node", "--import", str(repo / "tests/fixtures/console-fetch.mjs"), str(repo / "dist/cli.js")]

class Console:
    def __init__(self, args, environment):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        self.child = subprocess.Popen(cli + args, stdin=slave, stdout=slave, stderr=slave, env=environment, cwd=root)
        os.close(slave)
        self.pending = b""
    def read(self, marker):
        deadline = time.monotonic() + 15
        while marker.encode() not in self.pending:
            if time.monotonic() > deadline: raise AssertionError((marker, self.pending[-2000:]))
            if select.select([self.master], [], [], .1)[0]:
                try: chunk = os.read(self.master, 65536)
                except OSError: raise AssertionError((marker, self.pending[-2000:]))
                self.pending += chunk
        end = self.pending.index(marker.encode()) + len(marker.encode())
        result, self.pending = self.pending[:end], self.pending[end:]
        return result
    def send(self, value): os.write(self.master, value.encode())
    def wait_exit(self):
        deadline = time.monotonic() + 10
        while self.child.poll() is None and time.monotonic() < deadline:
            if select.select([self.master], [], [], .1)[0]:
                try: self.pending += os.read(self.master, 65536)
                except OSError: break
        try: return self.child.wait(timeout=1)
        except subprocess.TimeoutExpired: raise AssertionError(self.pending[-4000:])
    def close(self):
        if self.child.poll() is None: self.child.terminate()
        self.child.wait(timeout=10)
        os.close(self.master)

host = None
try:
    setup = Console([], dict(env, CONSOLE_FIXTURE_REQUESTS=str(root / "setup-requests.jsonl"), CONSOLE_EXPECT_API_KEY="replacement-fixture"))
    try:
        assert b"Welcome" in setup.read("Provider (")
        setup.send("openai\n")
        setup.read("Model [")
        setup.send("\n")
        setup.read("Credentials / openai")
        setup.read("Filter > ")
        setup.send("\x1b[B\r")
        setup.read("API key (hidden")
        setup.send("opaque-setup-fixture\r")
        hidden_output = setup.read("\n> ")
        assert b"opaque-setup-fixture" not in hidden_output
        setup.send("/credentials\n")
        setup.read("Credentials / Provider")
        setup.read("Filter > ")
        setup.send("openai\r")
        setup.read("Credentials / openai")
        setup.read("Filter > ")
        setup.send("\x1b[B\r")
        setup.read("API key (hidden")
        setup.send("replacement-fixture\r")
        assert b"replacement-fixture" not in setup.read("\n> ")
        setup.send("inspect the fixture\n")
        setup.read("Fixture done")
        setup.read("\n> ")
        requests = (root / "setup-requests.jsonl").read_text()
        assert "replacement-fixture" not in requests and "opaque-setup-fixture" not in requests
        setup.send("/exit\n")
        assert setup.wait_exit() == 0
        saved = json.loads((root / "config/profiles/default.json").read_text())
        assert set(saved) == {"schemaVersion", "provider", "model"}
        assert saved["provider"] == "openai"
    finally: setup.close()
    fixture_env = dict(env, OPENAI_API_KEY="fixture-only", OPENAI_BASE_URL="https://api.openai.com/v1", CONSOLE_FIXTURE_REQUESTS=str(root / "requests.jsonl"))
    denied = Console([], fixture_env)
    try:
        denied.read("Use default profile openai/" + saved["model"] + "? [y/N]: ")
        denied.send("n\n")
        denied.read("Default profile was not selected")
        assert denied.wait_exit() == 0
        assert not (root / "requests.jsonl").exists()
    finally: denied.close()
    direct = Console([], fixture_env)
    try:
        direct.read("Use default profile openai/" + saved["model"] + "? [y/N]: ")
        # Change the private file while the actual CLI is waiting for confirmation.
        profile_path = root / "config/profiles/default.json"
        profile_path.write_text(json.dumps(dict(saved, provider="qwen", model="qwen3.8-max")))
        direct.send("yes\n")
        assert b"Welcome" in direct.read("\n> ")
        direct.send("/conversation\t\n")
        # Selection opens the conversation picker without submitting a provider request.
        direct.read("Filter > ")
        direct.send("\r")
        direct.read("Resumed session")
        direct.read("\n> ")
        assert not (root / "requests.jsonl").exists()
        direct.send("? ")
        direct.read("Keyboard shortcuts")
        direct.send("\x03")
        direct.read("Input interrupted")
        direct.read("\n> ")
        direct.send("history needle\n")
        direct.read("Fixture done")
        compact_output = direct.read("\n> ")
        assert b"model stream" not in compact_output
        recorded = (root / "requests.jsonl").read_text().splitlines()
        assert all(json.loads(request)["model"] == saved["model"] for request in recorded)
        profile_path.write_text(json.dumps(saved))
        count = len(recorded)
        direct.send("\x12needle\n")
        direct.read("history needle")
        time.sleep(.1)
        assert len((root / "requests.jsonl").read_text().splitlines()) == count
        direct.send("\n")
        direct.read("Fixture done")
        direct.read("\n> ")
        direct.send("/menu\n")
        direct.read("Zhivex / Menu")
        direct.read("Filter > ")
        direct.send("\r")
        direct.read("Zhivex / Providers")
        direct.read("Filter > ")
        direct.send("openai\r")
        direct.read("OpenAI / Models")
        direct.read("Filter > ")
        direct.send("\x1b")
        direct.read("Zhivex / Providers")
        direct.read("Filter > ")
        direct.send("\x1b")
        direct.read("Zhivex / Menu")
        direct.read("Filter > ")
        direct.send("\x1b")
        direct.read("\n> ")
        direct.send("/provider\n")
        direct.read("Filter > ")
        direct.send("openai\r")
        direct.read("OpenAI / Models")
        direct.read("Filter > ")
        direct.send("\r")
        direct.read("Next turn: openai/")
        direct.read("\n> ")
        direct.send("/model\n")
        direct.read("OpenAI / Models")
        direct.read("Filter > ")
        direct.send("\x1b")
        direct.read("\n> ")
        direct.send("/verbose\n")
        direct.read("Activity detail: full")
        direct.read("\n> ")
        direct.send("show full activity\n")
        direct.read("model stream")
        direct.read("\n> ")
        direct.send("/exit\n")
        assert direct.wait_exit() == 0
    finally: direct.close()
    # JSON in a TTY must stay machine-readable and must not open a console.
    machine = Console(["--json"], fixture_env)
    try:
        output = machine.read("CLI_USAGE_INVALID")
        assert b"Welcome" not in output
        assert machine.wait_exit() == 2
    finally: machine.close()
    host = subprocess.Popen(["node", "--import", str(repo / "tests/fixtures/console-fetch.mjs"), str(repo / "dist/service-cli.js"), "--workspace", str(root), "--directory", str(root / "socket")], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=fixture_env)
    line = host.stdout.readline()
    if not line: raise AssertionError(host.stderr.read().decode())
    ready = json.loads(line)
    service = Console(["--service", ready["credentialsPath"]], fixture_env)
    try:
        assert b"managed by host" in service.read("\n> ")
        service.send("/help\n")
        help_text = service.read("Provider, model and tool policy")
        service.read("\n> ")
        assert b"/pending" in help_text and b"/model" not in help_text and b"/paste" not in help_text
        service.send("/help all\n")
        full_help = service.read("Provider, model and tool policy")
        service.read("\n> ")
        assert b"/paste" in full_help and b"/model" not in full_help
        service.send("/resume\n")
        service.read("Filter > ")
        service.send("\x1b")
        service.read("\n> ")
        service.send("hello\n")
        service.read("Fixture done")
        service.read("\n> ")
        service.send("\x03")
        service.read("\n> ")
        service.send("/exit\n")
        assert service.wait_exit() == 0
    finally: service.close()
    print("Console entry smoke passed: onboarding, saved profile, command search, JSON TTY, service startup, choosers, prompt history, activity detail and Ctrl+C.")
finally:
    if host:
        host.terminate()
        host.wait(timeout=10)
    shutil.rmtree(root)
