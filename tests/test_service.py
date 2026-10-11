"""Run the actual service against a host binary; never access Android /data."""
import json
import os
import pathlib
import shutil
import socket
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class ServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        probe = subprocess.Popen(['sleep', '30'])
        try:
            try:
                os.readlink(f'/proc/{probe.pid}/exe')
            except (PermissionError, FileNotFoundError):
                raise unittest.SkipTest('Host denies /proc/PID/exe; service identity requires Linux procfs access')
        finally:
            probe.terminate()
            probe.wait()
        cls.build = tempfile.TemporaryDirectory(prefix='uficpy-service-build-')
        cls.addClassCleanup(cls.build.cleanup)
        cls.binary = pathlib.Path(cls.build.name)/'uficpy'
        subprocess.run([os.environ.get('GO', 'go'), 'build', '-buildvcs=false', '-o', str(cls.binary), '.'],
                       cwd=ROOT, check=True, capture_output=True, text=True, timeout=120)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='uficpy-service-')
        self.addCleanup(self.temp.cleanup)
        self.directory = pathlib.Path(self.temp.name)
        for name in ['service.sh', 'scrcpy-server.jar', 'version.txt', 'core-lock.json']:
            shutil.copyfile(ROOT/name, self.directory/name)
        shutil.copyfile(self.binary, self.directory/'uficpy')
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            self.port = probe.getsockname()[1]
        self.write_config(self.port)
        self.addCleanup(self.stop)

    def write_config(self, port):
        (self.directory/'config.json').write_text(json.dumps({'listen': '127.0.0.1', 'port': port}))

    def run_service(self, action, success=True):
        result = subprocess.run(['sh', str(self.directory/'service.sh'), action],
                                capture_output=True, text=True, timeout=35)
        if success:
            log = self.directory/'uficpy.log'
            self.assertEqual(result.returncode, 0,
                             result.stdout+result.stderr+(log.read_text() if log.exists() else ''))
        return result

    def stop(self):
        self.run_service('stop')

    def test_lifecycle_readiness_and_unrelated_pid(self):
        self.assertEqual(self.run_service('status').stdout.strip(), 'stopped')
        self.assertIn('running:', self.run_service('start').stdout)
        self.assertEqual(self.run_service('status').stdout.strip(), 'running')
        self.assertIn('already running', self.run_service('start').stdout)
        self.assertEqual(len(json.loads((self.directory/'config.json').read_text())['token']), 64)
        # A live process without readiness must not count as a successful start.
        (self.directory/'uficpy.ready').unlink()
        self.assertNotEqual(self.run_service('start', success=False).returncode, 0)
        self.assertEqual(self.run_service('status').stdout.strip(), 'stopped')
        self.assertIn('running:', self.run_service('restart').stdout)
        self.stop()
        self.assertEqual(self.run_service('status').stdout.strip(), 'stopped')
        unrelated = subprocess.Popen(['sleep', '30'])
        try:
            (self.directory/'uficpy.pid').write_text(str(unrelated.pid))
            self.assertEqual(self.run_service('status').stdout.strip(), 'stopped')
            self.stop()
            self.assertIsNone(unrelated.poll(), 'service killed an unrelated PID')
        finally:
            unrelated.terminate()
            unrelated.wait()

    def test_port_conflict_does_not_report_running(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            self.write_config(listener.getsockname()[1])
            self.assertNotEqual(self.run_service('start', success=False).returncode, 0)
            self.assertEqual(self.run_service('status').stdout.strip(), 'stopped')
            self.assertFalse((self.directory/'uficpy.ready').exists())


if __name__ == '__main__':
    unittest.main()
