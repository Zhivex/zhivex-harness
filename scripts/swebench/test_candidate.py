import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from candidate import candidate_patch


def digest(text):
    return 'sha256:' + hashlib.sha256(text.encode()).hexdigest()


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='zhx-candidate-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / 'repository'
        self.repo.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)
        (self.repo / 'source.txt').write_text('before\n')
        subprocess.run(['git', '-C', str(self.repo), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.repo), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'base'], check=True)

    def snapshot(self):
        return {'entries': [{'path': 'source.txt', 'operation': 'update', 'beforeDigest': digest('before\n'), 'afterDigest': digest('after\n'), 'content': 'after\n', 'afterMode': 0o644}]}

    def test_independent_candidate_preserves_host_and_uses_frozen_base(self):
        (self.repo / 'source.txt').write_text('host import differs\n')
        patch = candidate_patch(self.repo, self.snapshot())
        self.assertIn('-before\n+after\n', patch)
        self.assertNotIn('host import differs', patch)
        self.assertEqual((self.repo / 'source.txt').read_text(), 'host import differs\n')

    def test_rejects_content_mismatch_and_escape(self):
        for change in [{'path': '../outside'}, {'path': '.git/config'}, {'content': 'tampered'}, {'beforeDigest': digest('wrong')}, {'afterMode': 0o4755}]:
            with self.subTest(change=change):
                snapshot = self.snapshot()
                snapshot['entries'][0].update(change)
                with self.assertRaises(ValueError):
                    candidate_patch(self.repo, snapshot)
        self.assertEqual((self.repo / 'source.txt').read_text(), 'before\n')

    def test_does_not_run_global_filters_or_hooks(self):
        marker = self.root / 'filter-executed'
        (self.repo / '.gitattributes').write_text('*.txt filter=fixture\n')
        subprocess.run(['git', '-C', str(self.repo), 'add', '.gitattributes'], check=True)
        subprocess.run(['git', '-C', str(self.repo), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'attributes'], check=True)
        config = self.root / 'gitconfig'
        config.write_text('[filter "fixture"]\n smudge = touch ' + str(marker) + '; cat\n')
        original = os.environ.get('GIT_CONFIG_GLOBAL')
        os.environ['GIT_CONFIG_GLOBAL'] = str(config)
        try:
            candidate_patch(self.repo, self.snapshot())
        finally:
            if original is None:
                del os.environ['GIT_CONFIG_GLOBAL']
            else:
                os.environ['GIT_CONFIG_GLOBAL'] = original
        self.assertFalse(marker.exists())


if __name__ == '__main__':
    unittest.main()
