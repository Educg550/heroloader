"""Lexicon dictionaries: plain text files with an alphabet line and a word list.

    [a-z]
    house
    cat

The file name (without .txt) is the dictionary's name.
"""
import pathlib
import re
import string

REPERTOIRE = string.digits + string.ascii_uppercase + string.ascii_lowercase
PLAYABLE = set(string.ascii_lowercase)  # the game only lets a-z hit notes
MAX_WORD = 8  # the game's longest word length
ALPHABET_LINE = re.compile(r'(\[(?:[0-9A-Za-z](?:-[0-9A-Za-z])?)+\])')


def parse(text):
    """Return {length: [words]} for lengths 1-8, or raise ValueError explaining the problem."""
    return _parse(text)[1]


def _parse(text):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    match = ALPHABET_LINE.fullmatch(lines[0]) if lines else None
    if not match:
        raise ValueError("the first line must be one class like [a-z]")
    try:
        alphabet = re.compile(match[1])  # the regex engine interprets ranges and repeats
    except re.error as error:
        raise ValueError(f'invalid alphabet {match[1]}: {error}') from None
    letters = [c for c in REPERTOIRE if alphabet.fullmatch(c)]
    if unplayable := [c for c in letters if c not in PLAYABLE]:
        raise ValueError(f"the game only accepts a-z, but the alphabet has {''.join(unplayable)}")
    words = {length: [] for length in range(1, MAX_WORD + 1)}
    seen = set()
    for word in lines[1:]:
        if outside := [c for c in word if not alphabet.fullmatch(c)]:
            raise ValueError(f"'{word}' uses '{outside[0]}', which is not in the alphabet")
        if word in seen:
            raise ValueError(f"'{word}' is listed twice")
        if len(word) > MAX_WORD:
            raise ValueError(f"'{word}' is longer than {MAX_WORD} letters")
        seen.add(word)
        words[len(word)].append(word)
    return ''.join(letters), words


def splits(words):
    """For each phrase length 1-8, the word lengths that fill it: fewest words, then the longest shortest word.

    The game asks for a word as long as each phrase, so phrases whose length has no words are split.
    A length that cannot be filled using explicit words maps to None.
    """
    have = [length for length in words if words[length]]
    best = {0: []}
    for length in range(1, MAX_WORD + 1):
        options = [best[length - part] + [part] for part in have
                   if part <= length and best[length - part] is not None]
        best[length] = min(options, key=lambda parts: (len(parts), -min(parts)), default=None)
    del best[0]
    return best


def load(folder):
    """Every *.txt dictionary in folder, as {'name', 'alphabet', 'words', 'splits'} or {'name', 'error'}, sorted by name."""
    dictionaries = []
    for path in sorted(pathlib.Path(folder).glob('*.txt')):
        try:
            alphabet, words = _parse(path.read_text(encoding='utf-8-sig'))
            dictionaries.append({'name': path.stem, 'alphabet': alphabet, 'words': words, 'splits': splits(words)})
        except (ValueError, UnicodeDecodeError) as error:
            dictionaries.append({'name': path.stem, 'error': str(error)})
    return dictionaries
