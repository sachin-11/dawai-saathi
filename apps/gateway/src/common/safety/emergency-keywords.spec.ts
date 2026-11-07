import { detectEmergency } from './emergency-keywords';
import { normaliseForMatching } from './normalise';

describe('detectEmergency', () => {
  describe('English', () => {
    it.each([
      'I have chest pain',
      'severe CHEST PAIN since morning',
      'my father has pain in his chest',
      'I think it is a heart attack',
      "I can't breathe",
      'He cant breathe properly',
      'she has difficulty breathing',
      'short of breath and sweating',
      'my mother is unconscious',
      'He passed out in the bathroom',
      'she fainted',
      'there is heavy bleeding',
      'bleeding a lot from the wound',
      'He drank poison',
      'my child took an overdose of tablets',
      'having a seizure right now',
      'face drooping and slurred speech',
    ])('flags "%s" as a general emergency', (text) => {
      expect(detectEmergency(text)).toBe('general');
    });

    it.each([
      'I want to die',
      'I am thinking of suicide',
      'I will kill myself',
      "I don't want to live anymore",
      'I want to hurt myself',
      'self-harm thoughts',
    ])('flags "%s" as self-harm', (text) => {
      expect(detectEmergency(text)).toBe('self_harm');
    });
  });

  describe('Hinglish (Roman script)', () => {
    it.each([
      'mujhe seene me dard ho raha hai',
      'seene mein dard hai bahut',
      'chhati me dard hai',
      'meri saans nahi aa rahi',
      'saans lene me takleef hai',
      'papa behosh ho gaye',
      'unhone zeher kha liya',
      'bahut khoon beh raha hai',
      'khoon nahi ruk raha',
      'daura pad gaya',
      'dadi ko lakwa ho gaya',
      'overdose ho gaya shayad',
    ])('flags "%s" as a general emergency', (text) => {
      expect(detectEmergency(text)).toBe('general');
    });

    it.each([
      'main khud ko nuksan pahunchana chahta hoon',
      'mujhe marna chahta hoon',
      'main jaan de dunga',
      'ab zindagi khatam karni hai',
      'atmahatya ka mann kar raha hai',
    ])('flags "%s" as self-harm', (text) => {
      expect(detectEmergency(text)).toBe('self_harm');
    });
  });

  describe('Hindi (Devanagari)', () => {
    it.each([
      'मुझे सीने में दर्द हो रहा है',
      'छाती में दर्द है',
      'मेरी साँस नहीं आ रही',
      'सांस लेने में तकलीफ है',
      'पापा बेहोश हो गए',
      'उसने ज़हर खा लिया',
      'उसने जहर खा लिया',
      'बहुत खून बह रहा है',
      'दादी को लकवा हो गया',
      'दिल का दौरा पड़ा है',
      'मिर्गी का दौरा आया',
    ])('flags "%s" as a general emergency', (text) => {
      expect(detectEmergency(text)).toBe('general');
    });

    it.each([
      'मैं आत्महत्या करना चाहता हूँ',
      'मुझे खुदकुशी के ख़याल आ रहे हैं',
      'मैं खुद को नुकसान पहुँचाना चाहती हूँ',
      'मैं मरना चाहती हूँ',
    ])('flags "%s" as self-harm', (text) => {
      expect(detectEmergency(text)).toBe('self_harm');
    });
  });

  it('self-harm wins when both kinds appear', () => {
    expect(detectEmergency('chest pain and I want to die')).toBe('self_harm');
  });

  it('is robust to case, punctuation, emoji and spacing', () => {
    expect(detectEmergency('CHEST   PAIN!!! 😰')).toBe('general');
    expect(detectEmergency('ch-est pain')).toBeNull(); // not a typo-corrector; exact words
    expect(detectEmergency('  I   WANT  TO   DIE...  ')).toBe('self_harm');
  });

  it.each([
    'help me with my medicine',
    'Dolo 650 kab leni hai?',
    'send my prescription photo',
    'delete my data',
    'hello',
    'my blood pressure is 120/80',
    'दवाई कब लेनी है',
    'mujhe paracetamol chahiye',
    'is this poisonous',
    '',
    '   ',
  ])('does not flag the ordinary message %p', (text) => {
    expect(detectEmergency(text)).toBeNull();
  });

  it('leans towards safety: a negated or informational mention still triggers (documented trade-off)', () => {
    expect(detectEmergency('no chest pain today')).toBe('general');
    expect(detectEmergency('chest pain ki dawai kaunsi hai')).toBe('general');
  });
});

describe('normaliseForMatching', () => {
  it.each([
    ['ज़हर', 'जहर'],
    ['साँस', 'सांस'],
    ["CAN'T  Breathe!", 'can t breathe'],
    ['  Help 🙏 ', 'help'],
    ['a‍b', 'ab'],
  ])('%p -> %p', (input, expected) => {
    expect(normaliseForMatching(input)).toBe(expected);
  });

  it('is idempotent', () => {
    const once = normaliseForMatching("ज़हर, साँस!! CAN'T");
    expect(normaliseForMatching(once)).toBe(once);
  });
});
