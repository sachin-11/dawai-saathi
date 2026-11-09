"""Devanagari -> Roman, for KEYWORD MATCHING only (M13).

A speech service may return Hindi in Devanagari ("डोलो 650 का जेनेरिक बताओ"). The emergency rules,
the command table and the drug matcher also have to work on the Roman spelling people type
("dolo 650 ka generic batao"). This function makes that second copy.

It is a deterministic, rule-based transliteration (like Hunterian/ITRANS-lite), NOT a translation and
NOT shown to the user. It is approximate on purpose (long/short vowels are merged, `v/w`, `k/c`
differences are not guessed): downstream matching is fuzzy and the original script is always kept
and checked as well. Latin letters, digits and punctuation pass through untouched.

Schwa: a consonant without a vowel sign carries an inherent "a", kept inside a word and dropped at its
end ("दर्द" -> "dard", "सीने" -> "seene"). Real Hindi also drops some inner schwas ("समझ" is "samajh");
that is not modelled, the original script is matched as well.
"""

import unicodedata
from typing import Final

_VIRAMA: Final = "्"

_INDEPENDENT_VOWELS: Final = {
    "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo", "ऋ": "ri",
    "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऑ": "o", "ऍ": "e",
}  # fmt: skip

_MATRAS: Final = {
    "ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo", "ृ": "ri",
    "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ॅ": "e",
}  # fmt: skip

_CONSONANTS: Final = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n",
    "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
    "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
    "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "f", "ब": "b", "भ": "bh", "म": "m",
    "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh", "ष": "sh", "स": "s", "ह": "h",
    "क्ष": "ksh", "ज्ञ": "gy",
    "ळ": "l",
}  # fmt: skip

# Precomposed nukta letters (NFC form) and the decomposed "base + nukta" sequences both map here.
_NUKTA_FORMS: Final = {"ज": "z", "फ": "f", "क": "q", "ख": "kh", "ग": "g", "ड": "d", "ढ": "rh"}

_DIGITS: Final = {chr(0x0966 + i): str(i) for i in range(10)}
# ruff: noqa: RUF001  (Devanagari signs look like Latin punctuation to the linter)
_SIGNS: Final = {"ं": "n", "ँ": "n", "ः": "h", "ऽ": "", "।": ".", "॥": "."}
_NUKTA: Final = "़"


def has_devanagari(text: str) -> bool:
    return any("ऀ" <= ch <= "ॿ" for ch in text)


def _is_consonant(ch: str) -> bool:
    return ch in _CONSONANTS or ch in _NUKTA_FORMS


def to_roman(text: str) -> str:
    """The Roman copy of `text`. Text with no Devanagari is returned unchanged."""
    if not has_devanagari(text):
        return text
    chars = list(unicodedata.normalize("NFD", text))  # split precomposed nukta letters
    out: list[str] = []
    i, n = 0, len(chars)
    while i < n:
        ch = chars[i]
        if ch in _INDEPENDENT_VOWELS:
            out.append(_INDEPENDENT_VOWELS[ch])
            i += 1
            continue
        if _is_consonant(ch):
            nxt = chars[i + 1] if i + 1 < n else ""
            if nxt == _NUKTA:
                sound = _NUKTA_FORMS.get(ch, _CONSONANTS.get(ch, ""))
                i += 1
                nxt = chars[i + 1] if i + 1 < n else ""
            else:
                sound = _CONSONANTS[ch]
            # conjuncts that have their own spelling: क्ष, ज्ञ
            if ch == "क" and nxt == _VIRAMA and i + 2 < n and chars[i + 2] == "ष":
                sound, i, nxt = "ksh", i + 2, (chars[i + 3] if i + 3 < n else "")
            elif ch == "ज" and nxt == _VIRAMA and i + 2 < n and chars[i + 2] == "ञ":
                sound, i, nxt = "gy", i + 2, (chars[i + 3] if i + 3 < n else "")
            out.append(sound)
            if nxt in _MATRAS:
                out.append(_MATRAS[nxt])
                i += 2
            elif nxt == _VIRAMA:
                i += 2  # a conjunct: no vowel
            else:
                # inherent "a": kept inside a word, dropped at its end ("दर्द" -> "dard")
                after = chars[i + 1] if i + 1 < n else ""
                if after and _is_word_char(after):
                    out.append("a")
                i += 1
            continue
        if ch in _SIGNS:
            out.append(_SIGNS[ch])
        elif ch in _DIGITS:
            out.append(_DIGITS[ch])
        elif ch in (_NUKTA, _VIRAMA):
            pass
        else:
            out.append(ch)
        i += 1
    return "".join(out)


def _is_word_char(ch: str) -> bool:
    return ch.isalnum() or unicodedata.category(ch).startswith("M")
