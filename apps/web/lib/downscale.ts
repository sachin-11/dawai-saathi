export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_SIDE_PX = 1600;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export class UploadRejected extends Error {
  constructor(readonly reason: 'unsupported_file' | 'file_too_large') {
    super(reason);
    this.name = 'UploadRejected';
  }
}

/**
 * Before upload: draw the image on a canvas and re-encode it as a JPEG. This (1) shrinks it, (2) drops
 * EXIF/GPS (a canvas has no metadata) and (3) keeps phone photos far below the 5 MB limit. The gateway
 * strips and re-encodes again; the browser is only the first, polite layer. PDFs pass through.
 */
export async function prepareUpload(file: File): Promise<File> {
  if (!ACCEPTED.includes(file.type)) throw new UploadRejected('unsupported_file');
  if (file.type === 'application/pdf') {
    if (file.size > MAX_UPLOAD_BYTES) throw new UploadRejected('file_too_large');
    return file;
  }
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new UploadRejected('unsupported_file');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.85),
  );
  if (!blob) throw new UploadRejected('unsupported_file');
  if (blob.size > MAX_UPLOAD_BYTES) throw new UploadRejected('file_too_large');
  return new File([blob], 'upload.jpg', { type: 'image/jpeg' });
}
