import datetime
import hashlib
import importlib.util
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('plugin_source', ROOT/'scripts/plugin_source.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PluginSourceTests(unittest.TestCase):
    def test_store_contract_and_actual_plugin_digest(self):
        with tempfile.TemporaryDirectory() as folder:
            plugin = pathlib.Path(folder)/'uficpy_plugin.js'
            plugin.write_text('// 中文插件\n', encoding='utf-8')
            (plugin.parent/'not-a-plugin.exe').write_bytes(b'not JS')
            base = 'https://github.com/Ghostdehole/uficpy/releases/download/v-test'
            data = module.generate(plugin, base+'/')
            self.assertEqual(data['res']['code'], 200)
            items = data['res']['data']['content']
            self.assertEqual(len(items), 1)
            item = items[0]
            self.assertEqual(data['download_url']+'/'+item['name'], base+'/uficpy_plugin.js')
            self.assertEqual(item['size'], len(plugin.read_bytes()))
            self.assertEqual(item['hash_info']['md5'], hashlib.md5(plugin.read_bytes()).hexdigest())
            self.assertIsNotNone(datetime.datetime.fromisoformat(item['modified']).tzinfo)
            self.assertFalse(item['is_dir'])

    def test_bad_download_url_is_rejected(self):
        for url in ['https://example.com/repo?query', 'http://example.com', 'https://user:pass@example.com']:
            with self.assertRaises(ValueError):
                module.generate(ROOT/'uficpy_plugin.js', url)

    def test_versioned_release_plugin_uses_actual_name(self):
        with tempfile.TemporaryDirectory() as folder:
            plugin = pathlib.Path(folder)/'uficpy_plugin-v2.2.1.js'
            plugin.write_text('// plugin\n')
            data = module.generate(plugin, 'https://github.com/Ghostdehole/uficpy/releases/download/v2.2.1')
            self.assertEqual(data['res']['data']['content'][0]['name'], plugin.name)
            wrong = plugin.with_name('not-uficpy.js')
            wrong.write_text('// wrong\n')
            with self.assertRaises(ValueError):
                module.generate(wrong, 'https://example.com/plugins')
