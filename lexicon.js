// Lexicon: the game draws its words from a player-supplied dictionary (file format in lexicon.py).
// Appended after hero_tab.js, whose helpers (at, settings, save, registerMod) it uses.

// The WORDS modes read the vocabulary only through this table: one { &[&str], count } per word length 1-8.
const VOCABULARY = at(0x140548460);
Memory.protect(VOCABULARY, 8 * 16, 'rw-');
const gameVocabulary = [...Array(8).keys()].map(i => [VOCABULARY.add(16 * i).readPointer(), VOCABULARY.add(16 * i + 8).readU64()]);
const lexiconMemory = []; // kept for the whole session: the game may still hold pointers into old dictionaries

let dictionaries = [], active = null; // active: the dictionary in use, null for the game's own words
function useDictionary(dictionary) {
  active = dictionary;
  for (let i = 0; i < 8; i++) {
    let [array, count] = gameVocabulary[i];
    if (dictionary) {
      // Every length must have a word or the game crashes. Phrases are split so that only lengths with
      // words are asked for. ponytail: practice-section fragments in WORDS mode could still show this filler.
      const words = dictionary.words[i + 1].length ? dictionary.words[i + 1] : [dictionary.words[1][0].repeat(i + 1)];
      array = Memory.alloc(16 * words.length);
      words.forEach((word, j) => {
        const string = Memory.allocUtf8String(word);
        lexiconMemory.push(string);
        array.add(16 * j).writePointer(string);
        array.add(16 * j + 8).writeU64(word.length);
      });
      lexiconMemory.push(array);
      count = words.length;
    }
    VOCABULARY.add(16 * i).writePointer(array);
    VOCABULARY.add(16 * i + 8).writeU64(count);
  }
}

const usable = () => [null, ...dictionaries.filter(d => d.words)];

// plan_phrases(out, notes, n, beats, beat_count) fills out with Vec<usize> phrase lengths (1-8, summing to the
// note count) at +0x00 and Vec<f64> mean pressure per phrase at +0x18. Both new_chart and practice restarts call it.
const kernel32 = Process.getModuleByName('kernel32.dll');
const heap = new NativeFunction(kernel32.getExportByName('GetProcessHeap'), 'pointer', [])();
const heapAlloc = new NativeFunction(kernel32.getExportByName('HeapAlloc'), 'pointer', ['pointer', 'uint32', 'size_t']);
const heapFree = new NativeFunction(kernel32.getExportByName('HeapFree'), 'int', ['pointer', 'uint32', 'pointer']);

// Replaces a game Vec of 8-byte values; the game's allocator (the process heap) frees it later.
function replaceVec(vec, values, write) {
  const buffer = heapAlloc(heap, 0, 8 * values.length);
  if (buffer.isNull()) throw new Error('Lexicon: out of memory');
  values.forEach((value, i) => write(buffer.add(8 * i), value));
  if (vec.readU64() > 0) heapFree(heap, 0, vec.add(8).readPointer());
  vec.writeU64(values.length);
  vec.add(8).writePointer(buffer);
  vec.add(16).writeU64(values.length);
}

Interceptor.attach(at(0x14001af00), {
  onEnter(args) { this.plan = args[0]; },
  onLeave() {
    if (!active) return;
    const plan = this.plan, count = plan.add(16).readU64().toNumber(), lengths = [], pressures = [];
    for (let i = 0; i < count; i++) {
      const pressure = plan.add(0x20).readPointer().add(8 * i).readDouble(); // a part keeps its phrase's pressure
      for (const part of active.splits[plan.add(8).readPointer().add(8 * i).readU64().toNumber()]) {
        lengths.push(part);
        pressures.push(pressure);
      }
    }
    if (lengths.length === count) return; // every length already has words
    replaceVec(plan, lengths, (p, v) => p.writeU64(v));
    replaceVec(plan.add(0x18), pressures, (p, v) => p.writeDouble(v));
  },
});

// Impact words (song title words, an easter egg) reach the generator without the vocabulary table, so they are
// dropped: generate_text_with_pressure's 11th argument is the impact count, and 0 is its usual no-impact path.
Interceptor.attach(at(0x1400f9760), { onEnter(args) { if (active) args[10] = ptr(0); } });

// Called by heroloader.py with lexicon.load(): [{ name, words: { length: [word] }, splits: { length: [part] } } | { name, error }].
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
  }],
  notes: () => [
    ...dictionaries.filter(d => d.error).map(d => `${d.name}.txt: ${d.error}`),
    ...(dictionaries.length ? [] : ['no dictionaries in %APPDATA%\\heroloader\\dictionaries']),
  ],
  // The saved dictionary disappeared or became invalid: never fall back to the game's words silently.
  blocked: () => settings.lexicon && !active ? `LEXICON: dictionary "${settings.lexicon}" is missing or invalid` : null,
});
