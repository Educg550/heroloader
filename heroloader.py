"""Start Keyboard Warrior with HeroLoader injected. Keep this running while you play."""
import os
import pathlib
import threading

import frida

import lexicon

HERE = pathlib.Path(__file__).resolve().parent
GAME = HERE.parent / 'keyboardwarrior.exe'
DATA = pathlib.Path(os.environ['APPDATA']) / 'heroloader'
SETTINGS = DATA / 'settings.json'
DICTIONARIES = DATA / 'dictionaries'
SCRIPTS = ['hero_tab.js', 'lexicon.js']  # mods come after hero_tab.js, whose helpers they share


def main():
    DICTIONARIES.mkdir(parents=True, exist_ok=True)
    pid = frida.spawn([str(GAME)], cwd=str(GAME.parent))
    try:
        session = frida.attach(pid)
        source = '\n'.join((HERE / name).read_text(encoding='utf-8') for name in SCRIPTS)
        script = session.create_script(source)
        script.on('message', lambda message, data: print(message.get('stack') or message, flush=True))
        script.load()
        saved = SETTINGS.read_text(encoding='utf-8') if SETTINGS.exists() else '{}'
        script.exports_sync.init(str(SETTINGS), saved)
        script.exports_sync.lexicon(lexicon.load(DICTIONARIES))
    except Exception:
        frida.kill(pid)
        raise
    closed = threading.Event()
    session.on('detached', lambda *_: closed.set())
    frida.resume(pid)
    closed.wait()


if __name__ == '__main__':
    main()
