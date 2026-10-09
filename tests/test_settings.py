import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import frida


class SettingsTest(unittest.TestCase):
    def test_saving_shorter_settings_removes_old_bytes(self):
        source = (Path(__file__).resolve().parents[1] / 'hero_tab.js').read_text(encoding='utf-8')
        save = 'const save =' + source.split('const save =', 1)[1].split('// Mods', 1)[0]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder, 'settings.json')
            child = subprocess.Popen(
                [sys.executable, '-c', 'import time; time.sleep(60)'],
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            session = None
            try:
                session = frida.attach(child.pid)
                script = session.create_script(
                    'let settingsPath, settings;\n' + save
                    + '\nrpc.exports.save = (path, value) => { settingsPath = path; settings = value; save(); };'
                )
                script.load()
                for settings in [
                    {'removeLigatures': False, 'modWindowKey': {'vk': 9, 'name': 'TAB'}, 'lexicon': 'exemplo'},
                    {'removeLigatures': True, 'modWindowKey': {'vk': 9, 'name': 'TAB'}},
                    {},
                ]:
                    with self.subTest(settings=settings):
                        script.exports_sync.save(str(path), settings)
                        self.assertEqual(json.loads(path.read_text(encoding='utf-8')), settings)
            finally:
                try:
                    if session is not None:
                        session.detach()
                finally:
                    child.terminate()
                    child.wait()
