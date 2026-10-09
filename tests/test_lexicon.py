import tempfile
import unittest
from pathlib import Path

from mods import lexicon


class ParseTest(unittest.TestCase):
    def test_words_grouped_by_length_with_alphabet_letters(self):
        words = lexicon.parse('alphabet: [a-ce]\nwords:\n\nabc\n  bee  \nb\n')
        self.assertEqual(words[1], ['a', 'b', 'c', 'e'])
        self.assertEqual(words[3], ['abc', 'bee'])
        self.assertEqual(words[2], [])

    def test_empty_word_section_gives_alphabet_only(self):
        self.assertEqual(lexicon.parse('alphabet: [xy]\nwords:')[1], ['x', 'y'])

    def test_rejections(self):
        for text, message in [
            ('', 'first line'),
            ('words:\nabc', 'first line'),
            ('alphabet: a-z\nwords:', 'first line'),
            ('alphabet: [a-z][0-9]\nwords:', 'first line'),
            ('alphabet: [a-z.]\nwords:', 'first line'),
            ('alphabet: [z-a]\nwords:', 'invalid alphabet'),
            ('alphabet: [a-zA-C]\nwords:', 'only accepts a-z, but the alphabet has ABC'),
            ('alphabet: [a-z]', "second line must be 'words:'"),
            ('alphabet: [a-c]\nwords:\ncab\ndab', "'dab' uses 'd'"),
            ('alphabet: [a-z]\nwords:\nhello world', "uses ' '"),
            ('alphabet: [a-z]\nwords:\ncat\ncat', 'listed twice'),
            ('alphabet: [a-z]\nwords:\nabcdefghi', 'longer than 8'),
        ]:
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, message):
                lexicon.parse(text)


class SplitsTest(unittest.TestCase):
    def test_missing_lengths_split_into_available_ones(self):
        words = lexicon.parse('alphabet: [a-z]\nwords:\nsol\nmar\npraia\n')
        self.assertEqual(lexicon.splits(words), {1: [1], 2: [1, 1], 3: [3], 4: [3, 1], 5: [5], 6: [3, 3], 7: [3, 3, 1], 8: [5, 3]})

    def test_available_lengths_stay_whole(self):
        words = lexicon.parse('alphabet: [a-z]\nwords:\n' + '\n'.join('abcdefgh'[:n] for n in range(2, 9)))
        self.assertEqual(lexicon.splits(words), {n: [n] for n in range(1, 9)})


class LoadTest(unittest.TestCase):
    def test_invalid_file_does_not_hide_valid_ones(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, 'good.txt').write_text('﻿alphabet: [a-z]\nwords:\ngato\n', encoding='utf-8')
            Path(folder, 'bad.txt').write_text('words:\n', encoding='utf-8')
            loaded = lexicon.load(folder)
        self.assertEqual([d['name'] for d in loaded], ['bad', 'good'])
        self.assertIn('error', loaded[0])
        self.assertEqual(loaded[1]['words'][4], ['gato'])


if __name__ == '__main__':
    unittest.main()
