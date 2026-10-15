import subprocess
import sys
import unittest
from pathlib import Path

import frida

from mods import lexicon


class NativeVocabularyTest(unittest.TestCase):
    def test_packed_words_cache_and_builtin_restoration(self):
        source = (Path(__file__).resolve().parents[1] / 'mods/lexicon/lexicon.js').read_text(encoding='utf-8')
        vocabulary_code = source.split('const usable =', 1)[0]
        setup = '''
const table = Memory.alloc(128), originals = [];
const at = () => table;
for (let length = 1; length <= 8; length++) {
  const word = Memory.allocUtf8String('g'.repeat(length)), array = Memory.alloc(16);
  originals.push(word, array);
  array.writePointer(word);
  array.add(8).writeU64(length);
  table.add((length - 1) * 16).writePointer(array);
  table.add((length - 1) * 16 + 8).writeU64(1);
}
'''
        probe = '''
rpc.exports.setup = loaded => { dictionaries = loaded; };
rpc.exports.select = index => {
  useDictionary(index < 0 ? null : dictionaries[index]);
  const words = {}, addresses = [];
  for (let length = 1; length <= 8; length++) {
    const group = table.add((length - 1) * 16), array = group.readPointer();
    const count = group.add(8).readU64().toNumber();
    addresses.push(array.toString());
    words[length] = [];
    for (let j = 0; j < count; j++) {
      const entry = array.add(16 * j), size = entry.add(8).readU64().toNumber();
      if (size !== length) throw new Error('Wrong Rust string length');
      words[length].push(entry.readPointer().readUtf8String(size));
    }
  }
  return { words, addresses, cached: dictionaryVocabulary.size, active: active?.name ?? null };
};
'''
        full = lexicon.parse('[a-z]\n' + '\n'.join('abcdefghijklmnopqrstuvwxyz') + '\n' + '\n'.join(
            word[:length] for length in range(2, 9) for word in ['abcdefgh', 'zyxwvuts']
        ))
        sparse = lexicon.parse('[xy]\nxy\nyx\n')
        child = subprocess.Popen(
            [sys.executable, '-c', 'import time; time.sleep(60)'],
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        session = None
        try:
            session = frida.attach(child.pid)
            script = session.create_script(setup + vocabulary_code + probe)
            script.load()
            script.exports_sync.setup([
                {'name': 'full', 'alphabet': 'abcdefghijklmnopqrstuvwxyz', 'words': full},
                {'name': 'sparse', 'alphabet': 'xy', 'words': sparse},
            ])
            builtin = script.exports_sync.select(-1)
            self.assertEqual(builtin['words'], {str(n): ['g' * n] for n in range(1, 9)})
            self.assertEqual(builtin['cached'], 0)
            first = script.exports_sync.select(0)
            self.assertEqual(first['words'], {str(n): values for n, values in full.items()})
            self.assertEqual(first['active'], 'full')
            self.assertEqual(first['cached'], 1)
            second = script.exports_sync.select(1)
            self.assertEqual(second['words'], {str(n): values or ['x' * n] for n, values in sparse.items()})
            self.assertEqual(second['cached'], 2)
            again = script.exports_sync.select(0)
            self.assertEqual(again, {**first, 'cached': 2})
            restored = script.exports_sync.select(-1)
            self.assertEqual(restored, {**builtin, 'cached': 2})
        finally:
            try:
                if session is not None:
                    session.detach()
            finally:
                child.terminate()
                child.wait()
