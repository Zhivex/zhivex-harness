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
    def read_selection(self):
        self.read("Filter > ")
        # The initial options must arrive after the prompt, before another key.
        frame = self.read("↑↓ navigate")
        assert b"> " in frame and b"\x1b[0J" not in frame, frame
        return frame
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
        intro = setup.read("Zhivex / Providers")
        assert b"First-time setup" in intro and b"Welcome" not in intro
        setup.read_selection()
        # A typo stays in the selector and can be corrected in place.
        setup.send("openaix")
        setup.read("No matches")
        setup.send("\x7f\r")
        setup.read("OpenAI / Models")
        setup.read_selection()
        setup.send("\r")
        setup.read("Credentials / openai")
        setup.read_selection()
        setup.send("\r")
        setup.read("Credentials / Recovery")
        setup.read_selection()
        setup.send("\r")
        setup.read("API key (hidden")
        setup.send("opaque-setup-fixture\r")
        hidden_output = setup.read("\n> ")
        assert b"opaque-setup-fixture" not in hidden_output
        assert hidden_output.count(b"Welcome") == 1
        assert b"Ready" in hidden_output and b"credential: temporary" in hidden_output
        assert b"Changes require your approval" in hidden_output
        assert b"Open zhx" not in hidden_output
        setup.send("/credentials\n")
        setup.read("Credentials / Provider")
        setup.read_selection()
        setup.send("openai\r")
        setup.read("Credentials / openai")
        setup.read_selection()
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
    # A lone environment credential selects its own provider, without touching keys.
    detected = Console([], dict(env, ZHIVEX_HARNESS_CONFIG_DIR=str(root / "detected"), DASHSCOPE_API_KEY="fixture-only"))
    try:
        output = detected.read("\n> ")
        assert b"qwen/" in output and b"credential: environment" in output, output
        assert b"First-time setup" not in output and b"Credentials / openai" not in output
        detected.send("/exit\n")
        assert detected.wait_exit() == 0
    finally: detected.close()
    # Ambiguous credentials open the chooser; cancellation does not create a profile.
    ambiguous = Console([], dict(env, ZHIVEX_HARNESS_CONFIG_DIR=str(root / "ambiguous"), DASHSCOPE_API_KEY="fixture-only", OPENAI_API_KEY="fixture-only"))
    try:
        ambiguous.read("Zhivex / Providers")
        ambiguous.read_selection()
        ambiguous.send("\x1b")
        ambiguous.read("Setup cancelled")
        assert ambiguous.wait_exit() == 0
        assert not (root / "ambiguous/profiles/default.json").exists()
    finally: ambiguous.close()
    fixture_env = dict(env, OPENAI_API_KEY="fixture-only", OPENAI_BASE_URL="https://api.openai.com/v1", CONSOLE_FIXTURE_REQUESTS=str(root / "requests.jsonl"))
    profile_path = root / "config/profiles/default.json"
    # A persisted Qwen preference survives repeated bare launches without confirmation.
    updated = subprocess.run(cli + ["init", "--update", "--provider", "qwen", "--json"],
                             env=fixture_env, cwd=root, capture_output=True, text=True)
    assert updated.returncode == 0, updated.stderr
    qwen_profile = json.loads(updated.stdout)["profile"]
    for args in ([], ["chat"], ["chat", "--token-budget"], ["chat", "--context-tokens", "100000"], ["chat", "--approval-mode", "auto"], ["chat", "--approval-mode", "restricted"]):
        preferred = Console(args, dict(fixture_env, QWEN_API_KEY="fixture-only"))
        try:
            output = preferred.read("\n> ")
            assert b"Use default profile" not in output
            if "--approval-mode" in args:
                assert (b"Restricted mode:" if args[-1] == "restricted" else b"Automatic approvals are enabled") in output
            assert b"qwen" in output.lower(), output
            assert json.loads(profile_path.read_text())["model"] == qwen_profile["model"]
            preferred.send("/context\n")
            context_output = preferred.read("Active retained conversation:") + preferred.read("\n> ")
            expected = b"Cumulative token limits per run:" if "--token-budget" in args else b"Cumulative token budget: unlimited"
            assert expected in context_output, context_output
            if "--context-tokens" in args:
                assert b"100000 estimated tokens" in context_output
            preferred.send("/limits 30\n")
            preferred.read("Step limit updated: 30")
            preferred.read("\n> ")
            preferred.send("/approvals restricted\n")
            preferred.read("Approval mode: restricted")
            preferred.read("\n> ")
            preferred.send("/approvals\n")
            preferred.read_selection()
            preferred.send("auto\n")
            preferred.read("Approval mode: auto")
            preferred.read("\n> ")
            if not args:
                preferred.send("/credentials\n")
                preferred.read_selection()
                preferred.send("Qwen\n")
                preferred.read_selection()
                preferred.send("Temporary\n")
                preferred.read_selection()
                preferred.send("Standard\n")
                preferred.read_selection()
                preferred.send("Singapore\n")
                preferred.read_selection()
                preferred.send("DashScope\n")
                preferred.read("API key (hidden; Enter submits, Ctrl+C cancels): ")
                preferred.send("qwen-hidden-fixture\n")
                key_output = preferred.read("API key is available only for this CLI session.")
                assert b"qwen-hidden-fixture" not in key_output
                preferred.read("\n> ")
                preferred.send("/connection\n")
                preferred.read("Connection: qwen/")
                preferred.read_selection()
                preferred.send("\n")
                preferred.read("\n> ")
                assert not (root / "requests.jsonl").exists()
                preferred.send("/connection\n")
                preferred.read("Connection: qwen/")
                preferred.read_selection()
                preferred.send("Send a small\n")
                preferred.read("Connection verified:")
                preferred.read("\n> ")
                probe = json.loads((root / "requests.jsonl").read_text())
                assert probe.get("max_completion_tokens", probe.get("max_tokens")) == 16 and not probe.get("tools"), probe
                assert probe["messages"] == [{"role": "user", "content": "Reply OK."}], probe
                (root / "requests.jsonl").unlink()
            preferred.send("/exit\n")
            assert preferred.wait_exit() == 0
            assert not (root / "requests.jsonl").exists()
        finally: preferred.close()
    diagnostic = subprocess.run(cli + ["doctor", "--json"], env=dict(fixture_env, QWEN_API_KEY="fixture-only"), cwd=root, capture_output=True, text=True)
    assert diagnostic.returncode == 0, diagnostic.stderr
    assert json.loads(diagnostic.stdout)["configuration"]["provider"] == "qwen"
    profile_path.write_text(json.dumps(saved))
    direct = Console([], fixture_env)
    try:
        output = direct.read("\n> ")
        assert b"Welcome" in output and b"Use default profile" not in output
        # Changes on disk do not replace the selection of an already opened console.
        profile_path.write_text(json.dumps(dict(saved, provider="qwen", model="qwen3.8-max")))
        direct.send("/conversation\t\n")
        # Selection opens the conversation picker without submitting a provider request.
        direct.read_selection()
        direct.send("\r")
        direct.read("Resumed session")
        direct.read("\n> ")
        assert not (root / "requests.jsonl").exists()
        direct.send("? ")
        direct.read("Keyboard shortcuts")
        direct.send("\x03")
        direct.read("Input interrupted")
        direct.read("\n> ")
        direct.send("WAIT_FIXTURE\n")
        direct.read("Waiting for model response")
        direct.read(" · 1s")
        direct.read("Fixture done")
        direct.read("\n> ")
        direct.send("FAIL_STREAM_FIXTURE\n")
        direct.read("Recoverable partial")
        direct.read("\n> ")
        direct.send("/continue\n")
        direct.read("Continuing in a new run")
        direct.read("Fixture done")
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
        direct.read_selection()
        direct.send("\r")
        direct.read("Zhivex / Providers")
        direct.read_selection()
        direct.send("openai\r")
        direct.read("OpenAI / Models")
        direct.read_selection()
        direct.send("\x1b")
        direct.read("Zhivex / Providers")
        direct.read_selection()
        direct.send("\x1b")
        direct.read("Zhivex / Menu")
        direct.read_selection()
        direct.send("\x1b")
        direct.read("\n> ")
        direct.send("/provider\n")
        direct.read_selection()
        direct.send("openai\r")
        direct.read("OpenAI / Models")
        direct.read_selection()
        direct.send("\r")
        direct.read("Next turn: openai/")
        direct.read("\n> ")
        direct.send("/model\n")
        direct.read("OpenAI / Models")
        direct.read_selection()
        direct.send("\x1b")
        direct.read("\n> ")
        direct.send("EDIT_FIXTURE\n")
        approval_card = direct.read("Permission required")
        assert b"approval approval_" not in approval_card and b"input sha256:" not in approval_card
        direct.read_selection()
        direct.send("View technical\n")
        direct.read("Complete approval payload:")
        direct.read("Permission required")
        direct.read_selection()
        direct.send("Allow once\n")
        direct.read("Fixture done")
        direct.read("\n> ")
        assert (root / "result.txt").read_text() == "approved fixture edit\n"
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
        service.read_selection()
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
