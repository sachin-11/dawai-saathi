"""What an interaction DOES, in plain words, keyed by the stable `interactions.effect_code` (M11).

The interaction rows carry a code, never free text in Hindi. Every sentence the bot says about an
effect comes from this table, written once, and has to be reviewed by a pharmacist or doctor before
launch (`REVIEWED` is False until then). A model never produces any of these words (CLAUDE.md §2.5).
"""

from typing import Final

REVIEWED: Final = False  # flip to True only after a human reviewed every Hindi phrase below

# code -> (English predicate after "...together", Hindi predicate)
EFFECTS: Final[dict[str, tuple[str, str]]] = {
    "bleeding": ("can increase the risk of bleeding", "खून बहने का खतरा बढ़ सकता है"),
    "stomach_ulcer": (
        "can increase the risk of stomach ulcers and bleeding",
        "पेट में छाले और ब्लीडिंग का खतरा बढ़ सकता है",
    ),
    "low_blood_pressure": (
        "can cause a sharp fall in blood pressure",
        "ब्लड प्रेशर बहुत गिर सकता है",
    ),
    "kidney_bp": (
        "can weaken the blood-pressure medicine and strain the kidneys",
        "बीपी की दवा का असर कम हो सकता है और किडनी पर ज़ोर पड़ सकता है",
    ),
    "hyperkalemia": (
        "can raise the potassium in the blood too much",
        "खून में पोटैशियम बहुत बढ़ सकता है",
    ),
    "serotonin_syndrome": (
        "can cause too much serotonin activity in the body",
        "शरीर में सेरोटोनिन का असर ज़रूरत से ज़्यादा हो सकता है",
    ),
    "cns_depression": (
        "can cause strong drowsiness and slow breathing",
        "बहुत ज़्यादा नींद आ सकती है और सांस धीमी पड़ सकती है",
    ),
    "muscle_toxicity": (
        "can increase the risk of muscle damage",
        "मांसपेशियों को नुकसान का खतरा बढ़ सकता है",
    ),
    "qt_prolongation": (
        "can affect the rhythm of the heart",
        "दिल की धड़कन की लय पर असर पड़ सकता है",
    ),
    "slow_heart_rate": (
        "can slow the heart rate too much",
        "दिल की धड़कन बहुत धीमी हो सकती है",
    ),
    "glucose_control": (
        "can change the blood sugar level",
        "ब्लड शुगर कम या ज़्यादा हो सकती है",
    ),
    "hypoglycaemia_masked": (
        "can hide the warning signs of low blood sugar",
        "कम शुगर के लक्षण छिप सकते हैं",
    ),
    "reduced_absorption": (
        "can make the body absorb less of one of the medicines",
        "शरीर एक दवा को कम सोखता है, इसलिए उसका असर घट सकता है",
    ),
    "increased_drug_level": (
        "can raise the level of one of the medicines in the body",
        "एक दवा का स्तर शरीर में बढ़ सकता है",
    ),
    "reduced_drug_effect": (
        "can reduce the effect of one of the medicines",
        "एक दवा का असर कम हो सकता है",
    ),
    "tendon_risk": (
        "can increase the risk of tendon injury",
        "टेंडन (नस) में चोट का खतरा बढ़ सकता है",
    ),
    "seizure_risk": ("can increase the risk of seizures", "दौरे पड़ने का खतरा बढ़ सकता है"),
    "toxicity": (
        "can increase the side effects of one of the medicines",
        "एक दवा के साइड इफेक्ट बढ़ सकते हैं",
    ),
}

# Used when a row carries a code this table does not know: still a true, generic statement.
FALLBACK: Final = (
    "may affect how the medicines work",
    "दवाओं के असर पर प्रभाव पड़ सकता है",
)


def effect_phrase(code: str | None, language: str) -> str:
    en, hi = EFFECTS.get(code or "", FALLBACK)
    return hi if language == "hi" else en
