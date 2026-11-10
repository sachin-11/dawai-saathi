/** The bundled synthetic samples of the web demo (images live in `apps/web/public/samples/`). */
export const DEMO_SAMPLE_IDS = [
  'rx_clean',
  'rx_messy',
  'rx_duplicate_paracetamol',
  'rx_generic_savings',
  'lab_critical',
  'lab_normal',
  'rx_unreadable',
  'rx_injection',
] as const;
export type DemoSampleId = (typeof DEMO_SAMPLE_IDS)[number];

export const DEMO_LANGUAGES = ['hi', 'en'] as const;
export type DemoLanguage = (typeof DEMO_LANGUAGES)[number];

/** Magic-byte sniffing: the client's content type is never trusted. */
export type DemoMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

export const DEMO_S3_PREFIX = 'demo/';
export const DEMO_IP_HEADER = 'x-demo-client-ip';
export const DEMO_MAX_IMAGE_PX = 2000;
