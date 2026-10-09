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
alphabet: [a-z]
words:
casa
gato
janela
```

- The first line is the alphabet: one bracketed class of letters and ranges, such as `[a-z]` or `[aeiouprst]`. Every letter in it also counts as a one-letter word.
- The second line is `words:`. Then write one word per line.
- Words may only use letters from the alphabet, may not repeat, and may have at most 8 letters. The game only accepts the letters a to z.
- Any word lengths are fine. The game splits its phrases so that each one gets a word of a length your dictionary has.
- A file with a mistake shows up in red in the mod window with the reason. If your chosen dictionary is missing or broken, the song list won't start a song until you choose another.
