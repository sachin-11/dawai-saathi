import sharp from 'sharp';

import { DEMO_MAX_IMAGE_PX, type DemoMime } from './demo.constants';

export class UnsupportedUploadError extends Error {
  constructor() {
    super('unsupported upload');
    this.name = 'UnsupportedUploadError';
  }
}

/** Real type from the first bytes. Returns null for anything we do not accept. */
export function sniffMime(bytes: Buffer): DemoMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    return 'application/pdf';
  }
  return null;
}

export interface SanitizedUpload {
  bytes: Buffer;
  mime: DemoMime;
  extension: 'jpg' | 'pdf';
}

/**
 * Server-side EXIF strip (the browser also strips, but a client is never trusted): an image is
 * auto-oriented, scaled down and RE-ENCODED from raw pixels as a new JPEG, so EXIF, GPS, ICC and any
 * trailing data are gone. A PDF has no pixels to re-encode and is passed on after its magic bytes
 * checked out (the AI service renders its first pages itself).
 */
export async function sanitizeUpload(bytes: Buffer): Promise<SanitizedUpload> {
  const mime = sniffMime(bytes);
  if (!mime) throw new UnsupportedUploadError();
  if (mime === 'application/pdf') return { bytes, mime, extension: 'pdf' };
  try {
    const out = await sharp(bytes, { limitInputPixels: 80_000_000, failOn: 'error' })
      .rotate()
      .resize({
        width: DEMO_MAX_IMAGE_PX,
        height: DEMO_MAX_IMAGE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 88 })
      .toBuffer();
    return { bytes: out, mime: 'image/jpeg', extension: 'jpg' };
  } catch {
    throw new UnsupportedUploadError();
  }
}
