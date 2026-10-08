"""Start Keyboard Warrior with misc_tab.js injected. Keep this running while you play."""
import pathlib
import threading

import frida

HERE = pathlib.Path(__file__).resolve().parent
GAME = HERE.parent / 'keyboardwarrior.exe'


def main():
    pid = frida.spawn([str(GAME)], cwd=str(GAME.parent))
    try:
        session = frida.attach(pid)
        script = session.create_script((HERE / 'misc_tab.js').read_text(encoding='utf-8'))
        script.on('message', lambda message, data: print(message.get('stack') or message, flush=True))
        script.load()
    except Exception:
        frida.kill(pid)
        raise
    closed = threading.Event()
    session.on('detached', lambda *_: closed.set())
    frida.resume(pid)
    closed.wait()


if __name__ == '__main__':
    main()
