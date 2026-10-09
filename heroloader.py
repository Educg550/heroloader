"""Start Keyboard Warrior with hero_tab.js injected. Keep this running while you play."""
import os
import pathlib
import threading

import frida

HERE = pathlib.Path(__file__).resolve().parent
GAME = HERE.parent / 'keyboardwarrior.exe'
SETTINGS = pathlib.Path(os.environ['APPDATA']) / 'heroloader' / 'settings.json'


def main():
    SETTINGS.parent.mkdir(exist_ok=True)
    pid = frida.spawn([str(GAME)], cwd=str(GAME.parent))
    try:
        session = frida.attach(pid)
        script = session.create_script((HERE / 'hero_tab.js').read_text(encoding='utf-8'))
        script.on('message', lambda message, data: print(message.get('stack') or message, flush=True))
        script.load()
        saved = SETTINGS.read_text(encoding='utf-8') if SETTINGS.exists() else '{}'
        script.exports_sync.init(str(SETTINGS), saved)
    except Exception:
        frida.kill(pid)
        raise
    closed = threading.Event()
    session.on('detached', lambda *_: closed.set())
    frida.resume(pid)
    closed.wait()


if __name__ == '__main__':
    main()
