"""Devanagari -> Roman, good enough for matching brand names ("डोलो 650" -> "dolo 650").

This is NOT a linguistic transliteration: it only has to land close enough to the Roman spelling
for trigram matching. Schwa deletion: a consonant with no vowel sign takes an inherent "a", except
at the end of a word ("पैरासिटामोल" -> "pairasitamol").
"""

import re
from typing import Final

_VIRAMA: Final = "्"
_NUKTA: Final = "़"

_INDEPENDENT_VOWELS: Final[dict[str, str]] = {
    "अ": "a", "आ": "a", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u", "ए": "e", "ऐ": "ai",
    "ओ": "o", "औ": "au", "ऑ": "o", "ऋ": "ri",
}  # fmt: skip
_MATRAS: Final[dict[str, str]] = {
    "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "े": "e", "ै": "ai", "ो": "o",
    "ौ": "au", "ॉ": "o", "ृ": "ri",
}  # fmt: skip
_NASALS: Final[dict[str, str]] = {"ं": "n", "ँ": "n", "ः": "h"}
_CONSONANTS: Final[dict[str, str]] = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j",
    "झ": "jh", "ञ": "n", "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t",
    "थ": "th", "द": "d", "ध": "dh", "न": "n", "प": "p", "फ": "ph", "ब": "b", "भ": "bh",
    "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh", "ष": "sh", "स": "s",
    "ह": "h", "ळ": "l",
}  # fmt: skip
_DIGITS: Final = str.maketrans("०१२३४५६७८९", "0123456789")
_DEVANAGARI = re.compile(r"[ऀ-ॿ]")


def has_devanagari(text: str) -> bool:
    return _DEVANAGARI.search(text) is not None


def _word(word: str) -> str:
    out: list[str] = []
    chars = [c for c in word if c != _NUKTA]
    for index, char in enumerate(chars):
        if char in _CONSONANTS:
            out.append(_CONSONANTS[char])
            following = chars[index + 1] if index + 1 < len(chars) else ""
            if following == _VIRAMA or following in _MATRAS:
                continue  # the vowel sign (or its absence) decides
            if following in _NASALS or following in _CONSONANTS or following in _INDEPENDENT_VOWELS:
                out.append("a")  # inherent vowel inside the word
            # end of word: schwa deleted
        elif char in _MATRAS:
            out.append(_MATRAS[char])
        elif char in _INDEPENDENT_VOWELS:
            out.append(_INDEPENDENT_VOWELS[char])
        elif char in _NASALS:
            out.append(_NASALS[char])
        elif char == _VIRAMA:
            continue
        else:
            out.append(char)
    return "".join(out)


def to_roman(text: str) -> str:
    """Roman rendering of the Devanagari parts of `text`; everything else is kept as is."""
    if not has_devanagari(text):
        return text
    text = text.translate(_DIGITS)
    return re.sub(r"[ऀ-ॿ]+", lambda match: _word(match.group(0)), text)
