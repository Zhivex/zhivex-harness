"""Build a diagnostic candidate diff in a disposable checkout, never the host tree."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile


def candidate_patch(workspace, snapshot):
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get('entries'), list) or len(snapshot['entries']) > 100:
        raise ValueError('Invalid candidate snapshot')
    entries = snapshot['entries']
    env = {**os.environ, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_TERMINAL_PROMPT': '0'}
    if not entries:
        return ''
    with tempfile.TemporaryDirectory(prefix='zhx-candidate-') as temporary:
        root = Path(temporary).resolve() / 'checkout'
        subprocess.run(['git', '-c', 'core.fsmonitor=false', 'clone', '--quiet', '--no-hardlinks', str(workspace), str(root)],
                       check=True, env=env, capture_output=True, timeout=60)
        # Ignore local imported changes: cloned HEAD is the frozen task base.
        seen = set()
        total = 0
        for entry in entries:
            name = entry.get('path')
            if not isinstance(name, str) or not name or '\\' in name or '\0' in name or Path(name).is_absolute() or any(p in ('..', '.git') for p in Path(name).parts) or name in seen:
                raise ValueError('Unsafe candidate path')
            seen.add(name)
            target = root / name
            if any(p.is_symlink() for p in [target, *target.parents] if p != root.parent):
                raise ValueError('Candidate path contains a symlink')
            operation = entry.get('operation')
            if operation not in ('create', 'update', 'delete'):
                raise ValueError('Invalid candidate operation')
            expected = entry.get('beforeDigest')
            if operation in ('update', 'delete'):
                if not target.is_file() or 'sha256:' + hashlib.sha256(target.read_bytes()).hexdigest() != expected:
                    raise ValueError('Candidate base digest differs')
            elif target.exists():
                raise ValueError('Candidate create target exists')
            if operation == 'delete':
                target.unlink()
                continue
            content = entry.get('content')
            if not isinstance(content, str):
                raise ValueError('Candidate content missing')
            data = content.encode('utf-8')
            total += len(data)
            if len(data) > 1024 * 1024 or total > 2 * 1024 * 1024 or 'sha256:' + hashlib.sha256(data).hexdigest() != entry.get('afterDigest'):
                raise ValueError('Candidate content binding differs')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            mode = entry.get('afterMode', 0o644)
            if not isinstance(mode, int) or not 0 <= mode <= 0o777:
                raise ValueError('Invalid candidate mode')
            os.chmod(target, mode)
        subprocess.run(['git', '-C', str(root), 'add', '-N', '--', '.'], check=True, env=env, capture_output=True, timeout=30)
        return subprocess.run(['git', '-c', 'core.fsmonitor=false', '-C', str(root), 'diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD'],
                              check=True, env=env, capture_output=True, text=True, timeout=30).stdout
