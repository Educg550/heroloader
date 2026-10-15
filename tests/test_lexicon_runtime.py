import subprocess
import sys
import unittest
from pathlib import Path

import frida

from mods import lexicon


# Only game addresses are mocked. Rust strings/vectors use the actual process heap.
SETUP = r'''
const callbacks = new Map(), allocations = new Set(), testRefs = [];
const realNativeFunction = NativeFunction, realInterceptor = Interceptor;
let plannerLengths = [], optionsMode = 0, drops = 0, saved = 0, registered;
const settings = {}, save = () => saved++, registerMod = mod => registered = mod;
const nativeHeapModule = Process.getModuleByName('kernel32.dll');
const nativeHeap = new realNativeFunction(nativeHeapModule.getExportByName('GetProcessHeap'), 'pointer', [])();
const nativeAlloc = new realNativeFunction(nativeHeapModule.getExportByName('HeapAlloc'), 'pointer', ['pointer', 'uint32', 'size_t']);
const nativeFree = new realNativeFunction(nativeHeapModule.getExportByName('HeapFree'), 'int', ['pointer', 'uint32', 'pointer']);
function alloc(size) {
  const p = nativeAlloc(nativeHeap, 0, size);
  if (p.isNull()) throw new Error('test allocation failed');
  allocations.add(p.toString());
  p.writeByteArray(new Uint8Array(size));
  return p;
}
function free(p) {
  if (!allocations.delete(p.toString())) throw new Error('unowned or double free ' + p);
  return nativeFree(nativeHeap, 0, p);
}
function vec(entry, values, write) {
  const data = alloc(Math.max(8, 8 * values.length));
  values.forEach((v, i) => write(data.add(8 * i), v));
  entry.writeU64(values.length || 1);
  entry.add(8).writePointer(data);
  entry.add(16).writeU64(values.length);
}
function freeVec(entry) { if (entry.readU64().compare(0) > 0) free(entry.add(8).readPointer()); }
const mockVocabulary = Memory.alloc(128);
const builtinRefs = [];
for (let n = 1; n <= 8; n++) {
  const word = Memory.allocUtf8String('g'.repeat(n)), group = Memory.alloc(16);
  builtinRefs.push(word, group);
  group.writePointer(word); group.add(8).writeU64(n);
  mockVocabulary.add((n - 1) * 16).writePointer(group);
  mockVocabulary.add((n - 1) * 16 + 8).writeU64(1);
}

const nativeFixture = Memory.alloc(Process.pageSize);
Memory.protect(nativeFixture, Process.pageSize, 'rwx');
const gateAddresses = {0x1400eb3da: nativeFixture.add(64), 0x1400eb3e2: nativeFixture.add(72), 0x1400eb5b0: nativeFixture.add(128)};
Memory.patchCode(nativeFixture, 256, code => {
  const writer = new X86Writer(code, {pc: nativeFixture});
  writer.putPushReg('r12'); writer.putMovRegReg('r12', 'rcx'); writer.putBytes([0xf9]); // stc
  writer.putJmpAddress(nativeFixture.add(64)); writer.flush();
  code.add(64).writeByteArray([0x49, 0xc7, 0x04, 0x24, 2, 0, 0, 0]);
  for (const [offset, result] of [[72, 1], [128, 7]]) {
    const endpoint = new X86Writer(code.add(offset), {pc: nativeFixture.add(offset)});
    endpoint.putMovRegU32('eax', result); endpoint.putBytes([0x83, 0xd0, 0]); // adc eax, 0 tests carry preservation
    endpoint.putPopReg('r12'); endpoint.putRet(); endpoint.flush();
  }
});

const at = address => address === 0x140548460 ? mockVocabulary : gateAddresses[address] ?? ptr(address);
Interceptor = {attach(address, handlers) { callbacks.set(address.toString(), handlers); return { detach() {} }; }};
NativeFunction = new Proxy(realNativeFunction, {
  construct(target, args) {
    const address = args[0].toString();
    if (address === '0x14001af00') return (out, notes, count) => {
      out.writeByteArray(new Uint8Array(72));
      vec(out, plannerLengths, (p, v) => p.writeU64(v));
      vec(out.add(24), plannerLengths.map(() => 0.75), (p, v) => p.writeDouble(v));
      vec(out.add(48), [0], (p, v) => p.writeU64(v));
    };
    if (address === '0x1401275f0') return out => { out.writeByteArray(new Uint8Array(96)); out.add(0x4f).writeU8(optionsMode); out.add(0x5a).writeU8(1); };
    if (address === '0x140154f50') return () => drops++;
    if (address === '0x140123800') return (mode, character) => character % 4;
    if (address === nativeHeapModule.getExportByName('HeapAlloc').toString()) return (heap, flags, size) => alloc(Number(size));
    if (address === nativeHeapModule.getExportByName('HeapFree').toString()) return (heap, flags, p) => free(p);
    return Reflect.construct(target, args);
  },
});
'''

PROBE = r'''
function hook(address) { return callbacks.get(ptr(address).toString()); }
function chart(lengths, owned = false) {
  plannerLengths = lengths;
  const count = lengths.reduce((a, b) => a + b, 0);
  const value = owned ? alloc(0x140) : Memory.alloc(0x140);
  value.writeByteArray(new Uint8Array(0x140));
  const notes = Memory.alloc(Math.max(16, count * 16));
  for (let n = 0; n < count; n++) notes.add(16 * n).writeDouble(n);
  value.add(0x38).writePointer(notes); value.add(0x40).writeU64(count);
  const beats = Memory.alloc(8); value.add(0xf8).writePointer(beats); testRefs.push(notes, beats);
  return value;
}
function wordVec(values) {
  const output = Memory.alloc(24), entries = alloc(24 * values.length);
  output.writeU64(values.length); output.add(8).writePointer(entries); output.add(16).writeU64(values.length);
  values.forEach((word, i) => {
    const entry = entries.add(24 * i), data = alloc(word.length);
    data.writeByteArray([...word].map(c => c.charCodeAt(0)));
    entry.writeU64(word.length); entry.add(8).writePointer(data); entry.add(16).writeU64(word.length);
  });
  return output;
}
function readWords(output) {
  return Array.from({length: output.add(16).readU64().toNumber()}, (_, i) => {
    const entry = output.add(8).readPointer().add(24 * i);
    return entry.add(8).readPointer().readUtf8String(entry.add(16).readU64().toNumber());
  });
}
function freeWords(output) {
  const entries = output.add(8).readPointer(), count = output.add(16).readU64().toNumber();
  for (let i = 0; i < count; i++) free(entries.add(24 * i + 8).readPointer());
  free(entries);
}
rpc.exports.setup = dictionary => {
  testRefs.length = 0; delete settings.lexiconStrict; dictionaries = [dictionary]; useDictionary(dictionary);
  optionsMode = 0; drops = 0; saved = 0; wordMode = true;
};
rpc.exports.strictsettings = () => {
  const row = registered.rows.find(r => r.label === 'strict mode'), initial = row.value();
  row.change(1); const off = [row.value(), settings.lexiconStrict];
  row.change(-1); return {initial, off, on: [row.value(), settings.lexiconStrict], saved};
};
rpc.exports.generate = (strictMode, seed, mode = 0) => {
  settings.lexiconStrict = strictMode;
  const output = wordVec(['xx', 'xxx', 'xxxxx', 'xxxxxxxx']);
  const args = Array.from({length: 11}, () => ptr(0));
  args[0] = output; args[5] = ptr(mode); args[8] = ptr(seed); args[10] = ptr(1);
  const invocation = {}, callback = hook(0x1400f9760), before = allocations.size;
  callback.onEnter.call(invocation, args); callback.onLeave.call(invocation);
  const result = {words: readWords(output), title: args[10].toInt32(), allocations: allocations.size - before};
  freeWords(output); return result;
};
rpc.exports.plan = (strictMode, lengths) => {
  settings.lexiconStrict = strictMode;
  const output = Memory.alloc(72); plannerLengths = lengths;
  planPhrases(output, ptr(0), 0, ptr(0), 0);
  const invocation = {}, callback = hook(0x14001af00);
  callback.onEnter.call(invocation, [output]); callback.onLeave.call(invocation);
  const result = {lengths: [], pressures: []};
  for (let i = 0; i < output.add(16).readU64().toNumber(); i++) {
    result.lengths.push(output.add(8).readPointer().add(8 * i).readU64().toNumber());
    result.pressures.push(output.add(32).readPointer().add(8 * i).readDouble());
  }
  for (let i = 0; i < 3; i++) freeVec(output.add(24 * i));
  return result;
};
rpc.exports.problem = (strictMode, lengths) => {
  settings.lexiconStrict = strictMode;
  const value = chart(lengths), before = allocations.size;
  const problem = chartProblem(value, 0);
  return {problem, leak: allocations.size - before};
};
rpc.exports.loadresult = (strictMode, mode, lengths, alreadyError = false, practiceRange = null) => {
  settings.lexiconStrict = strictMode; optionsMode = mode;
  const value = chart(lengths, true), state = Memory.alloc(0xc88), player = Memory.alloc(0xd40);
  state.writeByteArray(new Uint8Array(0xc88)); player.writeByteArray(new Uint8Array(0xd40));
  if (practiceRange !== null) {
    const sectioned = sectionedChart(lengths, practiceRange[0], practiceRange[1]);
    value.writeByteArray(sectioned.readByteArray(0x140));
    state.add(0xc70).writeU32(1);
    state.add(0xc78).writeU64(0); state.add(0xc80).writeU64(0);
  }
  state.add(0x1c0).writeU64(2); state.add(0xd8).writePointer(player);
  state.add(0x108).writePointer(Memory.alloc(8));
  const context = {rbx: state, r9: ptr(alreadyError ? 1 : '0x8000000000000000'), r13: value, rdi: ptr(0)};
  const before = allocations.size;
  hook(0x140063231).call({context});
  const rejected = context.r13.toString() !== value.toString();
  const result = {rejected, drops, chartFreed: !allocations.has(value.toString()),
    error: rejected ? context.r13.readUtf8String(context.rdi.toInt32()) : null,
    errorCapacity: context.r9.toString(), errorLength: context.rdi.toInt32(),
    leak: allocations.size - before};
  free(context.r13); return result;
};
function sectionedChart(lengths, start, end) {
  const value = chart(lengths), ranges = Memory.alloc(80);
  ranges.writeByteArray(new Uint8Array(80));
  ranges.add(24).writeDouble(start); ranges.add(32).writeDouble(end);
  ranges.add(64).writeDouble(end); ranges.add(72).writeDouble(100);
  value.add(0x110).writePointer(ranges); value.add(0x118).writeU64(2); testRefs.push(ranges);
  return value;
}
rpc.exports.section = (strictMode, start, end) => {
  settings.lexiconStrict = strictMode;
  const value = sectionedChart([8], start, end), before = allocations.size;
  const problem = chartProblem(value, 0, 0, 0);
  const play = Memory.alloc(0x620), chooser = Memory.alloc(8), selection = Memory.alloc(0x6e0);
  play.writeByteArray(new Uint8Array(0x620)); selection.writeByteArray(new Uint8Array(0x6e0));
  play.add(0x2d8).writeByteArray(value.readByteArray(0x140)); chooser.writeU64(1);
  const context = {rdi: play, rbp: selection, rsi: ptr(0), r12: chooser, rip: ptr(0x1400eb3da)};
  callbacks.get(practiceGate.toString()).call({context});
  return {problem, refused: practiceRefused.readU8(), chooser: chooser.readU64().toNumber(), leak: allocations.size - before};
};
rpc.exports.practice = (exact, strictMode, mixed = false) => {
  const dictionary = {name: 'fragments', alphabet: 'xy', words: {}, splits: {}};
  for (let n = 1; n <= 8; n++) dictionary.words[n] = [];
  dictionary.words[2] = ['xy']; dictionary.words[3] = ['xyx'];
  Object.assign(dictionary.splits, {1:null, 2:[2], 3:[3], 4:[2,2], 5:[3,2], 6:[3,3], 7:[3,2,2], 8:[3,3,2]});
  useDictionary(dictionary); settings.lexiconStrict = strictMode;
  const vocabularyBefore = Array.from({length: 8}, (_, i) => VOCABULARY.add(16*i).readPointer().toString());
  const values = mixed ? ['xxx', 'xy', 'xxxxx'] : exact ? ['xy', 'xyx'] : ['xxxxx', 'xy', 'yyyyy'];
  const output = wordVec(values), play = Memory.alloc(0x620), count = values.reduce((n, word) => n + word.length, 0);
  play.writeByteArray(new Uint8Array(0x620)); play.add(0x438).writeByteArray(output.readByteArray(24));
  const notes = alloc(count * 56), effects = alloc(16 * values.length), starts = [];
  let offset = 0;
  values.forEach((word, i) => {
    starts.push(offset); effects.add(16*i).writeU64(i+11); effects.add(16*i+8).writeU64(i+21);
    for (const character of word) {
      const note = notes.add(56*offset++), code = character.charCodeAt(0);
      note.add(0x20).writeU64(i); note.add(0x28).writeU32(code); note.add(8).writeU64(code%4);
    }
  });
  play.add(0x428).writePointer(notes); play.add(0x430).writeU64(count);
  play.add(0x450).writeU64(values.length); play.add(0x458).writePointer(effects); play.add(0x460).writeU64(values.length);
  vec(play.add(0x468), starts, (p,v) => p.writeU64(v));
  const original = [0x440, 0x458, 0x470].map(n => play.add(n).readPointer().toString());
  const middlePointer = output.add(8).readPointer().add(24*(exact ? 0 : 1)+8).readPointer().toString();
  const invocation = {returnAddress: at(0x14002c40c)}, callback = hook(0x140029000);
  callback.onEnter.call(invocation, [play]); callback.onLeave.call(invocation);
  const result = {words: readWords(play.add(0x438)), starts: [], effects: [], indices: [], characters: '', lanes: [],
    sameVectors: original.every((p,i) => play.add([0x440,0x458,0x470][i]).readPointer().toString() === p),
    middleRetained: play.add(0x440).readPointer().add(24*(exact ? 0 : mixed ? 1 : 2)+8).readPointer().toString() === middlePointer,
    cacheUnchanged: vocabularyBefore.every((p,i) => VOCABULARY.add(16*i).readPointer().toString() === p)};
  for (let i = 0; i < play.add(0x448).readU64().toNumber(); i++) {
    result.starts.push(play.add(0x470).readPointer().add(8*i).readU64().toNumber());
    result.effects.push([play.add(0x458).readPointer().add(16*i).readU64().toNumber(), play.add(0x458).readPointer().add(16*i+8).readU64().toNumber()]);
  }
  for (let i = 0; i < count; i++) {
    result.indices.push(notes.add(56*i+0x20).readU64().toNumber());
    result.characters += String.fromCharCode(notes.add(56*i+0x28).readU32());
    result.lanes.push(notes.add(56*i+8).readU64().toNumber());
  }
  freeWords(play.add(0x438)); freeVec(play.add(0x450)); freeVec(play.add(0x468)); free(notes);
  result.remainingAllocations = allocations.size;
  return result;
};

rpc.exports.nativegate = (strictMode, start, end) => {
  settings.lexiconStrict = strictMode;
  const value = sectionedChart([8], start, end), play = Memory.alloc(0x620), selection = Memory.alloc(0x6e0);
  play.writeByteArray(new Uint8Array(0x620)); selection.writeByteArray(new Uint8Array(0x6e0));
  play.add(0x2d8).writeByteArray(value.readByteArray(0x140));
  const chooser = Memory.alloc(8); chooser.writeU64(1);
  const context = {rdi: play, rbp: selection, rsi: ptr(0)};
  const callback = callbacks.get(practiceGate.toString());
  const before = allocations.size;
  const mockedInterceptor = Interceptor; Interceptor = realInterceptor;
  const listener = realInterceptor.attach(practiceGate, function () { callback.call({context}); });
  realInterceptor.flush();
  try {
    const execute = new realNativeFunction(nativeFixture, 'int', ['pointer']);
    const result = execute(chooser);
    return {result, chooser: chooser.readU64().toNumber(), refused: practiceRefused.readU8(), leak: allocations.size - before};
  } finally { listener.detach(); realInterceptor.flush(); Interceptor = mockedInterceptor; }
};

'''


class LexiconRuntimeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.child = subprocess.Popen(
            [sys.executable, '-c', 'import time; time.sleep(120)'],
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        cls.session = None
        try:
            cls.session = frida.attach(cls.child.pid)
            source = (Path(__file__).resolve().parents[1] / 'mods/lexicon/lexicon.js').read_text(encoding='utf-8')
            cls.script = cls.session.create_script(SETUP + source + PROBE)
            messages = []
            cls.script.on('message', lambda message, data: messages.append(message))
            cls.script.load()
            errors = [m for m in messages if m['type'] == 'error']
            if errors:
                raise AssertionError(errors)
            cls.api = cls.script.exports_sync
        except Exception:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls):
        try:
            if cls.session is not None:
                cls.session.detach()
        finally:
            cls.child.terminate()
            cls.child.wait()

    def setUp(self):
        words = lexicon.parse('[xy]\nxyx\nxyxyx')
        self.api.setup({'name': 'sparse', 'alphabet': 'xy', 'words': words, 'splits': lexicon.splits(words)})

    def test_strict_defaults_on_and_toggle_saves(self):
        self.assertEqual(self.api.strictsettings(), {
            'initial': 'ON', 'off': ['OFF', False], 'on': ['ON', True], 'saved': 2,
        })

    def test_implicit_generation_only_for_missing_lengths(self):
        first = self.api.generate(False, '0x123456789abcdef', 0)
        second = self.api.generate(False, '0x123456789abcdef', 0)
        self.assertEqual(first, second)
        self.assertEqual(first['words'][1:3], ['xxx', 'xxxxx'])
        for word, length in zip(first['words'], [2, 3, 5, 8]):
            self.assertEqual(len(word), length)
            self.assertLessEqual(set(word), {'x', 'y'})
        self.assertEqual(first['title'], 0)
        self.assertEqual(first['allocations'], 0)
        self.assertEqual(self.api.generate(True, '0x123', 0)['words'], ['xx', 'xxx', 'xxxxx', 'xxxxxxxx'])
        self.assertEqual(self.api.generate(False, '0x123', 2)['title'], 1)

    def test_strict_planner_splits_supported_lengths(self):
        self.assertEqual(self.api.plan(True, [8, 6]), {
            'lengths': [5, 3, 3, 3], 'pressures': [0.75] * 4,
        })
        self.assertEqual(self.api.plan(True, [7])['lengths'], [7])
        self.assertEqual(self.api.plan(False, [8])['lengths'], [8])

    def test_preflight_rejects_gaps_and_frees_all_temporary_vectors(self):
        self.assertEqual(self.api.problem(True, [8, 6]), {'problem': None, 'leak': 0})
        rejected = self.api.problem(True, [7])
        self.assertIn('7-note', rejected['problem'])
        self.assertEqual(rejected['leak'], 0)
        self.assertEqual(self.api.problem(False, [7]), {'problem': None, 'leak': 0})

    def test_load_result_reports_error_and_releases_loaded_song(self):
        rejected = self.api.loadresult(True, 0, [7], False, None)
        self.assertTrue(rejected['rejected'])
        self.assertTrue(rejected['chartFreed'])
        self.assertEqual(rejected['drops'], 1)
        self.assertIn('LEXICON strict', rejected['error'])
        self.assertEqual(int(rejected['errorCapacity'], 16), rejected['errorLength'] + 1)
        self.assertEqual(rejected['leak'], 0)
        for strict_mode, mode, lengths, already_error in [(True, 2, [7], False), (False, 0, [7], False), (True, 0, [8], False), (True, 0, [7], True)]:
            with self.subTest(strict=strict_mode, mode=mode, lengths=lengths, already_error=already_error):
                self.setUp()
                accepted = self.api.loadresult(strict_mode, mode, lengths, already_error, None)
                self.assertFalse(accepted['rejected'])
                self.assertFalse(accepted['chartFreed'])
                self.assertEqual(accepted['drops'], 0)
                self.assertEqual(accepted['leak'], 0)


    def test_practice_section_is_blocked_before_native_restart(self):
        invalid = self.api.section(True, 1, 3)
        self.assertIn('section leaves a 2-note', invalid['problem'])
        self.assertEqual(invalid['refused'], 1)
        self.assertEqual(invalid['chooser'], 1)
        self.assertEqual(invalid['leak'], 0)
        for strict_mode, start, end in [(False, 1, 3), (True, 1, 4)]:
            valid = self.api.section(strict_mode, start, end)
            self.assertIsNone(valid['problem'])
            self.assertEqual(valid['chooser'], 1)
            self.assertEqual(valid['refused'], 0)
            self.assertEqual(valid['leak'], 0)

    def test_practice_fragments_rebuild_words_notes_starts_and_effects(self):
        result = self.api.practice(False, True, False)
        self.assertEqual(result['words'], ['xyx', 'xy', 'xy', 'xyx', 'xy'])
        self.assertEqual(result['starts'], [0, 3, 5, 7, 10])
        self.assertEqual(result['effects'], [[11, 21], [11, 21], [12, 22], [13, 23], [13, 23]])
        self.assertEqual(result['indices'], [0, 0, 0, 1, 1, 2, 2, 3, 3, 3, 4, 4])
        self.assertEqual(result['characters'], ''.join(result['words']))
        self.assertEqual(result['lanes'], [ord(c) % 4 for c in result['characters']])
        self.assertTrue(result['middleRetained'])
        self.assertTrue(result['cacheUnchanged'])
        self.assertEqual(result['remainingAllocations'], 0)

    def test_explicit_practice_words_keep_existing_allocations(self):
        result = self.api.practice(True, True, False)
        self.assertEqual(result['words'], ['xy', 'xyx'])
        self.assertEqual(result['starts'], [0, 2])
        self.assertTrue(result['sameVectors'])
        self.assertTrue(result['middleRetained'])
        self.assertTrue(result['cacheUnchanged'])
        self.assertEqual(result['remainingAllocations'], 0)


    def test_real_native_gate_selects_path_and_preserves_carry(self):
        for strict_mode, start, end, refused, result in [(True, 1, 3, 1, 8), (True, 1, 4, 0, 2), (False, 1, 3, 0, 2)]:
            with self.subTest(strict=strict_mode, start=start, end=end):
                self.assertEqual(self.api.nativegate(strict_mode, start, end), {
                    'result': result, 'chooser': 2, 'refused': refused, 'leak': 0,
                })

    def test_nonstrict_practice_prefers_explicit_words_but_keeps_implicit_gaps(self):
        result = self.api.practice(False, False, True)
        self.assertEqual(result['words'], ['xyx', 'xy', 'xxxxx'])
        self.assertEqual(result['starts'], [0, 3, 5])
        self.assertEqual(result['effects'], [[11, 21], [12, 22], [13, 23]])
        self.assertEqual(result['characters'], 'xyxxyxxxxx')
        self.assertTrue(result['middleRetained'])
        self.assertTrue(result['cacheUnchanged'])
        self.assertEqual(result['remainingAllocations'], 0)


    def test_initial_saved_practice_range_is_validated_before_song_is_owned(self):
        rejected = self.api.loadresult(True, 0, [8], False, [0, 4])
        self.assertTrue(rejected['rejected'])
        self.assertTrue(rejected['chartFreed'])
        self.assertEqual(rejected['drops'], 1)
        self.assertIn('section leaves a 4-note', rejected['error'])
        self.assertEqual(rejected['leak'], 0)
        self.setUp()
        accepted = self.api.loadresult(True, 0, [8], False, [1, 4])
        self.assertFalse(accepted['rejected'])
        self.assertFalse(accepted['chartFreed'])
        self.assertEqual(accepted['drops'], 0)
        self.assertEqual(accepted['leak'], 0)


if __name__ == '__main__':
    unittest.main()
