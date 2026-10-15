# heroloader
A Mod Loader for Keyboard Warrior

Supports Keyboard Warrior 2.0.0 for Windows x86_64. Put this folder inside the game folder, next to `keyboardwarrior.exe`, and start the game with:

```
uv run heroloader.py
```

Keep the terminal open while you play.

- **Options → HEROLOADER:** remove ligatures (the line linking a word's letters), and choose the key that opens the mod window (TAB by default).
- **Mod window:** press that key on the song list to see the mods and change their settings.

## Lexicon: your own words

Lexicon makes the game use words from a dictionary you write. Save a `.txt` file in `%APPDATA%\heroloader\dictionaries`, restart through `heroloader.py`, and choose it in the mod window. The file name is the dictionary's name.

```
[a-z]
a
house
cat
window
```

- The first line is the alphabet: one bracketed class of letters and ranges, such as `[a-z]` or `[aeiouprst]`. The alphabet defines allowed characters; it does not add words to the list.
- After the alphabet, write one word per line. Blank lines are ignored.
- Words may only use letters from the alphabet, may not repeat, and may have at most 8 letters. The game only accepts the letters a to z.
- **Strict mode is ON by default:** only listed words are available, including single-letter words. Words may repeat during play. Lexicon splits phrases into whole listed words when possible; if a chart or practice section cannot be filled, it refuses to start and explains why.
- **Strict mode OFF:** the game uses a listed word of the requested length whenever one exists. Otherwise, Lexicon generates a combination of alphabet characters of that length, without splitting the phrase.
- Change strict mode in the mod window. The setting persists across launches. A file containing only an alphabet works with strict mode OFF.
- A file with a mistake shows up in red in the mod window with the reason. If your chosen dictionary is missing or broken, the song list won't start a song until you choose another.

## Project layout and tests

`heroloader.py` and `hero_tab.js` implement the loader. Each mod lives in its own folder under `mods/`; Lexicon's Python parser and injected JavaScript are in `mods/lexicon/`. Tests live in `tests/`.

Run the tests from the project root:

```
uv run python -m unittest discover -v
```
