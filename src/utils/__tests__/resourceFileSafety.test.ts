import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, validateUploadMetadata } from '../../../shared/uploadPolicy';
import { validFileSignature } from '../../../server/services/uploadValidation';
import { parseFileRange } from '../../../server/services/fileStorage';
import { canPreviewResource, resourceMime, processingLabel } from '../resourceFiles';
import type { DBResource } from '../../db/schema';

describe('file admission and content validation', () => {
  it.each(['notes.txt', 'Données.csv', 'بحث عربي.pdf', 'README.MD', 'camera.JPG'])('accepts portable filenames: %s', name => {
    expect(validateUploadMetadata(name, 1)).toBeTruthy();
  });
  it.each(['', '../notes.txt', 'C:\\notes.txt', 'a\0.pdf', 'line\n.txt', 'a'.repeat(256) + '.txt', '   '])('rejects unsafe names: %s', name => {
    expect(() => validateUploadMetadata(name, 10)).toThrow();
  });
  it.each(['page.html', 'script.svg', 'test.js', 'payload.exe', 'paper.docx', 'file', 'pdf', 'image.png.exe', 'a.constructor', 'a.__proto__'])('rejects unsupported/active formats: %s', name => {
    expect(() => validateUploadMetadata(name, 10)).toThrow();
  });
  it.each([0, -1, NaN, Infinity, 1.5, MAX_UPLOAD_BYTES + 1])('rejects invalid size %s', size => {
    expect(() => validateUploadMetadata('file.pdf', size)).toThrow();
  });
  it('accepts exactly the maximum and rejects a MIME/extension mismatch', () => {
    expect(validateUploadMetadata('file.pdf', MAX_UPLOAD_BYTES, 'application/pdf')).toBe('application/pdf');
    expect(() => validateUploadMetadata('file.pdf', 10, 'text/plain')).toThrow('does not match');
  });
  it.each([
    ['application/pdf', [37,80,68,70,45]], ['image/png', [137,80,78,71,13,10,26,10]],
    ['image/jpeg', [255,216,255]], ['image/gif', [71,73,70,56,55,97]], ['image/gif', [71,73,70,56,57,97]],
    ['image/webp', [82,73,70,70,0,0,0,0,87,69,66,80]],
  ] as const)('checks signatures for %s', (mime, header) => {
    expect(validFileSignature(Uint8Array.from(header), mime)).toBe(true);
    expect(validFileSignature(Uint8Array.from(header.slice(0, -1)), mime)).toBe(false);
    expect(validFileSignature(Buffer.from('not an image'), mime)).toBe(false);
  });
  it('requires both WebP signatures', () => {
    expect(validFileSignature(Buffer.from('RIFF0000NOPE'), 'image/webp')).toBe(false);
    expect(validFileSignature(Buffer.from('NOPE0000WEBP'), 'image/webp')).toBe(false);
  });
  it('accepts UTF-8 and rejects binary bytes disguised as text', () => {
    expect(validFileSignature(Buffer.from('مرحباً 世界'), 'text/plain')).toBe(true);
    expect(validFileSignature(Buffer.from([0xff, 0xfe, 0]), 'text/plain')).toBe(false);
    expect(validFileSignature(Buffer.from('hello\0world'), 'text/plain')).toBe(false);
    expect(validFileSignature(Buffer.from('<script>alert(1)</script>'), 'text/html')).toBe(false);
  });
});

describe('viewer byte ranges', () => {
  it.each([
    ['bytes=0-9', { start: 0, end: 9 }], ['bytes=90-', { start: 90, end: 99 }],
    ['bytes=-10', { start: 90, end: 99 }], ['bytes=-150', { start: 0, end: 99 }],
    ['bytes=0-10000', { start: 0, end: 99 }], [undefined, null],
  ])('handles %s', (header, expected) => expect(parseFileRange(header as string | undefined, 100)).toEqual(expected));
  it.each(['bytes=100-', 'bytes=5-3', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-8', 'items=1-2', 'bytes=a-b', 'bytes=999999999999999999999-'])('rejects invalid range %s', header => {
    expect(() => parseFileRange(header, 100)).toThrow();
  });
  it('rejects a range on an empty file', () => expect(() => parseFileRange('bytes=0-', 0)).toThrow());
});

describe('file identity and processing feedback', () => {
  const file = { url: '/api/resources/blob/uuid', file_path: 'https://x.private.blob.vercel-storage.com/a.pdf', mime_type: 'application/pdf' } as DBResource;
  it('previews UUID cloud routes using persisted MIME', () => expect(canPreviewResource(file)).toBe(true));
  it('recovers legacy MIME from the stored original', () => expect(resourceMime({ ...file, mime_type: null })).toBe('application/pdf'));
  it.each(['pending', 'invalid'] as const)('blocks preview before validation: %s', state => {
    expect(canPreviewResource({ ...file, file_validation: state })).toBe(false);
  });
  it('supports CSV previews and rejects active SVG content', () => {
    expect(canPreviewResource({ ...file, mime_type: null, file_path: '/files/table.csv' })).toBe(true);
    expect(canPreviewResource({ ...file, mime_type: null, file_path: '/files/active.svg' })).toBe(false);
  });
  it('distinguishes configuration failure from ordinary waiting', () => {
    expect(processingLabel({ status: 'queued', stage: 'extract', chunks: 0, embedded: 0, worker_available: false })).toMatch(/needs to be connected/);
    expect(processingLabel({ status: 'queued', stage: 'embed', chunks: 20, embedded: 3 })).toMatch(/waiting to index/);
  });
  it('shows a terminal error without claiming indexing is still running', () => {
    expect(processingLabel({ status: 'failed', stage: 'embed', error: 'Index provider unavailable', chunks: 20, embedded: 3 })).toBe('Index provider unavailable');
  });
});
