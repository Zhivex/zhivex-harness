"""Exercise the installed CLI's transition into the restored interactive session."""
import errno, fcntl, json, os, pty, select, struct, subprocess, sys, termios, time

spec = json.load(open(sys.argv[1], encoding="utf-8"))
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 120, 0, 0))
process = subprocess.Popen(spec["command"], cwd=spec["cwd"], env=spec["env"], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
output = bytearray()
opened = False
deadline = time.monotonic() + 30
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(master, 65536)
                if not chunk:
                    break
                output.extend(chunk)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
        text = output.decode("utf-8", errors="replace")
        if not opened and "Ready · credential:" in text and spec["expectedTitle"] in text:
            opened = True
            os.write(master, b"/exit\r")
        if process.poll() is not None:
            break
    if process.poll() is None:
        process.kill()
    code = process.wait(timeout=5)
    with open(spec["transcript"], "wb") as transcript:
        transcript.write(output)
    if not opened or code != 0:
        raise RuntimeError(f"CLI_PTY_FAILED opened={opened} exit={code}; inspect fixture transcript")
    print(json.dumps({"status": "passed", "interactiveDerivativeOpened": True, "normalExit": True}))
finally:
    if process.poll() is None:
        process.kill()
        process.wait(timeout=5)
    os.close(master)
