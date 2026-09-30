"""Installed CLI acceptance with isolated HOME and process-local provider fixture."""
import errno, hashlib, json, os, pathlib, pty, select, shutil, subprocess, sys, tempfile, time
installed, node, fixture = map(pathlib.Path, sys.argv[1:4])
root = pathlib.Path(tempfile.mkdtemp(prefix='harness-explicit-cli-'))
cli = installed / 'node_modules/@zhivex-ai/harness/dist/cli.js'
shutil.copyfile(fixture, root / 'fetch.mjs')
policy = root / 'policy.json'
policy.write_text(json.dumps({'schemaVersion': 1, 'explicitReview': {'schemaVersion': 1}, 'rules': []}))
policy.chmod(0o600)
env = {k: v for k, v in os.environ.items() if k in ('PATH', 'TMPDIR', 'LANG')}
env.update(HOME=str(root), OPENAI_API_KEY='fixture-only', OPENAI_BASE_URL='https://api.openai.com/v1', TERM='xterm-256color')

def command(area, args):
    work = root / area / 'workspace'; work.mkdir(parents=True, exist_ok=True)
    return [str(node), '--import', str(root/'fetch.mjs'), str(cli), *args,
            '--workspace', str(work), '--state-dir', str(root/area/'state'), *([] if args[0] == 'runs' else ['--tool-policy', str(policy)])]
def run(area, args):
    local = dict(env, CONSOLE_FIXTURE_REQUESTS=str(root/area/'requests.jsonl'))
    result = subprocess.run(command(area,args), env=local, cwd=root, capture_output=True, text=True, timeout=30)
    (root/area/'last-output.txt').write_text(result.stdout+'\n'+result.stderr)
    return result

blocked = run('auto', ['run', 'EDIT_FIXTURE', '--provider', 'openai', '--model', 'gpt-6-luna', '--yes', '--json'])
assert blocked.returncode != 0, str(root)+' '+blocked.stdout+blocked.stderr
listed = run('auto', ['runs', 'list', '--json'])
assert listed.returncode == 0, listed.stderr
assert 'waiting_approval' in listed.stdout, str(root)+' '+listed.stdout+listed.stderr
assert not (root/'auto/workspace/result.txt').exists()
waiting = run('interactive', ['run', 'EDIT_FIXTURE', '--provider', 'openai', '--model', 'gpt-6-luna', '--json'])
assert waiting.returncode == 0, waiting.stderr
pending = json.loads(waiting.stdout)
assert pending['status'] == 'waiting_approval', pending
args = ['resume', pending['runId'], '--approve', '--json']
rejected = run('interactive', args)
assert rejected.returncode != 0, rejected.stdout+rejected.stderr
still_pending = run('interactive', ['runs', 'list', '--json'])
assert still_pending.returncode == 0 and 'waiting_approval' in still_pending.stdout, still_pending.stdout+still_pending.stderr
assert not (root/'interactive/workspace/result.txt').exists()
master, slave = pty.openpty()
process = subprocess.Popen(command('interactive', args), env=dict(env, CONSOLE_FIXTURE_REQUESTS=str(root/'interactive/requests.jsonl')), cwd=root,
                           stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
output = bytearray(); answered = False; deadline = time.monotonic()+40
try:
    while time.monotonic() < deadline:
        if select.select([master], [], [], .1)[0]:
            try:
                chunk = os.read(master, 65536)
                if not chunk: break
                output.extend(chunk)
            except OSError as error:
                if error.errno == errno.EIO: break
                raise
        text = output.decode('utf-8', errors='replace')
        if not answered and 'Approve?' in text:
            assert '"expectedDigest": null' in text and 'approved fixture edit' in text, text
            assert '[s]ession' not in text
            os.write(master, b'y\r'); answered = True
        if process.poll() is not None: break
    if process.poll() is None: process.kill()
    code = process.wait(timeout=5)
    (root/'transcript.txt').write_bytes(output)
    assert answered and code == 0, f'PTY failure answered={answered} code={code}; {root}'
    assert (root/'interactive/workspace/result.txt').read_text() == 'approved fixture edit\n'
finally:
    if process.poll() is None: process.kill(); process.wait(timeout=5)
    os.close(master)
report = {'schemaVersion':1, 'artifactSha256':hashlib.sha256((installed/'harness.tgz').read_bytes()).hexdigest(), 'installed':True, 'fixture':True, 'published':False, 'liveProvider':False,
          'yesBlocked':True, 'noninteractiveResumeBlocked':True, 'fullPayloadShown':True, 'sessionGrantUnavailable':True,
          'interactiveResumeApplied':True, 'runtime':subprocess.check_output([str(node),'--version'],text=True).strip(), 'evidenceDirectory':str(root)}
(root/'report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
