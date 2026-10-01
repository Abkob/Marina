// Shared by the picker, token endpoint, and worker. Never trust browser MIME labels.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const UPLOAD_TYPES: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};
export const UPLOAD_ACCEPT = Object.keys(UPLOAD_TYPES).map(extension => `.${extension}`).join(',');

export function uploadMime(name: string): string | undefined {
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return Object.hasOwn(UPLOAD_TYPES, extension) ? UPLOAD_TYPES[extension] : undefined;
}

export function validateUploadMetadata(name: string, size: number, mime?: string): string {
  if (!name.trim() || name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(name)) throw new Error('Invalid filename');
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('This file is empty. Choose a file with content.');
  if (size > MAX_UPLOAD_BYTES) throw new Error('File exceeds the 50 MB limit. Choose a smaller file.');
  const expected = uploadMime(name);
  if (!expected) throw new Error('Unsupported file type. Use PDF, TXT, MD, CSV, PNG, JPG, GIF or WebP. Export Word documents as PDF first.');
  if (mime && mime !== expected) throw new Error('File type does not match its filename');
  return expected;
}
