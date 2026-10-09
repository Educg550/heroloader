// HeroLoader's in-game UI. Adds a HEROLOADER tab to the options screen (a "remove ligatures" toggle,
// which hides the line linking the letters of a word, and the key that opens the mod window) and a
// floating mod window over the song list, where registered mods show their settings.
// Addresses target Keyboard Warrior 2.0.0 for Windows x86_64 (preferred image base 0x140000000).
const exe = Process.getModuleByName('keyboardwarrior.exe');
const at = va => exe.base.add(va - 0x140000000);

// Alpha of the colour shared by the gameplay highway and the options preview to draw ligatures.
const ligatureAlpha = at(0x14051d6ac);
if (at(0x140599952).readUtf8String(6) !== 'v2.0.0' || Math.abs(ligatureAlpha.readFloat() - 0.13) > 1e-6)
  throw new Error('hero_tab.js supports only Keyboard Warrior 2.0.0 for Windows x86_64');
const ligatureAlphaShown = ligatureAlpha.readFloat();
Memory.protect(ligatureAlpha, 4, 'rw-');

const fn = (va, ret, args) => new NativeFunction(at(va), ret, args);
const measureText = fn(0x140023100, 'void', ['pointer', 'pointer', 'uint64', 'float']); // (out, text, len, size)
const drawText = fn(0x140022c90, 'void', ['pointer', 'uint64', 'float', 'float', 'float', 'pointer']); // (text, len, x, y, size, color)
const drawLine = fn(0x140229b00, 'void', ['float', 'float', 'float', 'float', 'float', 'pointer']);
const drawRectangle = fn(0x140229140, 'void', ['float', 'float', 'float', 'float', 'pointer']);
const dpiScale = fn(0x1402502f0, 'float', []);
const drawOptionRows = fn(0x1400d6230, 'void', ['pointer', 'pointer', 'pointer', 'pointer']); // (row, settings, tab, _)

const user32 = Process.getModuleByName('user32.dll');
const getKeyName = new NativeFunction(user32.getExportByName('GetKeyNameTextW'), 'int', ['int32', 'pointer', 'int']);
const keyChar = new NativeFunction(user32.getExportByName('MapVirtualKeyW'), 'uint', ['uint', 'uint']);

const rgba = (...c) => { const p = Memory.alloc(16); c.forEach((v, i) => p.add(4 * i).writeFloat(v)); return p; };
const WHITE = rgba(1, 1, 1, 0.95), DIM = rgba(1, 1, 1, 0.62), FAINT = rgba(1, 1, 1, 0.3), GREY = rgba(0.64, 0.7, 0.78, 0.75);
const ORANGE = rgba(0.99, 0.72, 0.25, 0.95), DIM_ORANGE = rgba(0.99, 0.72, 0.25, 0.6), RED = rgba(0.94, 0.33, 0.25, 1);
const PANEL = rgba(0.043, 0.045, 0.052, 1);
const BACKGROUND = at(0x14052330c);

// ponytail: the game font is ASCII only, so accents (key names, file names) are shown as '?'.
const text = s => { const ascii = s.replace(/[^\x20-\x7e]/g, '?'); return { ptr: Memory.allocUtf8String(ascii), len: ascii.length }; };
const labels = new Map(); // text for strings built at runtime, allocated once each
const label = s => labels.get(s) ?? labels.set(s, text(s)).get(s);
const gameText = (va, len) => ({ ptr: at(va), len });
const TITLE = gameText(0x14063df10, 7), VERSION = gameText(0x140599952, 6);
const TABS = [gameText(0x14059962b, 8), gameText(0x140599633, 7), gameText(0x14059963a, 5), gameText(0x14059963f, 12), text('HEROLOADER')];
const HERO = 4, TAB_OF = { 0: 0, 3: 1, 2: 2, 1: 3 }; // game tab value -> TABS index; 0 is GAMEPLAY
const LEFT = text('<'), RIGHT = text('>'), ON = text('ON'), OFF = text('OFF'), WAITING = text('PRESS A KEY');
const ROWS = [
  { label: text('remove ligatures'), hint: text('hide the line linking the letters of a word') },
  { label: text('mod window key'), hint: text('opens the mod list - ENTER to change') },
];
const CAPTURE_HINT = text('press the new key - ESC to cancel');

// Saved in %APPDATA%\heroloader\settings.json; init() is called by heroloader.py before the game starts.
const settings = { removeLigatures: false, modWindowKey: { vk: 0x09, name: 'TAB' } };
let settingsPath = null, keyText = text(settings.modWindowKey.name);
rpc.exports.init = (path, saved) => {
  settingsPath = path;
  Object.assign(settings, JSON.parse(saved));
  keyText = text(settings.modWindowKey.name);
  setLigaturesRemoved(settings.removeLigatures);
};
const save = () => {
  // Frida 17.23.0 writeAllText leaves stale bytes when the new JSON is shorter.
  const file = new File(settingsPath, 'w');
  try { file.write(JSON.stringify(settings, null, 2)); }
  finally { file.close(); }
};

// Mods appended after this file register here to appear in the mod window. Provisional until the
// mod format is decided. A mod is { name, description, rows: [{ label, value(), change(step) }],
// notes(): string[], blocked(): reason the song list must not start a chart, or null }.
const mods = [];
const registerMod = mod => mods.push(mod);
const blockedReason = () => mods.map(m => m.blocked()).find(Boolean) ?? null;

const dims = Memory.alloc(16);
const width = (t, size) => { measureText(dims, t.ptr, t.len, size); return dims.readFloat(); };
const screen = () => { const d = dpiScale(); return { w: at(0x140718568).readFloat() / d, h: at(0x14071856c).readFloat() / d }; };
const scaleFor = (w, h) => Math.min(2.2, Math.max(0.6, Math.min(w / 1100, h / 800))); // the options screen's scale

let hero = false, row = 0, capturing = false, gameTab = -1, optionsSeen = 0, wrapUntil = 0, shift = false;
let menuSeen = 0, windowOpen = false, windowRow = 0;

// Same layout as the game's own tab bar, with a fifth tab.
function drawTabBar(selected, s) {
  optionsSeen = Date.now();
  const { w, h } = screen();
  drawText(TITLE.ptr, TITLE.len, w / 2 - width(TITLE, 56 * s) / 2, 130 * s, 56 * s, WHITE);
  drawText(VERSION.ptr, VERSION.len, w / 2 - width(VERSION, 14 * s) / 2, h - 67 * s, 14 * s, FAINT);
  const size = 18 * s, gap = 36 * s, widths = TABS.map(t => width(t, size));
  let x = w / 2 - (widths.reduce((a, b) => a + b) + gap * (TABS.length - 1)) / 2;
  TABS.forEach((t, i) => {
    drawText(t.ptr, t.len, x, 178 * s, size, i === selected ? ORANGE : GREY);
    if (i === selected) drawLine(x, 187 * s, x + widths[i], 187 * s, 2 * s, ORANGE);
    x += widths[i] + gap;
  });
}

// Rows styled like the game's: the selected one is brighter, with '>' before it and '<' '>' around its value.
function drawHeroPage() {
  const { w, h } = screen(), s = scaleFor(w, h);
  const size = 22 * s, labelRight = w / 2 - 24 * s, valueX = w / 2 + 24 * s;
  drawRectangle(0, 0, w, h, BACKGROUND);
  drawTabBar(HERO, s);
  ROWS.forEach((r, i) => {
    const y = (260 + 40 * i) * s, selected = i === row, labelX = labelRight - width(r.label, size);
    const value = i === 0 ? (settings.removeLigatures ? ON : OFF) : (capturing ? WAITING : keyText);
    drawText(r.label.ptr, r.label.len, labelX, y, size, selected ? WHITE : DIM);
    drawText(value.ptr, value.len, valueX, y, size, selected ? ORANGE : DIM_ORANGE);
    if (!selected) return;
    drawText(RIGHT.ptr, 1, labelX - 28 * s, y, size, WHITE);
    drawText(LEFT.ptr, 1, valueX - width(LEFT, size) - 10 * s, y, size, ORANGE);
    drawText(RIGHT.ptr, 1, valueX + width(value, size) + 10 * s, y, size, ORANGE);
  });
  const hint = capturing ? CAPTURE_HINT : ROWS[row].hint;
  drawText(hint.ptr, hint.len, w / 2 - width(hint, 17 * s) / 2, (260 + 40 * ROWS.length + 20) * s, 17 * s, GREY);
}

// Lines are [string, size, colour, indent], laid out top to bottom on a centred panel.
function drawPanel(lines, top) {
  const { w, h } = screen(), s = scaleFor(w, h), x = w / 2 - 300 * s;
  const height = lines.reduce((sum, [, size]) => sum + 1.6 * size * s, 0);
  drawRectangle(x - 24 * s, top * s, 648 * s, height + 32 * s, PANEL);
  drawLine(x - 24 * s, top * s, x + 624 * s, top * s, 2 * s, ORANGE);
  let y = (top + 16) * s;
  for (const [string, size, color, indent] of lines) {
    const t = label(string);
    y += 1.6 * size * s;
    drawText(t.ptr, t.len, x + indent * s, y - 0.4 * size * s, size * s, color);
  }
}

function drawModWindow() {
  const lines = [['MODS', 32, WHITE, 0]];
  let index = 0;
  for (const mod of mods) {
    lines.push([mod.name, 22, WHITE, 0], [mod.description, 16, GREY, 0]);
    for (const r of mod.rows) {
      const selected = index++ === windowRow, value = r.value();
      lines.push([selected ? `> ${r.label}   < ${value} >` : `  ${r.label}     ${value}`, 20, selected ? ORANGE : DIM_ORANGE, 12]);
    }
    for (const note of mod.notes()) lines.push([note, 15, RED, 12]);
  }
  lines.push([`${settings.modWindowKey.name} or ESC to close - LEFT/RIGHT to change`, 15, FAINT, 0]);
  drawPanel(lines, 110);
}

// Drawn after the song list has drawn itself, so it sits on top.
Interceptor.attach(at(0x1400b64a0), {
  onLeave() {
    menuSeen = Date.now();
    const reason = blockedReason();
    if (windowOpen) drawModWindow();
    else if (reason) drawPanel([[`${reason} - press ${settings.modWindowKey.name} to fix`, 17, RED, 0]], 20);
  }
});

function setLigaturesRemoved(on) {
  settings.removeLigatures = on;
  ligatureAlpha.writeFloat(on ? 0 : ligatureAlphaShown);
}

const nameBuffer = Memory.alloc(128);
function setModWindowKey(vk, lParam) {
  const length = getKeyName(lParam, nameBuffer, 64);
  const name = length > 0 ? nameBuffer.readUtf16String(length).toUpperCase() : `KEY ${vk}`;
  settings.modWindowKey = { vk, name };
  keyText = text(name);
}

// The game draws its tab bar only for its own tabs, so HEROLOADER is not showing.
Interceptor.replace(at(0x1400dd500), new NativeCallback((tab, s) => {
  gameTab = tab;
  hero = capturing = false;
  drawTabBar(TAB_OF[tab] ?? -1, s);
}, 'void', ['int', 'float']));

// HEROLOADER sits on top of GAMEPLAY: the game stays on GAMEPLAY while this page replaces its rows.
Interceptor.replace(at(0x1400d6230), new NativeCallback((selectedRow, gameSettings, tab, extra) => {
  if (tab.isNull() && Date.now() < wrapUntil) { hero = true; wrapUntil = 0; } // TAB wrapped past the last tab
  if (hero && tab.isNull()) drawHeroPage();
  else drawOptionRows(selectedRow, gameSettings, tab, extra);
}, 'void', ['pointer', 'pointer', 'pointer', 'pointer']));

const WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_CHAR = 0x102, MAPVK_VK_TO_CHAR = 2;
const VK_TAB = 0x09, VK_ENTER = 0x0d, VK_SHIFT = 0x10, VK_ESCAPE = 0x1b, VK_LEFT = 0x25, VK_UP = 0x26, VK_RIGHT = 0x27, VK_DOWN = 0x28;
const TOGGLE_KEYS = [VK_ENTER, 0x20, VK_LEFT, VK_RIGHT];

// Returns true when the song list must not see the key.
function songListKey(vk, press) {
  if (!windowOpen) {
    if (press && vk === settings.modWindowKey.vk) return windowOpen = true;
    return vk === VK_ENTER && blockedReason() !== null; // no chart may start while a mod setting is unusable
  }
  const rows = mods.flatMap(m => m.rows);
  if (press && (vk === settings.modWindowKey.vk || vk === VK_ESCAPE)) windowOpen = false;
  else if (press && (vk === VK_UP || vk === VK_DOWN)) windowRow = Math.min(rows.length - 1, Math.max(0, windowRow + (vk === VK_UP ? -1 : 1)));
  else if (press && rows.length > 0 && (vk === VK_LEFT || vk === VK_RIGHT || vk === VK_ENTER)) rows[windowRow].change(vk === VK_LEFT ? -1 : 1);
  return true;
}

Interceptor.attach(user32.getExportByName('TranslateMessage'), {
  onEnter(args) {
    const msg = args[0], type = msg.add(8).readU32();
    if (type !== WM_KEYDOWN && type !== WM_KEYUP && type !== WM_CHAR) return;
    const vk = msg.add(16).readU32(), lParam = msg.add(24).readS32();
    const swallow = () => msg.add(8).writeU32(0); // WM_NULL
    if (type !== WM_CHAR && vk === VK_SHIFT) shift = type === WM_KEYDOWN;
    if (type === WM_KEYUP) return; // releases always reach the game
    const press = type === WM_KEYDOWN && (lParam & 0x40000000) === 0; // not auto-repeat
    if (windowOpen || Date.now() - menuSeen < 250) {
      if (songListKey(vk, press)) swallow();
      return;
    }
    if (Date.now() - optionsSeen > 250) return;
    if (hero) {
      if (capturing) {
        // Keys that type text stay free for playing; ESC cancels.
        if (press && vk === VK_ESCAPE) capturing = false;
        else if (press && keyChar(vk, MAPVK_VK_TO_CHAR) < 0x20) { setModWindowKey(vk, lParam); capturing = false; save(); }
      } else if (vk === VK_ESCAPE) return; // the game leaves the options screen as usual
      else if (press && vk === VK_TAB) { hero = false; if (shift) return; } // shift: the game steps back from GAMEPLAY
      else if (press && (vk === VK_UP || vk === VK_DOWN)) row = Math.min(ROWS.length - 1, Math.max(0, row + (vk === VK_UP ? -1 : 1)));
      else if (press && row === 0 && TOGGLE_KEYS.includes(vk)) { setLigaturesRemoved(!settings.removeLigatures); save(); }
      else if (press && row === 1 && vk === VK_ENTER) capturing = true;
      swallow(); // the GAMEPLAY rows underneath must not react
    } else if (press && vk === VK_TAB) {
      wrapUntil = !shift && gameTab !== 0 ? Date.now() + 500 : 0;
      if (shift && gameTab === 0) { hero = true; swallow(); }
    }
  }
});

console.log('heroloader: HEROLOADER tab and mod window ready');
