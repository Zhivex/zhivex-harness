"""Local Linux/macOS terminal smoke. Requires Python 3, Node and a built dist/cli.js.
Uses a process-local fetch fixture; never contacts or bills a provider.
"""
import json
import fcntl
import os
import pathlib
import pty
import select
import shutil
import subprocess
import struct
import sys
import tempfile
import time
import termios

repo = pathlib.Path(__file__).resolve().parent.parent
cli = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else repo / "dist/cli.js"
root = tempfile.mkdtemp(prefix="harness-console-pty-")
master, slave = pty.openpty()
pathlib.Path(root, "example.txt").write_text("example attachment\n")
env = {key: value for key, value in os.environ.items() if key in (
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "LANG", "LC_ALL")}
env.update(OPENAI_API_KEY="fixture-only", OPENAI_BASE_URL="https://api.openai.com/v1",
           CONSOLE_FIXTURE_REQUESTS=root + "/requests.jsonl", TERM="xterm-256color")
# This smoke exercises conversation behavior; console-entry-smoke covers onboarding.
# Select the fixture provider explicitly so a clean profile never waits for setup.
proc = subprocess.Popen(["node", "--import", str(repo / "tests/fixtures/console-fetch.mjs"),
                         str(cli), "chat", "--provider", "openai", "--workspace", root],
                        stdin=slave, stdout=slave, stderr=slave, env=env)
os.close(slave)
transcript = b""
pending = b""


def read_until(marker, timeout=15):
    global transcript, pending
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        index = pending.find(marker.encode())
        if index >= 0:
            end = index + len(marker.encode())
            result, pending = pending[:end], pending[end:]
            return result
        if select.select([master], [], [], 0.1)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            pending += chunk
            transcript += chunk
    raise AssertionError(f"Missing {marker}: " + pending.decode(errors="replace")[-1800:])


def send(text):
    os.write(master, text.encode())


def exit_chat():
    global transcript
    send("/exit\n")
    deadline = time.monotonic() + 10
    while proc.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            try:
                transcript += os.read(master, 65536)
            except OSError:
                break
    proc.wait(timeout=1)
    assert proc.returncode == 0


try:
    read_until("> ")
    # Node is the installed CLI runtime. Exercise actual cursor insertion rather
    # than Bun's readline shim, which ignores native Left/Right cursor edits.
    send("\x1b[200~first\nsecond\x1b[201~")
    read_until("second")
    send("\x1b[A!\x1b[B?\n")
    read_until("Fixture done")
    read_until("> ")
    edited = json.loads(pathlib.Path(root, "requests.jsonl").read_text().splitlines()[-1])
    assert "first!\\nsecond?" in json.dumps(edited)
    send("/new\n")
    read_until("Created session")
    read_until("> ")
    pathlib.Path(root, "requests.jsonl").unlink()
    # Real Node readline: resize and cursor navigation preserve a pasted draft.
    send("\x1b[200~/approve\nLiteral clipboard\x1b[201~")
    read_until("Literal clipboard")
    assert not pathlib.Path(root, "requests.jsonl").exists()
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 45, 0, 0))
    send("\x1b[D!\n")
    read_until("Fixture done")
    read_until("> ")
    pasted = json.loads(pathlib.Path(root, "requests.jsonl").read_text().splitlines()[-1])
    assert "/approve\\nLiteral clipboar!d" in json.dumps(pasted)
    send("/new\n")
    read_until("> ")
    send("/cont")
    read_until("/cont")
    send("\t")
    read_until("ext")
    send("\n")
    read_until("Project context")
    read_until("> ")
    send("/attach .env\n")
    assert b"Session retained" in read_until("> ")
    send("/attach example.txt\n")
    assert b"Attached example.txt" in read_until("> ")
    send("/paste\n")
    read_until("finish with .end")
    send("Review the attachment\n/approve\n.end\n")
    read_until("Type send: ")
    send("send\n")
    read_until("Fixture done")
    read_until("> ")
    requests = [json.loads(line) for line in pathlib.Path(root, "requests.jsonl").read_text().splitlines()]
    assert "example attachment" in json.dumps(requests[-1])
    assert "/approve" in json.dumps(requests[-1])
    send("/new\n")
    read_until("> ")
    send("Native line one")
    read_until("Native line one")
    send("\x1b\r")
    send("Native line two\n")
    read_until("Fixture done")
    read_until("> ")
    native_requests = pathlib.Path(root, "requests.jsonl").read_text().splitlines()
    assert "Native line one\nNative line two" in json.dumps(json.loads(native_requests[-1])).replace("\\n", "\n")
    send("/new\n")
    read_until("> ")
    send("SLOW_FIXTURE\n")
    deadline = time.monotonic() + 5
    while "SLOW_FIXTURE" not in pathlib.Path(root, "requests.jsonl").read_text():
        assert time.monotonic() < deadline
        time.sleep(0.02)
    read_until("Cancellable partial")
    send("\x03")
    read_until("> ", 20)
    send("/status\n")
    assert b"(cancelled)" in read_until("> ")
    send("Continue after interruption\n")
    read_until("Fixture done")
    read_until("> ")
    send("/new\n")
    read_until("> ")
    send("FAIL_STREAM_FIXTURE\n")
    read_until("Recoverable partial\\u001b[2J")
    # A partial line must be visible before the provider fails, with inert controls.
    assert b"\x1b[2J" not in transcript
    send("BUSY_INPUT_MUST_NOT_ECHO")
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 80, 0, 0))
    read_until("> ")
    assert b"BUSY_INPUT_MUST_NOT_ECHO" not in transcript
    send("\x1b[A\n")
    read_until("Fixture done")
    read_until("> ")
    recovered = json.loads(pathlib.Path(root, "requests.jsonl").read_text().splitlines()[-1])
    assert "FAIL_STREAM_FIXTURE" in json.dumps(recovered)
    send("/new\n")
    read_until("> ")
    send("EDIT_FIXTURE\n")
    read_until("Approve?")
    assert not pathlib.Path(root, "result.txt").exists()
    send("\x1b[200~y\n/approve\x1b[201~")
    time.sleep(0.1)
    assert not pathlib.Path(root, "result.txt").exists()
    send("\x03")
    read_until("> ")
    send("/rename Daily pilot\n")
    read_until("> ")
    send("/sessions pilot\n")
    assert b"Daily pilot" in read_until("> ")
    send("/pending\n")
    assert b"apply_reviewed_edits" in read_until("> ")
    assert not pathlib.Path(root, "result.txt").exists()
    exit_chat()
    os.close(master)
    master, slave = pty.openpty()
    pending = b""
    proc = subprocess.Popen(["node", "--import", str(repo / "tests/fixtures/console-fetch.mjs"),
                             str(cli), "chat", "--continue", "--workspace", root],
                            stdin=slave, stdout=slave, stderr=slave, env=env)
    os.close(slave)
    restored = read_until("> ")
    assert b"durable status: waiting_approval" in restored
    assert b"apply_reviewed_edits" in restored
    send("/pending\n")
    assert b"apply_reviewed_edits" in read_until("> ")
    send("/approve\n")
    read_until("Fixture done")
    read_until("> ")
    assert pathlib.Path(root, "result.txt").read_text() == "approved fixture edit\n"
    send("Next task\n")
    read_until("Fixture done")
    read_until("> ")
    exit_chat()
    assert b"\x1b[?2004l" in transcript
    print("PTY smoke passed: literal paste, navigation, resize, context, attachments, multiline, interruption, partial stream failure, history recovery, paste-safe approvals, approval restart, edit, next turn, exit.")
except BaseException:
    print(transcript.decode(errors="replace")[-6000:])
    raise
finally:
    if proc.poll() is None:
        proc.kill()
        proc.wait()
    os.close(master)
    shutil.rmtree(root)
