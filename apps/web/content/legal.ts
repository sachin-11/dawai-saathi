// DRAFT: this privacy policy and these terms were written from what the system actually does (CLAUDE.md,
// docs/modules). They have NOT been reviewed by a lawyer. They MUST be reviewed (DPDP Act 2023, Meta
// WhatsApp Business policy, the real company details, the grievance officer) before a public launch.
// The visible pages carry a "draft" banner and the date below; see Decisions Log (M16).
import type { Locale } from '@/lib/i18n';

export interface LegalSection {
  id: string;
  heading: string;
  paragraphs: string[];
  bullets?: string[];
}
export interface LegalDocument {
  title: string;
  draftBanner: string;
  intro: string;
  sections: LegalSection[];
}

const DRAFT_EN =
  'Draft. This text has not been reviewed by a lawyer yet and will change before the public launch.';
const DRAFT_HI =
  'मसौदा। इस पाठ की अभी किसी वकील ने समीक्षा नहीं की है और सार्वजनिक लॉन्च से पहले यह बदलेगा।';

const privacyEn: LegalDocument = {
  title: 'Privacy Policy',
  draftBanner: DRAFT_EN,
  intro:
    "Dawai Saathi is a WhatsApp assistant that explains prescriptions and lab reports in plain language. This page says, in simple words, what we collect, why, who helps us process it, how long we keep it and what you can do about it. It follows the principles of India's Digital Personal Data Protection Act, 2023 (DPDP Act).",
  sections: [
    {
      id: 'who',
      heading: '1. Who we are',
      paragraphs: [
        'Dawai Saathi is run by the project owner named on the contact page (the "data fiduciary"). You can write to us at the contact e-mail shown in the footer of this site. The grievance officer\'s name and details will be added here before launch.',
      ],
    },
    {
      id: 'collect',
      heading: '2. What we collect',
      paragraphs: ['Only what is needed to do what you ask:'],
      bullets: [
        'Your WhatsApp number. We keep a one-way keyed hash (to recognise you) and an encrypted copy (to send you messages). We never store it readable.',
        'Your messages: text, button taps and voice notes. Text is stored with phone numbers, e-mails and similar identifiers removed.',
        'Photos and PDFs you send (prescriptions, lab reports). They are kept in a private, encrypted storage bucket.',
        "What we read from them: medicine names, strengths, doses, timings and lab test names and values. We do not keep the doctor's or patient's name, address or phone number in this data.",
        "Reminder settings, your replies to reminders (taken, snoozed, skipped) and, if you add one, a family member's number and the name you gave them.",
        'Technical records such as message ids, error codes and timings. Our logs never contain phone numbers, names or the text of your documents.',
      ],
    },
    {
      id: 'why',
      heading: '3. Why we use it',
      paragraphs: [
        'To read your documents and explain them, to suggest cheaper medicines with the same salt, to check your medicines against each other, to send reminders, to alert a family member you chose, to keep the service safe (for example to show emergency numbers) and to find and fix faults. We do not sell your data and we do not use it for advertising.',
      ],
    },
    {
      id: 'processors',
      heading: '4. Who processes it for us',
      paragraphs: ['We use these service providers, only for the purposes above:'],
      bullets: [
        'Meta (WhatsApp Cloud API): carries your messages.',
        'AI model providers (currently Anthropic and OpenAI): read your document images and understand your text. Personal details in text are removed first.',
        'Speech providers (for example OpenAI Whisper and Sarvam AI for voice-to-text; if you switch spoken replies on, a text-to-speech provider such as Smallest.ai, Sarvam AI or OpenAI).',
        'Amazon Web Services, Mumbai region (ap-south-1): database, queues and file storage. Your data is kept in India.',
        'Monitoring tools that receive technical data with personal details removed.',
      ],
    },
    {
      id: 'retention',
      heading: '5. How long we keep it',
      paragraphs: [
        'Photos and PDFs are deleted automatically after 30 days. Your account, medicines, reminders and lab values stay until you send DELETE. Backups are kept for a limited time and are then overwritten; the exact period will be stated here before launch. After DELETE we keep one anonymous record that an erasure happened, with no personal data.',
      ],
    },
    {
      id: 'rights',
      heading: '6. Your rights',
      paragraphs: ['Under the DPDP Act you can:'],
      bullets: [
        'Erase your data: send DELETE on WhatsApp and confirm. We delete your messages, documents, medicines, reminders, family contacts and stored files.',
        'Withdraw your consent at any time. Today this is done with DELETE.',
        'Ask what data we hold about you, and ask us to correct it (use the "Something is wrong" button or write to us).',
        'Complain to our grievance officer, and to the Data Protection Board of India if you are not satisfied.',
        'Name another person to exercise these rights for you if you cannot.',
      ],
    },
    {
      id: 'security',
      heading: '7. How we protect it',
      paragraphs: [
        'Phone numbers are hashed and encrypted. Files are stored privately with server-side encryption and short-lived access links. Only people who need to operate the service can see data, and viewing a document in the admin area needs a written reason and is logged.',
      ],
    },
    {
      id: 'children',
      heading: '8. Children',
      paragraphs: [
        "Dawai Saathi is for people aged 18 and over. A child's prescription should be sent only by a parent or guardian, with their consent.",
      ],
    },
    {
      id: 'family',
      heading: '9. Family alerts',
      paragraphs: [
        'A family member is added only if you give their number and they reply YES themselves. Alerts say only your chosen name for you and the time of a missed dose. They never include a medicine, dose or condition. They can reply STOP at any time.',
      ],
    },
    {
      id: 'web',
      heading: '10. This website and the live demo',
      paragraphs: [
        "The website uses no advertising or analytics trackers. The demo accepts sample or anonymised documents only: please never upload a real patient's document. An uploaded file is processed, then deleted immediately (and in any case within 24 hours); it is never linked to a user. To limit abuse we keep a keyed hash of your IP address for rate limiting for up to one day. The admin area uses a sign-in cookie for operators only.",
      ],
    },
    {
      id: 'medical',
      heading: '11. Not medical advice, and emergencies',
      paragraphs: [
        'Dawai Saathi explains what is written on your documents. It is not a doctor and gives no diagnosis or treatment advice. In an emergency call 112 or 108 or go to the nearest hospital. If you feel you may harm yourself, call Tele-MANAS on 14416.',
      ],
    },
    {
      id: 'changes',
      heading: '12. Changes and contact',
      paragraphs: [
        'If we change this policy we will update the date at the top and, for important changes, tell you on WhatsApp. Questions: use the contact e-mail in the footer.',
      ],
    },
  ],
};

const privacyHi: LegalDocument = {
  title: 'प्राइवेसी पॉलिसी',
  draftBanner: DRAFT_HI,
  intro:
    'दवाई साथी एक WhatsApp सहायक है जो प्रिस्क्रिप्शन और लैब रिपोर्ट आसान भाषा में समझाता है। इस पेज पर सीधे शब्दों में बताया गया है कि हम क्या जमा करते हैं, क्यों, कौन इसे प्रोसेस करने में मदद करता है, कितने समय तक रखते हैं और आप क्या कर सकते हैं। यह भारत के डिजिटल व्यक्तिगत डेटा संरक्षण अधिनियम, 2023 (DPDP Act) के सिद्धांतों पर चलता है।',
  sections: [
    {
      id: 'who',
      heading: '1. हम कौन हैं',
      paragraphs: [
        'दवाई साथी को संपर्क पेज पर बताया गया प्रोजेक्ट मालिक चलाता है (यही "डेटा फ़िडूशियरी" है)। आप इस साइट के फ़ूटर में दिए संपर्क ई-मेल पर हमें लिख सकते हैं। शिकायत अधिकारी का नाम और विवरण लॉन्च से पहले यहाँ जोड़ा जाएगा।',
      ],
    },
    {
      id: 'collect',
      heading: '2. हम क्या जमा करते हैं',
      paragraphs: ['सिर्फ़ उतना जितना आपका काम करने के लिए ज़रूरी है:'],
      bullets: [
        'आपका WhatsApp नंबर। पहचान के लिए हम एक तरफ़ा कुंजी-वाला हैश रखते हैं और संदेश भेजने के लिए एन्क्रिप्टेड प्रति। नंबर कभी पढ़ने लायक रूप में नहीं रखा जाता।',
        'आपके संदेश: टेक्स्ट, बटन दबाना और वॉइस नोट। टेक्स्ट में से फ़ोन नंबर, ई-मेल जैसी पहचान हटाकर रखा जाता है।',
        'आपकी भेजी फ़ोटो और PDF (प्रिस्क्रिप्शन, लैब रिपोर्ट)। ये निजी, एन्क्रिप्टेड स्टोरेज में रहती हैं।',
        'उनसे जो पढ़ा गया: दवाई के नाम, स्ट्रेंथ, डोज़, समय और लैब जाँच के नाम व मान। डॉक्टर या मरीज़ का नाम, पता या फ़ोन नंबर इस डेटा में नहीं रखते।',
        'रिमाइंडर की सेटिंग, रिमाइंडर पर आपके जवाब (ले ली, बाद में, छोड़ें) और, अगर आप जोड़ें, परिवार के सदस्य का नंबर और आपका दिया नाम।',
        'तकनीकी रिकॉर्ड जैसे संदेश आईडी, त्रुटि कोड और समय। हमारे लॉग में फ़ोन नंबर, नाम या आपके दस्तावेज़ का टेक्स्ट कभी नहीं होता।',
      ],
    },
    {
      id: 'why',
      heading: '3. हम इसका क्या इस्तेमाल करते हैं',
      paragraphs: [
        'आपके दस्तावेज़ पढ़ने और समझाने, उसी साल्ट की सस्ती दवाई सुझाने, आपकी दवाइयों की आपसी जाँच, रिमाइंडर भेजने, आपके चुने परिवार के सदस्य को अलर्ट देने, सेवा को सुरक्षित रखने (जैसे इमरजेंसी नंबर दिखाना) और गड़बड़ी पकड़कर ठीक करने के लिए। हम आपका डेटा बेचते नहीं और विज्ञापन के लिए इस्तेमाल नहीं करते।',
      ],
    },
    {
      id: 'processors',
      heading: '4. हमारे लिए इसे कौन प्रोसेस करता है',
      paragraphs: ['ऊपर के कामों के लिए ही हम इन सेवा-प्रदाताओं का इस्तेमाल करते हैं:'],
      bullets: [
        'Meta (WhatsApp Cloud API): आपके संदेश पहुँचाता है।',
        'AI मॉडल प्रदाता (अभी Anthropic और OpenAI): दस्तावेज़ की इमेज पढ़ते और आपका टेक्स्ट समझते हैं। टेक्स्ट से निजी जानकारी पहले हटा दी जाती है।',
        'आवाज़ वाले प्रदाता (जैसे आवाज़ से टेक्स्ट के लिए OpenAI Whisper और Sarvam AI; अगर आप बोले हुए जवाब चालू करें तो टेक्स्ट से आवाज़ के लिए Smallest.ai, Sarvam AI या OpenAI)।',
        'Amazon Web Services, मुंबई रीजन (ap-south-1): डेटाबेस, क्यू और फ़ाइल स्टोरेज। आपका डेटा भारत में रहता है।',
        'मॉनिटरिंग टूल, जिन्हें निजी जानकारी हटाया हुआ तकनीकी डेटा मिलता है।',
      ],
    },
    {
      id: 'retention',
      heading: '5. कितने समय तक रखते हैं',
      paragraphs: [
        'फ़ोटो और PDF 30 दिन बाद अपने आप हट जाती हैं। आपका खाता, दवाइयाँ, रिमाइंडर और लैब मान तब तक रहते हैं जब तक आप DELETE न भेजें। बैकअप सीमित समय तक रखे जाते हैं और फिर ओवरराइट हो जाते हैं; सही अवधि लॉन्च से पहले यहाँ लिखी जाएगी। DELETE के बाद हम सिर्फ़ एक गुमनाम रिकॉर्ड रखते हैं कि मिटाने की प्रक्रिया हुई, उसमें कोई निजी डेटा नहीं होता।',
      ],
    },
    {
      id: 'rights',
      heading: '6. आपके अधिकार',
      paragraphs: ['DPDP Act के तहत आप ये कर सकते हैं:'],
      bullets: [
        'अपना डेटा मिटाना: WhatsApp पर DELETE भेजें और पुष्टि करें। हम आपके संदेश, दस्तावेज़, दवाइयाँ, रिमाइंडर, परिवार के संपर्क और जमा फ़ाइलें मिटा देते हैं।',
        'कभी भी अपनी सहमति वापस लेना। अभी यह DELETE से होता है।',
        'पूछना कि हमारे पास आपका कौन-सा डेटा है, और उसे सुधरवाना ("कुछ गलत है" बटन या हमें लिखकर)।',
        'हमारे शिकायत अधिकारी से शिकायत करना, और संतुष्ट न हों तो भारत के डेटा प्रोटेक्शन बोर्ड से।',
        'अगर आप खुद न कर सकें तो अपनी ओर से किसी और को नामित करना।',
      ],
    },
    {
      id: 'security',
      heading: '7. हम इसे कैसे सुरक्षित रखते हैं',
      paragraphs: [
        'फ़ोन नंबर हैश और एन्क्रिप्ट किए जाते हैं। फ़ाइलें निजी रूप से सर्वर-साइड एन्क्रिप्शन और थोड़ी देर चलने वाले लिंक के साथ रखी जाती हैं। डेटा सिर्फ़ उन्हीं को दिखता है जिन्हें सेवा चलाने के लिए ज़रूरत है, और एडमिन में कोई दस्तावेज़ खोलने के लिए लिखित कारण देना होता है और वह लॉग होता है।',
      ],
    },
    {
      id: 'children',
      heading: '8. बच्चे',
      paragraphs: [
        'दवाई साथी 18 साल और उससे ऊपर के लोगों के लिए है। बच्चे का प्रिस्क्रिप्शन सिर्फ़ माता-पिता या अभिभावक, उनकी सहमति से भेजें।',
      ],
    },
    {
      id: 'family',
      heading: '9. परिवार को अलर्ट',
      paragraphs: [
        'परिवार का सदस्य तभी जुड़ता है जब आप उनका नंबर दें और वे खुद YES लिखकर जवाब दें। अलर्ट में सिर्फ़ आपका चुना हुआ नाम और छूटी डोज़ का समय होता है, कोई दवाई, डोज़ या बीमारी नहीं। वे कभी भी STOP लिख सकते हैं।',
      ],
    },
    {
      id: 'web',
      heading: '10. यह वेबसाइट और लाइव डेमो',
      paragraphs: [
        'वेबसाइट पर विज्ञापन या एनालिटिक्स ट्रैकर नहीं हैं। डेमो में सिर्फ़ सैंपल या गुमनाम दस्तावेज़ डालें: किसी असली मरीज़ का दस्तावेज़ कभी अपलोड न करें। अपलोड की गई फ़ाइल प्रोसेस होकर तुरंत मिटा दी जाती है (और किसी भी हाल में 24 घंटे में), और किसी यूज़र से जोड़ी नहीं जाती। दुरुपयोग रोकने के लिए रेट-लिमिट हेतु आपके IP का कुंजी-वाला हैश अधिकतम एक दिन रखते हैं। एडमिन हिस्से में सिर्फ़ ऑपरेटरों के लिए साइन-इन कुकी है।',
      ],
    },
    {
      id: 'medical',
      heading: '11. यह चिकित्सा सलाह नहीं है, और इमरजेंसी',
      paragraphs: [
        'दवाई साथी आपके दस्तावेज़ में जो लिखा है वही समझाता है। यह डॉक्टर नहीं है और निदान या इलाज की सलाह नहीं देता। इमरजेंसी में 112 या 108 पर कॉल करें या नज़दीकी अस्पताल जाएँ। अगर आपको लगे कि आप खुद को नुक़सान पहुँचा सकते हैं तो Tele-MANAS 14416 पर कॉल करें।',
      ],
    },
    {
      id: 'changes',
      heading: '12. बदलाव और संपर्क',
      paragraphs: [
        'पॉलिसी बदली तो हम ऊपर की तारीख़ बदलेंगे और ज़रूरी बदलाव की सूचना WhatsApp पर देंगे। सवाल के लिए फ़ूटर में दिया संपर्क ई-मेल इस्तेमाल करें।',
      ],
    },
  ],
};

const termsEn: LegalDocument = {
  title: 'Terms of Use',
  draftBanner: DRAFT_EN,
  intro:
    'These terms apply when you use Dawai Saathi on WhatsApp or the website. By agreeing in the chat or by using the demo you accept them.',
  sections: [
    {
      id: 'service',
      heading: '1. What the service is',
      paragraphs: [
        'Dawai Saathi is an information tool. It reads documents you send and explains what is written on them, suggests cheaper medicines with the same salt, checks known medicine interactions and sends reminders. It does not diagnose, prescribe, change a dose or tell you to stop a medicine. It does not sell medicines and offers no doctor consultation.',
      ],
    },
    {
      id: 'emergency',
      heading: '2. Emergencies',
      paragraphs: [
        'It is not for emergencies. In an emergency call 112 or 108 or go to the nearest hospital. Do not wait for a reply from this service.',
      ],
    },
    {
      id: 'responsibility',
      heading: '3. Your responsibilities',
      paragraphs: ['Please:'],
      bullets: [
        'Send only documents that are yours, or that you have permission to send.',
        'Check what we tell you against your document and confirm anything unclear with your doctor or pharmacist before acting.',
        'Treat a generic suggestion as a suggestion. Ask your doctor or pharmacist before switching any medicine.',
        'Be 18 or older, or use the service together with a parent or guardian.',
        'Not misuse the service: no automated flooding, no attempts to break it, no uploading of real patient documents to the web demo.',
      ],
    },
    {
      id: 'accuracy',
      heading: '4. Accuracy',
      paragraphs: [
        'Reading handwriting and photos is hard and the AI can make mistakes. When we are not sure we say so, but we cannot promise that every result is complete or correct. Prices and medicine data can be out of date; the date is shown where we show a price. Our medicine and interaction lists are not complete: "nothing found" does not mean "safe".',
      ],
    },
    {
      id: 'reminders',
      heading: '5. Reminders',
      paragraphs: [
        'Reminders are a convenience. They can be late or fail (for example when WhatsApp or your phone is offline). Do not rely on them as your only way of taking medicine safely.',
      ],
    },
    {
      id: 'availability',
      heading: '6. Availability and liability',
      paragraphs: [
        'The service is provided "as is" while it is in testing, without a promise that it will always work. To the extent the law allows, we are not liable for decisions you make from its answers or for losses caused by outages. Nothing here limits any right you have under Indian law that cannot be limited.',
      ],
    },
    {
      id: 'ending',
      heading: '7. Stopping and deleting',
      paragraphs: [
        'You can stop at any time: STOP REMINDERS stops reminders, and DELETE erases your data. We may suspend a number that misuses the service.',
      ],
    },
    {
      id: 'law',
      heading: '8. Governing law and contact',
      paragraphs: [
        "These terms are governed by the laws of India. The courts of the operator's city (to be filled in before launch) have jurisdiction. Questions: use the contact e-mail in the footer.",
      ],
    },
  ],
};

const termsHi: LegalDocument = {
  title: 'उपयोग की शर्तें',
  draftBanner: DRAFT_HI,
  intro:
    'ये शर्तें तब लागू होती हैं जब आप दवाई साथी को WhatsApp या वेबसाइट पर इस्तेमाल करते हैं। चैट में सहमति देकर या डेमो इस्तेमाल करके आप इन्हें मानते हैं।',
  sections: [
    {
      id: 'service',
      heading: '1. यह सेवा क्या है',
      paragraphs: [
        'दवाई साथी एक जानकारी देने वाला टूल है। यह आपके भेजे दस्तावेज़ पढ़कर उनमें जो लिखा है वह समझाता है, उसी साल्ट की सस्ती दवाई सुझाता है, दवाइयों की जानी-पहचानी टक्कर जाँचता है और रिमाइंडर भेजता है। यह निदान नहीं करता, दवाई तय नहीं करता, डोज़ नहीं बदलता और दवाई बंद करने को नहीं कहता। यह दवाइयाँ नहीं बेचता और डॉक्टर से परामर्श की सुविधा नहीं देता।',
      ],
    },
    {
      id: 'emergency',
      heading: '2. इमरजेंसी',
      paragraphs: [
        'यह इमरजेंसी के लिए नहीं है। इमरजेंसी में 112 या 108 पर कॉल करें या नज़दीकी अस्पताल जाएँ। इस सेवा के जवाब का इंतज़ार न करें।',
      ],
    },
    {
      id: 'responsibility',
      heading: '3. आपकी ज़िम्मेदारियाँ',
      paragraphs: ['कृपया:'],
      bullets: [
        'सिर्फ़ वही दस्तावेज़ भेजें जो आपके हैं या जिन्हें भेजने की आपके पास अनुमति है।',
        'हमारी बताई बातों को अपने दस्तावेज़ से मिलाएँ और कुछ साफ़ न हो तो कदम उठाने से पहले डॉक्टर या फ़ार्मासिस्ट से पक्का करें।',
        'जेनेरिक सुझाव को सुझाव ही समझें। कोई भी दवाई बदलने से पहले डॉक्टर या फ़ार्मासिस्ट से पूछें।',
        '18 साल या उससे ऊपर के हों, या माता-पिता/अभिभावक के साथ सेवा इस्तेमाल करें।',
        'सेवा का दुरुपयोग न करें: ऑटोमेटेड बाढ़, इसे तोड़ने की कोशिश, या वेब डेमो में असली मरीज़ों के दस्तावेज़ अपलोड करना मना है।',
      ],
    },
    {
      id: 'accuracy',
      heading: '4. सटीकता',
      paragraphs: [
        'लिखावट और फ़ोटो पढ़ना कठिन है और AI गलती कर सकता है। जब हमें पक्का नहीं होता तो हम बताते हैं, पर यह वादा नहीं कर सकते कि हर नतीजा पूरा या सही होगा। कीमतें और दवाई का डेटा पुराना हो सकता है; जहाँ कीमत दिखाते हैं वहाँ तारीख़ भी दिखती है। हमारी दवाई और टक्कर की सूचियाँ पूरी नहीं हैं: "कुछ नहीं मिला" का मतलब "सुरक्षित" नहीं है।',
      ],
    },
    {
      id: 'reminders',
      heading: '5. रिमाइंडर',
      paragraphs: [
        'रिमाइंडर सुविधा भर हैं। ये देर से आ सकते हैं या छूट सकते हैं (जैसे WhatsApp या आपका फ़ोन ऑफ़लाइन हो)। सुरक्षित दवाई लेने के लिए सिर्फ़ इन पर निर्भर न रहें।',
      ],
    },
    {
      id: 'availability',
      heading: '6. उपलब्धता और ज़िम्मेदारी',
      paragraphs: [
        'परीक्षण के दौरान सेवा "जैसी है वैसी" दी जा रही है, इस वादे के बिना कि यह हमेशा चलेगी। क़ानून जितनी इजाज़त दे, उतना, हम इसके जवाबों से लिए आपके फ़ैसलों या सेवा बंद रहने से हुए नुक़सान के लिए ज़िम्मेदार नहीं हैं। भारतीय क़ानून के तहत आपका कोई ऐसा अधिकार जो सीमित नहीं किया जा सकता, उसे यहाँ की कोई बात सीमित नहीं करती।',
      ],
    },
    {
      id: 'ending',
      heading: '7. रोकना और मिटाना',
      paragraphs: [
        'आप कभी भी रुक सकते हैं: STOP REMINDERS रिमाइंडर रोकता है और DELETE आपका डेटा मिटा देता है। सेवा का दुरुपयोग करने वाले नंबर को हम रोक सकते हैं।',
      ],
    },
    {
      id: 'law',
      heading: '8. लागू क़ानून और संपर्क',
      paragraphs: [
        'इन शर्तों पर भारत का क़ानून लागू होगा। संचालक के शहर की अदालतों (लॉन्च से पहले भरा जाएगा) का क्षेत्राधिकार होगा। सवाल के लिए फ़ूटर का संपर्क ई-मेल इस्तेमाल करें।',
      ],
    },
  ],
};

export const LEGAL: Record<'privacy' | 'terms', Record<Locale, LegalDocument>> = {
  privacy: { hi: privacyHi, en: privacyEn },
  terms: { hi: termsHi, en: termsEn },
};
