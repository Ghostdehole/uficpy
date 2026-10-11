"""Exercise the real scripts in a temporary fake Android tree, never /data or /proc."""
import os, pathlib, shutil, subprocess, tempfile, unittest

ROOT=pathlib.Path(__file__).resolve().parents[1]

class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name)
        self.data=self.root/'data';self.data.mkdir();(self.root/'proc').mkdir();(self.root/'sdcard').mkdir()
        self.source=self.root/'source';self.source.mkdir();self.target=self.data/'uficpy'
        self.bin=self.root/'bin';self.bin.mkdir()
        for name,body in [('id','echo 0'),('uname','echo aarch64')]:
            p=self.bin/name;p.write_text('#!/bin/sh\n'+body+'\n');p.chmod(0o700)
        self.env={**os.environ,'PATH':str(self.bin)+':'+os.environ['PATH']}
        self.source.joinpath('uficpy').write_text('#!/bin/sh\nexit 0\n')
        self.source.joinpath('service.sh').write_text('#!/bin/sh\nif [ "$1" = start ]; then\n  if [ "${INTERRUPT_START:-0}" = 1 ]; then kill -TERM "$PPID"; exit 1; fi\n  if [ "${FAIL_START:-0}" = 1 ]; then exit 1; fi\nfi\nexit 0\n')
        for name in ['scrcpy-server.jar','core-lock.json','version.txt','VERSION','config.json']:
            (self.source/name).write_text('new-'+name)
        for name in ['install.sh','uninstall.sh']:
            script=(ROOT/name).read_text().replace('/data/',str(self.data)+'/').replace('/proc/',str(self.root/'proc')+'/').replace('/sdcard/',str(self.root/'sdcard')+'/')
            (self.source/name).write_text(script)
        self.source.joinpath('uficpy').chmod(0o700)
        self.target.mkdir();(self.target/'config.json').write_text('old-config');(self.target/'display-backup.json').write_text('old-display');(self.target/'obsolete.txt').write_text('old-code')
        (self.target/'certs').mkdir();(self.target/'certs/server.key').write_text('old-private-key')
        (self.target/'certs/server.key').chmod(0o600)
    def tearDown(self):self.temp.cleanup()
    def run_install(self,*args,fail=False):
        return subprocess.run(['sh',str(self.source/'install.sh'),*args],env={**self.env,'FAIL_START':'1' if fail else '0'},capture_output=True,text=True)
    def test_preserve_config_remove_obsolete_and_uninstall(self):
        r=self.run_install();self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertEqual((self.target/'config.json').read_text(),'old-config')
        self.assertEqual((self.target/'certs/server.key').read_text(),'old-private-key')
        self.assertEqual((self.target/'certs/server.key').stat().st_mode & 0o777,0o600)
        self.assertFalse((self.target/'obsolete.txt').exists());self.assertTrue((self.target/'display-backup.json').exists())
        unrelated=self.data/'other-project';unrelated.mkdir()
        boot=self.root/'sdcard/ufi_tools_boot.sh';boot.write_text('echo keep-other-plugin\n')
        r=subprocess.run(['sh',str(self.target/'uninstall.sh'),'--purge-backups'],env=self.env,capture_output=True,text=True)
        self.assertEqual(r.returncode,0,r.stdout+r.stderr);self.assertFalse(self.target.exists());self.assertTrue(unrelated.exists())
        self.assertEqual(boot.read_text(),'echo keep-other-plugin\n');self.assertFalse(list(self.data.glob('uficpy-backup-*')))
    def test_fresh_config(self):
        r=self.run_install('--fresh');self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertEqual((self.target/'config.json').read_text(),'new-config.json')
        self.assertEqual((self.target/'display-backup.json').read_text(),'old-display')
        self.assertEqual((self.target/'certs/server.key').read_text(),'old-private-key')
        self.assertEqual((self.target/'certs/server.key').stat().st_mode & 0o777,0o600)
    def test_failure_restores_old_tree(self):
        r=self.run_install(fail=True);self.assertNotEqual(r.returncode,0)
        self.assertTrue((self.target/'obsolete.txt').exists());self.assertEqual((self.target/'config.json').read_text(),'old-config')
        self.assertTrue(list(self.data.glob('uficpy-failed-*')));self.assertFalse((self.data/'uficpy-operation.lock').exists())
    def test_preflight_failure_keeps_old_tree(self):
        (self.source/'core-lock.json').unlink();r=self.run_install();self.assertNotEqual(r.returncode,0)
        self.assertTrue((self.target/'obsolete.txt').exists());self.assertFalse((self.data/'uficpy-operation.lock').exists())
    def test_install_source_inside_target_is_rejected(self):
        nested=self.target/'download';shutil.copytree(self.source,nested)
        r=subprocess.run(['sh',str(nested/'install.sh')],env=self.env,capture_output=True,text=True)
        self.assertNotEqual(r.returncode,0);self.assertTrue((self.target/'obsolete.txt').exists())
        self.assertFalse(list(self.data.glob('uficpy-backup-*')))
    def test_uninstall_rejects_extra_arguments_before_deleting(self):
        r=self.run_install();self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        r=subprocess.run(['sh',str(self.target/'uninstall.sh'),'--purge-backups','unexpected'],env=self.env,capture_output=True,text=True)
        self.assertNotEqual(r.returncode,0);self.assertTrue(self.target.exists())
    def test_interrupted_activation_restores_old_tree(self):
        r=subprocess.run(['sh',str(self.source/'install.sh')],env={**self.env,'INTERRUPT_START':'1'},capture_output=True,text=True)
        self.assertNotEqual(r.returncode,0);self.assertTrue((self.target/'obsolete.txt').exists())
        self.assertEqual((self.target/'config.json').read_text(),'old-config')
        self.assertFalse((self.data/'uficpy-operation.lock').exists())

if __name__=='__main__':unittest.main()
