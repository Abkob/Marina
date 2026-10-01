import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkDriveResponse, createDriveSession, driveDocument, driveFileId, driveListQuery, driveReference, getDriveFile, isDriveReference, openDriveContent, receivedOffset, sendDriveChunk, validateSessionUrl, DRIVE_CHUNK_BYTES } from '../../../server/services/googleDriveClient';
const file = { id: 'file_123', name: 'notes.txt', mimeType: 'text/plain', size: '4', version: '12' };
afterEach(() => vi.unstubAllGlobals());
describe('Google Drive storage boundaries', () => {
  it('round-trips an opaque Drive reference without a public download URL', () => {
    expect(driveFileId(driveReference('abc_-123'))).toBe('abc_-123'); expect(isDriveReference('gdrive://abc')).toBe(true);
    expect(isDriveReference('/tmp/abc')).toBe(false);
  });
  it.each(['', '../abc', 'https://example.com', 'abc?x=1', 'abc/def', 'abc\n', 'a'.repeat(201)])('rejects unsafe Drive IDs: %j', value => {
    expect(() => driveReference(value)).toThrow(); expect(() => driveFileId(`gdrive://${value}`)).toThrow();
  });
  it.each(['http://www.googleapis.com/upload/drive/v3/files?upload_id=1', 'https://evil.test/upload/drive/v3/files?upload_id=1',
    'https://www.googleapis.com.evil.test/upload/drive/v3/files?upload_id=1', 'https://user:pass@www.googleapis.com/upload/drive/v3/files?upload_id=1',
    'https://www.googleapis.com/drive/v3/files?upload_id=1', 'https://www.googleapis.com/upload/drive/v3/files'])('rejects token-exfiltrating upload destinations', url => {
    expect(() => validateSessionUrl(url)).toThrow();
  });
  it('accepts only Google upload sessions', () => {
    const url = 'https://www.googleapis.com/upload/drive/v3/files?upload_id=opaque'; expect(validateSessionUrl(url)).toBe(url);
  });
  it('escapes Drive query syntax and never accepts raw query expressions', () => {
    expect(driveListQuery("x' or trashed=true", 'folder1')).toContain("name contains 'x\\' or trashed=true'");
    expect(driveListQuery('a\\b')).toContain("a\\\\b"); expect(() => driveListQuery('', "x' or true")).toThrow();
  });
  it.each(['document', 'spreadsheet', 'presentation'])('exports native Google %s as a PDF', kind => {
    expect(driveDocument({ ...file, name: 'Research / October', mimeType: `application/vnd.google-apps.${kind}` })).toEqual({ name: 'Research _ October.pdf', mime: 'application/pdf', native: true });
  });
  it.each([{ trashed: true }, { capabilities: { canDownload: false } }, { name: 'program.exe' }, { size: '0' }, { size: String(50*1024*1024+1) }])('rejects inaccessible or unsupported documents', override => {
    expect(() => driveDocument({ ...file, ...override })).toThrow();
  });
  it.each([[401, undefined, 401], [404, undefined, 404], [410, undefined, 404], [429, undefined, 503], [500, undefined, 503], [503, undefined, 503],
    [403, 'storageQuotaExceeded', 507], [403, 'userRateLimitExceeded', 503], [403, 'insufficientPermissions', 403], [400, 'badRequest', 502]])('sanitizes provider failure %s/%s', async (status, reason, expected) => {
    const response = new Response(JSON.stringify({ error: { message: 'secret-token-provider-body', errors: [{ reason }] } }), { status: Number(status) });
    await expect(checkDriveResponse(response)).rejects.toMatchObject({ status: expected, message: expect.not.stringContaining('secret-token') });
  });
  it('reads the acknowledged offset instead of assuming the whole chunk arrived', () => {
    expect(receivedOffset(new Response(null, { status: 308, headers: { Range: 'bytes=0-262143' } }), 500000)).toBe(262144);
    expect(receivedOffset(new Response(null, { status: 308 }), 500000)).toBe(0);
  });
  it.each(['bytes=0-999999999', 'bytes=10-20', 'wrong', 'bytes=0-NaN'])('rejects invalid Drive offsets', range => {
    expect(() => receivedOffset(new Response(null, { status: 308, headers: { Range: range } }), 500000)).toThrow();
  });
  it.each([[-1, 10], [1.5, 10], [0, 0], [0, DRIVE_CHUNK_BYTES+1], [0, 10]])('rejects invalid chunk offset/size (%s/%s)', async (offset, size) => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(sendDriveChunk('token', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=1', 5*1024*1024, offset, Buffer.alloc(size))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('sends small final chunks with the exact content range', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 })); vi.stubGlobal('fetch', fetch);
    expect(await sendDriveChunk('test', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=1', 4, 0, Buffer.from('test'))).toBe(4);
    expect(fetch.mock.calls[0][1].headers['Content-Range']).toBe('bytes 0-3/4');
  });
  it('checks resumable state with an empty PUT, without following HTTP 308 redirects', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 308 })); vi.stubGlobal('fetch', fetch);
    await sendDriveChunk('test', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=1', 123);
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual', headers: { 'Content-Range': 'bytes */123', 'Content-Length': '0' } });
  });
  it('verifies the response range before streaming private content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('te', { status: 206, headers: { 'Content-Range': 'bytes 1-2/4' } })));
    await expect(openDriveContent('test', file, { start: 0, end: 1 })).rejects.toThrow('unexpected byte range');
  });
  it('streams the correct binary range', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('te', { status: 206, headers: { 'Content-Range': 'bytes 0-1/4' } })));
    const opened = await openDriveContent('test', file, { start: 0, end: 1 });
    expect(opened).toMatchObject({ size: 2, statusCode: 206, contentRange: 'bytes 0-1/4' }); opened.stream.destroy();
  });
  it('does not return a provider session URI from metadata', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(file))); vi.stubGlobal('fetch', fetch);
    await getDriveFile('test', file.id); expect(fetch.mock.calls[0][1].redirect).toBe('error');
  });
});
