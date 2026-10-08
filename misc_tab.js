// Adds a MISCELLANEOUS tab to the options screen with a "remove ligatures" toggle, which hides
// the line linking the letters of a word. Off by default and not saved between launches.
// Addresses target Keyboard Warrior 2.0.0 for Windows x86_64 (preferred image base 0x140000000).
const exe = Process.getModuleByName('keyboardwarrior.exe');
const at = va => exe.base.add(va - 0x140000000);

// Alpha of the colour shared by the gameplay highway and the options preview to draw word lines.
const ligatureAlpha = at(0x14051d6ac);
if (at(0x140599952).readUtf8String(6) !== 'v2.0.0' || Math.abs(ligatureAlpha.readFloat() - 0.13) > 1e-6)
  throw new Error('misc_tab.js supports only Keyboard Warrior 2.0.0 for Windows x86_64');
const ligatureAlphaShown = ligatureAlpha.readFloat();
Memory.protect(ligatureAlpha, 4, 'rw-');

const fn = (va, ret, args) => new NativeFunction(at(va), ret, args);
const measureText = fn(0x140023100, 'void', ['pointer', 'pointer', 'uint64', 'float']); // (out, text, len, size)
const drawText = fn(0x140022c90, 'void', ['pointer', 'uint64', 'float', 'float', 'float', 'pointer']); // (text, len, x, y, size, color)
const drawLine = fn(0x140229b00, 'void', ['float', 'float', 'float', 'float', 'float', 'pointer']);
const drawRectangle = fn(0x140229140, 'void', ['float', 'float', 'float', 'float', 'pointer']);
const dpiScale = fn(0x1402502f0, 'float', []);
const drawOptionRows = fn(0x1400d6230, 'void', ['pointer', 'pointer', 'pointer', 'pointer']); // (row, settings, tab, _)

const rgba = (...c) => { const p = Memory.alloc(16); c.forEach((v, i) => p.add(4 * i).writeFloat(v)); return p; };
const WHITE = rgba(1, 1, 1, 0.95), FAINT = rgba(1, 1, 1, 0.3), GREY = rgba(0.64, 0.7, 0.78, 0.75), ORANGE = rgba(0.99, 0.72, 0.25, 0.95);
const BACKGROUND = at(0x14052330c);

const text = s => ({ ptr: Memory.allocUtf8String(s), len: s.length });
const gameText = (va, len) => ({ ptr: at(va), len });
const TITLE = gameText(0x14063df10, 7), VERSION = gameText(0x140599952, 6);
const TABS = [gameText(0x14059962b, 8), gameText(0x140599633, 7), gameText(0x14059963a, 5), gameText(0x14059963f, 12), text('MISCELLANEOUS')];
const MISC = 4, TAB_OF = { 0: 0, 3: 1, 2: 2, 1: 3 }; // game tab value -> TABS index; 0 is GAMEPLAY
const LABEL = text('remove ligatures'), HINT = text('hide the line linking the letters of a word');
const VALUES = [text('< OFF >'), text('< ON >')];

const dims = Memory.alloc(16);
const width = (t, size) => { measureText(dims, t.ptr, t.len, size); return dims.readFloat(); };
const screen = () => { const d = dpiScale(); return { w: at(0x140718568).readFloat() / d, h: at(0x14071856c).readFloat() / d }; };

let misc = false, noLigatures = false, gameTab = -1, optionsSeen = 0, wrapUntil = 0, shift = false;

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

function drawMiscPage() {
  const { w, h } = screen(), s = Math.min(2.2, Math.max(0.6, Math.min(w / 1100, h / 800)));
  const size = 22 * s, y = 260 * s, value = VALUES[+noLigatures];
  drawRectangle(0, 0, w, h, BACKGROUND);
  drawTabBar(MISC, s);
  drawText(LABEL.ptr, LABEL.len, w / 2 - 24 * s - width(LABEL, size), y, size, WHITE);
  drawText(value.ptr, value.len, w / 2 + 24 * s, y, size, ORANGE);
  drawText(HINT.ptr, HINT.len, w / 2 - width(HINT, 17 * s) / 2, y + 50 * s, 17 * s, GREY);
}

function setLigaturesRemoved(on) {
  noLigatures = on;
  ligatureAlpha.writeFloat(on ? 0 : ligatureAlphaShown);
}

// The game draws its tab bar only for its own tabs, so MISCELLANEOUS is not showing.
Interceptor.replace(at(0x1400dd500), new NativeCallback((tab, s) => {
  gameTab = tab;
  misc = false;
  drawTabBar(TAB_OF[tab] ?? -1, s);
}, 'void', ['int', 'float']));

// MISCELLANEOUS sits on top of GAMEPLAY: the game stays on GAMEPLAY while this page replaces its rows.
Interceptor.replace(at(0x1400d6230), new NativeCallback((row, settings, tab, extra) => {
  if (tab.isNull() && Date.now() < wrapUntil) { misc = true; wrapUntil = 0; } // TAB wrapped past the last tab
  if (misc && tab.isNull()) drawMiscPage();
  else drawOptionRows(row, settings, tab, extra);
}, 'void', ['pointer', 'pointer', 'pointer', 'pointer']));

const WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_CHAR = 0x102, VK_TAB = 0x09, VK_SHIFT = 0x10, VK_ESCAPE = 0x1b;
const TOGGLE_KEYS = [0x0d, 0x20, 0x25, 0x27]; // ENTER, SPACE, LEFT, RIGHT

Interceptor.attach(Process.getModuleByName('user32.dll').getExportByName('TranslateMessage'), {
  onEnter(args) {
    const msg = args[0], type = msg.add(8).readU32();
    if (type !== WM_KEYDOWN && type !== WM_KEYUP && type !== WM_CHAR) return;
    const vk = msg.add(16).readU32();
    if (type !== WM_CHAR && vk === VK_SHIFT) shift = type === WM_KEYDOWN;
    if (type === WM_KEYUP || Date.now() - optionsSeen > 250) return; // releases always reach the game
    const press = type === WM_KEYDOWN && (msg.add(24).readU32() & 0x40000000) === 0; // not auto-repeat
    if (misc) {
      if (vk === VK_ESCAPE) return; // the game leaves the options screen as usual
      if (press && vk === VK_TAB) { misc = false; if (shift) return; } // shift: the game steps back from GAMEPLAY
      else if (press && TOGGLE_KEYS.includes(vk)) setLigaturesRemoved(!noLigatures);
      msg.add(8).writeU32(0); // WM_NULL: the GAMEPLAY rows underneath must not react
    } else if (press && vk === VK_TAB) {
      wrapUntil = !shift && gameTab !== 0 ? Date.now() + 500 : 0;
      if (shift && gameTab === 0) { misc = true; msg.add(8).writeU32(0); }
    }
  }
});

console.log('heroloader: MISCELLANEOUS tab ready');
