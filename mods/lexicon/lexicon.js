// Lexicon: the game draws its words from a player-supplied dictionary (file format in __init__.py).
// Appended after hero_tab.js, whose helpers (at, settings, save, registerMod) it uses.

// The WORDS modes read the vocabulary only through this table: one { &[&str], count } per word length 1-8.
const VOCABULARY = at(0x140548460);
Memory.protect(VOCABULARY, 8 * 16, 'rw-');
const gameVocabulary = [...Array(8).keys()].map(i => [VOCABULARY.add(16 * i).readPointer(), VOCABULARY.add(16 * i + 8).readU64()]);
const dictionaryVocabulary = new Map(); // kept for the whole session: the game may still hold old pointers

let dictionaries = [], active = null, practiceError = null; // active: the dictionary in use, null for the game's own words
function useDictionary(dictionary) {
  let vocabulary = dictionary ? dictionaryVocabulary.get(dictionary) : gameVocabulary;
  if (!vocabulary) {
    vocabulary = Array.from({ length: 8 }, (_, i) => {
      // The game reads every group. These placeholders are replaced or excluded before play.
      const words = dictionary.words[i + 1].length ? dictionary.words[i + 1] : [dictionary.alphabet[0].repeat(i + 1)];
      const count = words.length, length = i + 1;
      const array = Memory.alloc(count * (16 + length) + 1);
      const strings = array.add(16 * count);
      strings.writeUtf8String(words.join(''));
      // Pack the Rust &str table in JS, then copy it in one native write.
      const table = new ArrayBuffer(16 * count), view = new DataView(table);
      let address = BigInt(strings.toString());
      const size = BigInt(length);
      for (let j = 0; j < count; j++, address += size) {
        view.setBigUint64(16 * j, address, true);
        view.setBigUint64(16 * j + 8, size, true);
      }
      array.writeByteArray(table);
      return [array, count];
    });
    dictionaryVocabulary.set(dictionary, vocabulary);
  }
  for (let i = 0; i < 8; i++) {
    const [array, count] = vocabulary[i];
    VOCABULARY.add(16 * i).writePointer(array);
    VOCABULARY.add(16 * i + 8).writeU64(count);
  }
  active = dictionary;
  practiceError = null;
}

const strict = () => settings.lexiconStrict ?? true;

const usable = () => [null, ...dictionaries.filter(d => d.words)];

// plan_phrases(out, notes, n, beats, beat_count) fills out with Vec<usize> phrase lengths (1-8, summing to the
// note count) at +0x00 and Vec<f64> mean pressure per phrase at +0x18. Both new_chart and practice restarts call it.
const kernel32 = Process.getModuleByName('kernel32.dll');
const heap = new NativeFunction(kernel32.getExportByName('GetProcessHeap'), 'pointer', [])();
const heapAlloc = new NativeFunction(kernel32.getExportByName('HeapAlloc'), 'pointer', ['pointer', 'uint32', 'size_t']);
const heapFree = new NativeFunction(kernel32.getExportByName('HeapFree'), 'int', ['pointer', 'uint32', 'pointer']);

// Replaces a game Vec; the game's allocator (the process heap) frees its buffer later.
function replaceVec(vec, values, write, stride = 8) {
  const buffer = heapAlloc(heap, 0, stride * values.length);
  if (buffer.isNull()) throw new Error('Lexicon: out of memory');
  values.forEach((value, i) => write(buffer.add(stride * i), value));
  if (vec.readU64() > 0) heapFree(heap, 0, vec.add(8).readPointer());
  vec.writeU64(values.length);
  vec.add(8).writePointer(buffer);
  vec.add(16).writeU64(values.length);
}

// Preflight uses the original planner and frees its temporary Rust vectors.
const planPhrases = new NativeFunction(at(0x14001af00), 'void', ['pointer', 'pointer', 'uint64', 'pointer', 'uint64']);
const runOptions = new NativeFunction(at(0x1401275f0), 'void', ['pointer', 'pointer']);
const dropLoadedSong = new NativeFunction(at(0x140154f50), 'void', ['pointer']);
const laneOf = new NativeFunction(at(0x140123800), 'uint64', ['uint8', 'uint32']);
let checkingPlan = false, wordMode = false;

function chartProblem(chart, difficulty, first = null, last = null) {
  if (!active || !strict()) return null;
  const count = chart.add(0x40 + 24 * difficulty).readU64().toNumber();
  const notes = chart.add(0x38 + 24 * difficulty).readPointer(), plan = Memory.alloc(0x48);
  plan.writeByteArray(new Uint8Array(0x48));
  let start = -Infinity, end = Infinity;
  const sections = chart.add(0x118).readU64().toNumber();
  if (first !== null && sections) {
    const range = chart.add(0x110).readPointer();
    const from = Math.min(first, sections - 1), to = Math.min(last < from ? first : last, sections - 1);
    start = range.add(40 * from + 24).readDouble() - 1e-6;
    if (to + 1 < sections) end = range.add(40 * to + 32).readDouble() - 1e-6;
  }
  checkingPlan = true;
  try {
    planPhrases(plan, notes, count, chart.add(0xf8).readPointer(), chart.add(0x100).readU64());
    let offset = 0;
    const lengths = plan.add(8).readPointer(), phrases = plan.add(16).readU64().toNumber();
    for (let i = 0; i < phrases; i++) {
      const length = lengths.add(8 * i).readU64().toNumber(), parts = active.splits[length];
      if (!parts) return 'LEXICON strict: cannot fill a ' + length + '-note phrase with listed words';
      for (const part of parts) {
        let kept = 0;
        for (let j = 0; j < part; j++) {
          const time = notes.add(16 * (offset + j)).readDouble();
          if (time >= start && time < end) kept++;
        }
        if (kept && !active.splits[kept])
          return 'LEXICON strict: section leaves a ' + kept + '-note word with no listed match';
        offset += part;
      }
    }
    return null;
  } finally {
    checkingPlan = false;
    for (let i = 0; i < 3; i++) {
      const vec = plan.add(24 * i);
      if (vec.readU64().compare(0) > 0) heapFree(heap, 0, vec.add(8).readPointer());
    }
  }
}

// Convert the completed song-load result to its usual error variant, before new_chart takes ownership.
Interceptor.attach(at(0x140063231), function () {
  const c = this.context, state = c.rbx;
  if (!active || !strict() || c.r9.toString() !== '0x8000000000000000') return;
  if (state.add(0x1c0).readU64().compare(2) !== 0 || state.add(0xd8).readPointer().add(0xd38).readU8()) return;
  const options = Memory.alloc(0x60);
  let reason;
  try {
    runOptions(options, state.add(0x108).readPointer());
    if (options.add(0x4f).readU8() > 1) return;
    let difficulty = Math.min(state.add(0x258).readU64().toNumber(), 3);
    if (c.r13.add(0x40 + 24 * difficulty).readU64().compare(20) < 0) {
      const available = [3, 2, 1, 0].find(d => c.r13.add(0x40 + 24 * d).readU64().compare(20) >= 0);
      if (available !== undefined) difficulty = available;
    }
    const range = state.add(0xc70), practice = range.readU32() === 1;
    reason = chartProblem(c.r13, difficulty, practice ? range.add(8).readU64().toNumber() : null,
      practice ? range.add(16).readU64().toNumber() : null);
  } catch (error) { console.error(error.stack); reason = 'LEXICON strict: could not validate this chart'; }
  if (!reason) return;
  const error = heapAlloc(heap, 0, reason.length + 1);
  if (error.isNull()) throw new Error('Lexicon: out of memory');
  error.writeUtf8String(reason);
  dropLoadedSong(c.r13);
  heapFree(heap, 0, c.r13);
  c.r9 = ptr(reason.length + 1);
  c.r13 = error;
  c.rdi = ptr(reason.length);
});

Interceptor.attach(at(0x14001af00), {
  onEnter(args) { this.plan = args[0]; },
  onLeave() {
    if (!active || !strict() || !wordMode || checkingPlan) return;
    const plan = this.plan, count = plan.add(16).readU64().toNumber(), lengths = [], pressures = [];
    for (let i = 0; i < count; i++) {
      const parts = active.splits[plan.add(8).readPointer().add(8 * i).readU64().toNumber()];
      if (!parts) return; // preflight rejects this chart; practice regeneration uses its existing word lengths
      const pressure = plan.add(0x20).readPointer().add(8 * i).readDouble();
      for (const part of parts) { lengths.push(part); pressures.push(pressure); }
    }
    if (lengths.length === count) return;
    replaceVec(plan, lengths, (p, v) => p.writeU64(v));
    replaceVec(plan.add(0x18), pressures, (p, v) => p.writeDouble(v));
  },
});

function replaceWord(entry, word) {
  const buffer = heapAlloc(heap, 0, word.length);
  if (buffer.isNull()) throw new Error('Lexicon: out of memory');
  buffer.writeByteArray([...word].map(c => c.charCodeAt(0)));
  if (entry.readU64().compare(0) > 0) heapFree(heap, 0, entry.add(8).readPointer());
  entry.writeU64(word.length);
  entry.add(8).writePointer(buffer);
  entry.add(16).writeU64(word.length);
}

// Keep native selection for explicit words; generate missing lengths directly from the chart's seed.
Interceptor.attach(at(0x1400f9760), {
  onEnter(args) {
    if (!active || args[5].toInt32() > 1) return;
    this.output = args[0];
    this.random = BigInt(args[8].toString()) || 0x9e3779b97f4a7c15n;
    args[10] = ptr(0); // title/lyric impacts can bypass the selected vocabulary
  },
  onLeave() {
    if (!this.output || strict()) return;
    const words = this.output.add(8).readPointer(), count = this.output.add(16).readU64().toNumber();
    for (let i = 0; i < count; i++) {
      const entry = words.add(24 * i), length = entry.add(16).readU64().toNumber();
      if (active.words[length].length) continue;
      let word = '';
      for (let j = 0; j < length; j++) {
        this.random = BigInt.asUintN(64, this.random ^ (this.random << 13n));
        this.random ^= this.random >> 7n;
        this.random = BigInt.asUintN(64, this.random ^ (this.random << 17n));
        word += active.alphabet[Number(this.random % BigInt(active.alphabet.length))];
      }
      replaceWord(entry, word);
    }
  },
});

// Section boundaries can cut a word. Preserve explicit-word priority when rebuilding fragments.
function repairFragments(play) {
  const words = play.add(0x440).readPointer(), count = play.add(0x448).readU64().toNumber();
  const records = [], discarded = [];
  for (let i = 0; i < count; i++) {
    const entry = words.add(24 * i), length = entry.add(16).readU64().toNumber();
    if ((i === 0 || i === count - 1) && (strict() || active.words[length].length)
        && !active.words[length].includes(entry.add(8).readPointer().readUtf8String(length))) {
      const parts = strict() ? active.splits[length] : [length];
      if (!parts) throw new Error('Lexicon: practice preflight missed an unavailable word length');
      if (entry.readU64().compare(0) > 0) discarded.push(entry.add(8).readPointer());
      for (const part of parts) records.push({ source: i, word: active.words[part][0], length: part });
    } else records.push({ source: i, word: null, length });
  }
  if (!discarded.length) return;
  const starts = [], notes = play.add(0x428).readPointer(), layout = play.add(0x60e).readU8();
  let offset = 0;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    starts.push(offset);
    for (let j = 0; j < record.length; j++) {
      const note = notes.add(56 * offset++);
      note.add(0x20).writeU64(i);
      if (record.word !== null) {
        const character = record.word.charCodeAt(j);
        note.add(0x28).writeU32(character);
        note.add(8).writeU64(laneOf(layout, character));
      }
    }
  }
  if (offset !== play.add(0x430).readU64().toNumber()) throw new Error('Lexicon: word lengths do not match notes');
  const effects = play.add(0x458).readPointer();
  replaceVec(play.add(0x450), records, (p, r) => p.writeByteArray(effects.add(16 * r.source).readByteArray(16)), 16);
  replaceVec(play.add(0x468), starts, (p, v) => p.writeU64(v));
  replaceVec(play.add(0x438), records, (p, r) => {
    if (r.word === null) p.writeByteArray(words.add(24 * r.source).readByteArray(24));
    else { p.writeByteArray(new Uint8Array(24)); replaceWord(p, r.word); }
  }, 24);
  for (const string of discarded) heapFree(heap, 0, string);
}

Interceptor.attach(at(0x140029e20), {
  onEnter(args) { wordMode = args[1].add(0x7f).readU8() <= 1; practiceError = null; },
});
// from_parts returns a complete Play before new_chart initializes the practice timeline.
Interceptor.attach(at(0x140029000), {
  onEnter(args) { this.play = args[0]; this.chart = this.returnAddress.equals(at(0x14002c40c)); },
  onLeave() { if (active && this.chart && this.play.add(0x60f).readU8() <= 1) repairFragments(this.play); },
});
Interceptor.attach(at(0x14003ba40), { onEnter(args) { wordMode = args[0].add(0x60f).readU8() <= 1; } });

// A native branch is needed: Interceptor instruction callbacks cannot redirect RIP.
const practiceRefused = Memory.alloc(1), practiceStart = at(0x1400eb3da);
const practiceGate = Memory.alloc(Process.pageSize, { near: practiceStart, maxDistance: 0x7fffffff });
const closeChooser = [0x49, 0xc7, 0x04, 0x24, 2, 0, 0, 0]; // mov qword [r12], 2
if (!new Uint8Array(practiceStart.readByteArray(8)).every((byte, i) => byte === closeChooser[i]))
  throw new Error('Lexicon: unexpected practice-start instructions');
Memory.protect(practiceGate, Process.pageSize, 'rwx');
Memory.patchCode(practiceGate, 128, code => {
  const writer = new X86Writer(code, { pc: practiceGate });
  for (let i = 0; i < 16; i++) writer.putNop(); // room for the instruction probe
  writer.putBytes([0x9c]); // pushfq
  writer.putPushReg('rax');
  writer.putMovRegAddress('rax', practiceRefused);
  writer.putBytes([0x80, 0x38, 0]); // cmp byte [rax], 0
  writer.putPopReg('rax');
  writer.putJccShortLabel('je', 'start', 'no-hint');
  writer.putBytes([0x9d, ...closeChooser]); // popfq; original instruction
  writer.putJmpAddress(at(0x1400eb5b0));
  writer.putLabel('start');
  writer.putBytes([0x9d, ...closeChooser]);
  writer.putJmpAddress(at(0x1400eb3e2));
  writer.flush();
});
Interceptor.attach(practiceGate, function () {
  const c = this.context, play = c.rdi;
  practiceError = null;
  practiceRefused.writeU8(0);
  if (!active || !strict() || play.add(0x60f).readU8() > 1) return;
  practiceRefused.writeU8(1);
  let reason;
  try {
    reason = chartProblem(play.add(0x2d8), play.add(0x5b0).readU64().toNumber(),
      c.rbp.add(0x6d8).readU64().toNumber(), c.rsi.toUInt32());
  } catch (error) { console.error(error.stack); reason = 'LEXICON strict: could not validate this section'; }
  if (!reason) { practiceRefused.writeU8(0); return; }
  practiceError = reason;
});
Memory.patchCode(practiceStart, 8, code => {
  const writer = new X86Writer(code, { pc: practiceStart });
  writer.putJmpAddress(practiceGate);
  while (writer.offset < 8) writer.putNop();
  writer.flush();
});
Interceptor.attach(at(0x1400ea2f0), {
  onLeave() {
    if (practiceError) drawPanel([[practiceError + ' - choose another section or leave practice', 17, RED, 0]], 20);
  },
});

// Called by heroloader.py with lexicon.load(): valid dictionaries include alphabet, words and splits.
rpc.exports.lexicon = loaded => {
  dictionaries = loaded;
  const saved = dictionaries.find(d => d.name === settings.lexicon && d.words);
  if (saved) useDictionary(saved);
};

registerMod({
  name: 'Lexicon',
  description: 'play with words from your own dictionary',
  rows: [{
    label: 'dictionary',
    value: () => active?.name ?? (settings.lexicon ? `${settings.lexicon} (missing or invalid)` : 'GAME WORDS'),
    change: step => {
      const choices = usable();
      const next = choices[(choices.indexOf(active) + step + choices.length) % choices.length];
      useDictionary(next);
      if (next) settings.lexicon = next.name;
      else delete settings.lexicon;
      save();
    },
  }, {
    label: 'strict mode',
    value: () => strict() ? 'ON' : 'OFF',
    change: () => { settings.lexiconStrict = !strict(); practiceError = null; save(); },
  }],
  notes: () => [
    ...dictionaries.filter(d => d.error).map(d => `${d.name}.txt: ${d.error}`),
    ...(dictionaries.length ? [] : ['no dictionaries in %APPDATA%\\heroloader\\dictionaries']),
  ],
  // The saved dictionary disappeared or became invalid: never fall back to the game's words silently.
  blocked: () => settings.lexicon && !active ? `LEXICON: dictionary "${settings.lexicon}" is missing or invalid` : null,
});
