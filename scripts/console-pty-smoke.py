"""Local Linux/macOS terminal smoke. Requires Python 3, Node and a built dist/cli.js.
Uses a process-local fetch fixture; never contacts or bills a provider.
"""
import json
import os
import pathlib
import pty
import select
import shutil
import subprocess
import sys
import tempfile
import time

repo = pathlib.Path(__file__).resolve().parent.parent
cli = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else repo / "dist/cli.js"
root = tempfile.mkdtemp(prefix="harness-console-pty-")
master, slave = pty.openpty()
pathlib.Path(root, "example.txt").write_text("example attachment\n")
env = {key: value for key, value in os.environ.items() if key in (
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "LANG", "LC_ALL")}
env.update(OPENAI_API_KEY="fixture-only", OPENAI_BASE_URL="https://api.openai.com/v1",
           CONSOLE_FIXTURE_REQUESTS=root + "/requests.jsonl", TERM="xterm-256color")
proc = subprocess.Popen(["node", "--import", str(repo / "tests/fixtures/console-fetch.mjs"),
                         str(cli), "chat", "--workspace", root],
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
    send("\x03")
    read_until("> ", 20)
    send("/status\n")
    assert b"(cancelled)" in read_until("> ")
    send("Continue after interruption\n")
    read_until("Fixture done")
    read_until("> ")
    send("/new\n")
    read_until("> ")
    send("EDIT_FIXTURE\n")
    read_until("Approve?")
    assert not pathlib.Path(root, "result.txt").exists()
    send("\x03")
    read_until("> ")
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
    read_until("> ")
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
    print("PTY smoke passed: context, attachments, multiline, interruption, approval restart, edit, next turn, exit.")
except BaseException:
    print(transcript.decode(errors="replace")[-6000:])
    raise
finally:
    if proc.poll() is None:
        proc.kill()
        proc.wait()
    os.close(master)
    shutil.rmtree(root)
