"""Salt-name knowledge for normalisation (M8). REVIEW BY A PHARMACIST BEFORE LAUNCH.

Everything here is deliberately conservative: when it is not certain that two names mean the same
active ingredient AND the same dosing basis, they stay different, so no generic is ever suggested
across them (CLAUDE.md §2.4). A wrong "strip" can create a wrong suggestion; a missing strip only
loses a suggestion.

Three tables:
  SALT_ALIASES         different names for the SAME ingredient (spelling, INN vs USAN, Hindi)
  SALT_FORM_SUFFIXES   trailing words removed from any salt name (counter-ion that does not change
                       how the strength is written on the label): "amlodipine besylate" -> amlodipine
  EXPLICIT_SALT_FORMS  metal salts we strip only for the named drug, one by one. NOT stripped on
                       purpose: sodium/potassium in general (diclofenac sodium vs potassium),
                       succinate/tartrate (metoprolol: different release forms), phosphate, sulphate.
"""

from typing import Final

# alias (lower case, after salt-form stripping) -> canonical name
SALT_ALIASES: Final[dict[str, str]] = {
    "acetaminophen": "paracetamol",
    "paracetamol ip": "paracetamol",
    "amoxycillin": "amoxicillin",
    "amoxicilin": "amoxicillin",
    "albuterol": "salbutamol",
    "epinephrine": "adrenaline",
    "vitamin d3": "cholecalciferol",
    "vit d3": "cholecalciferol",
    "vitamin d": "cholecalciferol",
    "vitamin c": "ascorbic acid",
    "vit c": "ascorbic acid",
    "vitamin b12": "cyanocobalamin",
    "vit b12": "cyanocobalamin",
    "vitamin b6": "pyridoxine",
    "vitamin b1": "thiamine",
    "folic acid": "folic acid",
    "vitamin b9": "folic acid",
    "frusemide": "furosemide",
    "glibenclamide": "glibenclamide",
    "glyburide": "glibenclamide",
    "rifampin": "rifampicin",
    "cetrizine": "cetirizine",
    "pantoprazol": "pantoprazole",
    "azithromycine": "azithromycin",
    "ciprofloxacine": "ciprofloxacin",
    "clavulanate": "clavulanic acid",
    "potassium clavulanate": "clavulanic acid",
    "clavulanate potassium": "clavulanic acid",
    "diclofenac": "diclofenac",
    # Hindi / Devanagari spellings of common salts
    "पैरासिटामोल": "paracetamol",
    "पेरासिटामोल": "paracetamol",
    "पैरासीटामोल": "paracetamol",
    "मेटफॉर्मिन": "metformin",
    "मेटफोर्मिन": "metformin",
    "एमोक्सिसिलिन": "amoxicillin",
    "अमोक्सीसिलिन": "amoxicillin",
    "पैंटोप्राज़ोल": "pantoprazole",
    "पेंटोप्राजोल": "pantoprazole",
    "सिट्रिज़ीन": "cetirizine",
    "सेट्रिज़िन": "cetirizine",
    "एटोरवास्टेटिन": "atorvastatin",
    "एमलोडिपिन": "amlodipine",
    "अज़िथ्रोमाइसिन": "azithromycin",
    "आइबुप्रोफेन": "ibuprofen",
    "डाइक्लोफेनाक": "diclofenac",
    "ओमेप्राज़ोल": "omeprazole",
    "ओमेप्राजोल": "omeprazole",
}

# Words removed from the END of a salt name (and "hydrate" words anywhere).
SALT_FORM_SUFFIXES: Final[frozenset[str]] = frozenset(
    {
        "hydrochloride",
        "dihydrochloride",
        "hcl",
        "besylate",
        "besilate",
        "maleate",
        "mesylate",
        "hydrobromide",
        "hbr",
    }
)
HYDRATE_WORDS: Final[frozenset[str]] = frozenset(
    {"trihydrate", "dihydrate", "monohydrate", "hemihydrate", "anhydrous"}
)

EXPLICIT_SALT_FORMS: Final[dict[str, str]] = {
    "pantoprazole sodium": "pantoprazole",
    "rabeprazole sodium": "rabeprazole",
    "esomeprazole magnesium": "esomeprazole",
    "esomeprazole sodium": "esomeprazole",
    "atorvastatin calcium": "atorvastatin",
    "rosuvastatin calcium": "rosuvastatin",
    "montelukast sodium": "montelukast",
    "levocetirizine dihydrochloride": "levocetirizine",
}
