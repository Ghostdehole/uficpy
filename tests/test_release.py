"""Check the archives and manifests before they become public release assets."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
try:
    spec = importlib.util.spec_from_file_location('package_release', ROOT/'scripts/package_release.py')
    package = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(package)
    from release_notes import release_notes
finally:
    sys.path.pop(0)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        for name in package.FILES:
            if name != 'uficpy':
                (self.root/name).write_text('fixture\n')
        (self.root/'VERSION').write_text('9.9.9\n')
        (self.root/'version.txt').write_text('5.0.1\n')
        (self.root/'core-lock.json').write_text(json.dumps({'version': '5.0.1', 'sha256': hashlib.sha256((self.root/'scrcpy-server.jar').read_bytes()).hexdigest()}))
        (self.root/'config.json').write_text('{"token":""}')
        (self.root/'licenses').mkdir()
        (self.root/'licenses/notice.txt').write_text('license')
        (self.root/'dist').mkdir()
        binary = bytearray(20)
        binary[:6] = b'\x7fELF\x02\x01'
        binary[18:20] = (183).to_bytes(2, 'little')
        (self.root/'dist/uficpy').write_bytes(binary)

    def package(self, tag='v-test'):
        with patch.object(package, 'ROOT', self.root), patch.object(sys, 'argv', ['package_release.py', '--tag', tag]), contextlib.redirect_stdout(io.StringIO()):
            package.main()

    def test_release_contract_and_source_cleanup(self):
        for directory in ['.github/workflows', 'local-downloads', 'scripts/__pycache__']:
            (self.root/directory).mkdir(parents=True)
        (self.root/'.github/workflows/release.yml').write_text('workflow')
        (self.root/'local-downloads/secret.txt').write_text('private')
        (self.root/'scripts/__pycache__/cached.pyc').write_bytes(b'cache')
        for name in ['fixture-server', 'config.local.json', '.env', 'uficpy.log']:
            (self.root/name).write_text('private')
        (self.root/'dist/uficpy_plugin.js').write_text('old')
        (self.root/'dist/uficpy_plugin-v9.9.8.js').write_text('old')
        self.package()
        dist = self.root/'dist'
        manifest = json.loads((dist/'release.json').read_text())
        self.assertEqual(manifest['tag'], 'v-test')
        asset = manifest['assets']['arm64']
        self.assertEqual(asset['size'], (dist/asset['name']).stat().st_size)
        self.assertEqual(asset['sha256'], hashlib.sha256((dist/asset['name']).read_bytes()).hexdigest())
        index = json.loads((dist/'repo.json').read_text())
        self.assertEqual(index['download_url'], 'https://github.com/Ghostdehole/uficpy/releases/download/v-test')
        plugin = manifest['assets']['plugin']
        self.assertEqual(plugin['name'], 'uficpy_plugin-v9.9.9.js')
        data = (dist/plugin['name']).read_bytes()
        self.assertEqual(data, (self.root/'uficpy_plugin.js').read_bytes())
        self.assertEqual(plugin['size'], len(data))
        self.assertEqual(plugin['sha256'], hashlib.sha256(data).hexdigest())
        item = index['res']['data']['content'][0]
        self.assertEqual(item['name'], plugin['name'])
        self.assertEqual(item['size'], len(data))
        self.assertEqual(item['hash_info']['md5'], hashlib.md5(data).hexdigest())
        source_index = json.loads((self.root/'repo.json').read_text())
        self.assertEqual(source_index['res']['data']['content'][0]['name'], 'uficpy_plugin.js')
        self.assertFalse((dist/'uficpy_plugin.js').exists())
        self.assertFalse((dist/'uficpy_plugin-v9.9.8.js').exists())
        checks = {}
        for line in (dist/'SHA256SUMS').read_text().splitlines():
            digest, name = line.split('  ')
            self.assertEqual(digest, hashlib.sha256((dist/name).read_bytes()).hexdigest())
            checks[name] = digest
        self.assertIn(plugin['name'], checks)
        self.assertIn('uficpy-mirror.zip', checks)
        self.assertNotIn('uficpy_plugin.js', checks)
        with zipfile.ZipFile(dist/'uficpy-source.zip') as archive:
            names = archive.namelist()
            self.assertIn('uficpy/.github/workflows/release.yml', names)
            self.assertIn('uficpy/core-lock.json', names)
            self.assertFalse(any(any(item in name for item in ['local-downloads', '__pycache__', '/dist/', 'fixture-server', 'config.local', '.env', '.log']) for name in names))
        with tarfile.open(dist/asset['name']) as archive:
            for entry in archive.getmembers():
                self.assertTrue(entry.isfile())
                self.assertFalse(entry.name.startswith('/') or '..' in pathlib.PurePosixPath(entry.name).parts)
            self.assertEqual(archive.getmember('uficpy').mode, 0o700)
            self.assertEqual(archive.extractfile('uficpy_plugin.js').read(), data)

    def test_mirror_contains_exact_manifest_and_pinned_backend(self):
        tag = 'v9.9.9-scrcpy5.0.1-build.12.2'
        self.package(tag)
        dist = self.root/'dist'
        manifest_data = (dist/'release.json').read_bytes()
        manifest = json.loads(manifest_data)
        # Existing plugins keep using the same schema and GitHub asset name.
        self.assertEqual(manifest['schema'], 1)
        self.assertEqual(manifest['repository'], 'Ghostdehole/uficpy')
        self.assertEqual(manifest['tag'], tag)
        self.assertEqual(set(manifest['assets']), {'arm64', 'plugin'})
        asset = manifest['assets']['arm64']
        self.assertEqual(asset['name'], 'uficpy-arm64.tar.gz')
        backend_path = f"releases/{tag}/{asset['name']}"
        with zipfile.ZipFile(dist/'uficpy-mirror.zip') as archive:
            self.assertEqual(archive.namelist(), [backend_path, 'release.json'])
            self.assertEqual(archive.read('release.json'), manifest_data)
            data = archive.read(backend_path)
        self.assertEqual(data, (dist/asset['name']).read_bytes())
        self.assertEqual(len(data), asset['size'])
        self.assertEqual(hashlib.sha256(data).hexdigest(), asset['sha256'])
        sums = dict(line.split('  ', 1)[::-1] for line in (dist/'SHA256SUMS').read_text().splitlines())
        self.assertEqual(sums['uficpy-mirror.zip'], hashlib.sha256((dist/'uficpy-mirror.zip').read_bytes()).hexdigest())
        # Republishing a different tag replaces this release's bundle rather
        # than carrying stale backends into every subsequent mirror download.
        self.package('v-next')
        with zipfile.ZipFile(dist/'uficpy-mirror.zip') as archive:
            self.assertEqual(archive.namelist(), ['releases/v-next/uficpy-arm64.tar.gz', 'release.json'])

    def test_dot_tags_cannot_escape_version_directory(self):
        for tag in ['.', '..', '../v1']:
            with self.subTest(tag=tag), self.assertRaisesRegex(ValueError, 'tag/repository'):
                self.package(tag)
        self.assertFalse((self.root/'dist/uficpy-mirror.zip').exists())

    def test_private_token_is_never_published(self):
        (self.root/'config.json').write_text(json.dumps({'token': 'a'*64}))
        with self.assertRaisesRegex(ValueError, 'access token'):
            self.package()
        self.assertFalse((self.root/'dist/uficpy-arm64.tar.gz').exists())

    def test_core_version_mismatch_stops_packaging(self):
        (self.root/'version.txt').write_text('0.0.0')
        with self.assertRaisesRegex(ValueError, 'version.txt'):
            self.package()

    def test_schedule_retries_changed_application_or_commit(self):
        bin_dir = self.root/'bin'
        bin_dir.mkdir()
        gh = bin_dir/'gh'
        gh.write_text('#!/bin/sh\nprintf "%s" "$TEST_RELEASE_JSON"\n')
        gh.chmod(0o700)
        cases = [('v9.9.9-scrcpy5.0.1-build.1', 'current', False),
                 ('v9.9.8-scrcpy5.0.1-build.1', 'current', True),
                 ('v9.9.9-scrcpy5.0.1-build.1', 'previous', True)]
        for tag, commit, expected in cases:
            output = self.root/'outputs'
            output.write_text('')
            env = {**os.environ, 'PATH': str(bin_dir)+':'+os.environ['PATH'], 'EVENT_NAME': 'schedule',
                   'GITHUB_REPOSITORY': 'Ghostdehole/uficpy', 'GITHUB_SHA': 'current', 'GITHUB_OUTPUT': str(output),
                   'TEST_RELEASE_JSON': json.dumps({'tag_name': tag, 'target_commitish': commit})}
            subprocess.run([sys.executable, str(ROOT/'scripts/release_needed.py')], cwd=self.root, env=env, check=True, capture_output=True)
            self.assertEqual(output.read_text().strip(), 'needed='+str(expected).lower())

    def test_release_notes_use_only_current_changelog_entry(self):
        notes = release_notes({'version': '2.2.1', 'scrcpy_version': '5.0.1'},
                              '# Changes\n\n## 2.2.1\n\n- 修复发布命名。\n\n## 2.2.0\n\n- 旧内容。\n')
        self.assertIn('修复发布命名', notes)
        self.assertIn('scrcpy 5.0.1', notes)
        self.assertNotIn('旧内容', notes)
        with self.assertRaisesRegex(ValueError, 'Missing changelog'):
            release_notes({'version': '3.0.0', 'scrcpy_version': '5.0.1'}, '## 2.2.1\n- old\n')

    def test_invalid_version_does_not_produce_plugin_path(self):
        (self.root/'VERSION').write_text('../unsafe')
        with self.assertRaisesRegex(ValueError, 'application version'):
            self.package()
