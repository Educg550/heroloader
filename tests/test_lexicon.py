import tempfile
import unittest
from pathlib import Path

from mods import lexicon


class ParseTest(unittest.TestCase):
    def test_only_explicit_words_grouped_by_length(self):
        words = lexicon.parse('[a-ce]\n\nabc\n  bee  \nb\n')
        self.assertEqual(words[1], ['b'])
        self.assertEqual(words[3], ['abc', 'bee'])
        self.assertEqual(words[2], [])

    def test_alphabet_only(self):
        self.assertEqual(lexicon.parse('[xy]'), {n: [] for n in range(1, 9)})

    def test_rejections(self):
        for text, message in [
            ('', 'first line'),
            ('words:\nabc', 'first line'),
            ('a-z', 'first line'),
            ('[a-z][0-9]', 'first line'),
            ('[a-z.]', 'first line'),
            ('[z-a]', 'invalid alphabet'),
            ('[a-zA-C]', 'only accepts a-z, but the alphabet has ABC'),
            ('alphabet: [a-z]\nwords:\ncat', 'first line'),
            ('[a-z]\nwords:\ncat', "uses ':'"),
            ('[a-c]\ncab\ndab', "'dab' uses 'd'"),
            ('[a-z]\nhello world', "uses ' '"),
            ('[a-z]\ncat\ncat', 'listed twice'),
            ('[a-z]\nabcdefghi', 'longer than 8'),
        ]:
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, message):
                lexicon.parse(text)


class SplitsTest(unittest.TestCase):
    def test_missing_lengths_split_into_available_ones(self):
        words = lexicon.parse('[a-z]\nsol\nmar\npraia\n')
        self.assertEqual(lexicon.splits(words), {1: None, 2: None, 3: [3], 4: None, 5: [5], 6: [3, 3], 7: None, 8: [5, 3]})

    def test_available_lengths_stay_whole(self):
        words = lexicon.parse('[a-z]\n' + '\n'.join('abcdefgh'[:n] for n in range(1, 9)))
        self.assertEqual(lexicon.splits(words), {n: [n] for n in range(1, 9)})

    def test_empty_dictionary_has_no_splits(self):
        self.assertEqual(lexicon.splits(lexicon.parse('[a-z]')), {n: None for n in range(1, 9)})

    def test_split_prefers_longest_shortest_word(self):
        words = lexicon.parse('[a-z]\na\ncat\nword\nhouse')
        self.assertEqual(lexicon.splits(words)[8], [4, 4])


class LoadTest(unittest.TestCase):
    def test_invalid_file_does_not_hide_valid_ones(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, 'good.txt').write_text('﻿[a-z]\ngato\n', encoding='utf-8')
            Path(folder, 'bad.txt').write_text('words:\n', encoding='utf-8')
            loaded = lexicon.load(folder)
        self.assertEqual([d['name'] for d in loaded], ['bad', 'good'])
        self.assertIn('error', loaded[0])
        self.assertEqual(loaded[1]['alphabet'], 'abcdefghijklmnopqrstuvwxyz')
        self.assertEqual(loaded[1]['words'][1], [])
        self.assertEqual(loaded[1]['words'][4], ['gato'])
        self.assertEqual(loaded[1]['splits'][1], None)
        self.assertEqual(loaded[1]['splits'][8], [4, 4])

    def test_empty_dictionary_loads_with_expanded_alphabet(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, 'empty.txt').write_text('[a-ce]\n', encoding='utf-8')
            loaded = lexicon.load(folder)
        self.assertEqual(loaded, [{'name': 'empty', 'alphabet': 'abce',
                                   'words': {n: [] for n in range(1, 9)},
                                   'splits': {n: None for n in range(1, 9)}}])


if __name__ == '__main__':
    unittest.main()
