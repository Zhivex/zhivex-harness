"""Built CLI, real PTY, isolated host and process-local provider fixture."""
import json, os, pathlib, pty, select, subprocess, sys, tempfile, time

repo = pathlib.Path(__file__).resolve().parent.parent
cli = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else repo/'dist/cli.js'
root = pathlib.Path(tempfile.mkdtemp(prefix='harness-policy-console-'))
workspace = root/'workspace'; workspace.mkdir()
policy = root/'policy.json'
policy.write_text(json.dumps({'schemaVersion':1, 'explicitReview':{'schemaVersion':1}, 'rules':[
    {'id':'review-edits', 'tools':['apply_reviewed_edits'], 'decision':'ask_user', 'reason':'Review edits before applying'}]}))
policy.chmod(0o600)
env = {key:value for key,value in os.environ.items() if key in ('PATH','TMPDIR','LANG')}
env.update(HOME=str(root), OPENAI_API_KEY='fixture-only', OPENAI_BASE_URL='https://api.openai.com/v1', TERM='xterm-256color',
           CONSOLE_FIXTURE_REQUESTS=str(root/'requests.jsonl'))
transcript = bytearray()
pending = b''

def start(resume=False):
    global master, process, pending
    pending = b''
    master, slave = pty.openpty()
    process = subprocess.Popen(['node','--import',str(repo/'tests/fixtures/console-fetch.mjs'),str(cli),'chat',
        '--provider','openai','--workspace',str(workspace),'--tool-policy',str(policy), *(['--continue'] if resume else [])],
        stdin=slave,stdout=slave,stderr=slave,env=env,cwd=root)
    os.close(slave)

def until(marker, timeout=25):
    global pending
    deadline = time.monotonic()+timeout
    while time.monotonic()<deadline:
        index = pending.find(marker.encode())
        if index>=0:
            end=index+len(marker.encode()); result,pending=pending[:end],pending[end:]; return result.decode(errors='replace')
        if select.select([master],[],[],.1)[0]:
            try: chunk=os.read(master,65536)
            except OSError: break
            pending+=chunk; transcript.extend(chunk)
    raise AssertionError('Missing '+marker+'; evidence '+str(root)+'; '+pending.decode(errors='replace')[-1800:])

def send(text): os.write(master,text.encode())
def stop():
    send('/exit\n')
    deadline=time.monotonic()+5
    while process.poll() is None and time.monotonic()<deadline:
        if select.select([master],[],[],.1)[0]:
            try: transcript.extend(os.read(master,65536))
            except OSError: break
    assert process.wait(timeout=2)==0
    os.close(master)

try:
    start(); until('> '); send('EDIT_FIXTURE\n')
    review=until('Filter > ')
    assert review.index('Policy · apply_reviewed_edits') < review.index('Approval required')
    assert 'explicit review required' in review and 'review-edits' in review
    assert '"expectedDigest": null' in review and 'approved fixture edit' in review
    assert not (workspace/'result.txt').exists()
    send('Leave pending\r'); until('is paused; use /pending'); until('> ')
    stop()
    start(True); restored=until('> '); assert 'waiting_approval' in restored
    send('/approve\n'); review=until('Filter > ')
    assert review.index('Policy · apply_reviewed_edits') < review.index('Approval required')
    assert '"expectedDigest": null' in review and 'approved fixture edit' in review
    assert 'Allow this exact check for this session' not in review
    assert not (workspace/'result.txt').exists()
    send('Allow once\r'); applied=until('Fixture done'); until('> ')
    assert 'tool-entry' in applied
    assert (workspace/'result.txt').read_text()=='approved fixture edit\n'
    stop()
    print(json.dumps({'schemaVersion':1,'fixture':True,'installed':'--installed' in sys.argv[2:],'liveProvider':False,
        'policyBeforeInitialReview':True,'restartPendingPreserved':True,'commandOpensFullReview':True,
        'policyBeforeCommandReview':True,'appliedAfterInteractiveDecision':True,'evidenceDirectory':str(root)}))
finally:
    if process.poll() is None: process.kill(); process.wait(timeout=5)
    (root/'transcript.txt').write_bytes(transcript)
