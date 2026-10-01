import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
const mocks = vi.hoisted(() => ({ intent: vi.fn(), complete: vi.fn(), open: vi.fn(), auth: vi.fn(() => true), wake: vi.fn() }));
vi.mock('../../../server/services/resourceUploads', () => ({ getUploadIntent: mocks.intent, assertUploadOpen: mocks.open, finalizeBlobUpload: mocks.complete, createUploadIntent: vi.fn() }));
vi.mock('../../../server/services/resourceDispatch', () => ({ durableProcessingConfigured: () => true, wakeResourceProcessing: mocks.wake }));
vi.mock('../../../server/runtime', () => ({ isBlobStorageConfigured: () => true, canUseLocalPersistence: () => false }));
vi.mock('../../../server/utils/auth', () => ({ isAuthenticatedRequest: mocks.auth, requireApiAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('@vercel/blob/client', () => ({ handleUpload: async (options: any) => {
  if (options.body.type === 'blob.upload-completed') {
    await options.onUploadCompleted(options.body.payload); return { completed: true };
  }
  return options.onBeforeGenerateToken(options.body.pathname, options.body.clientPayload);
} }));
import { uploadsRouter } from '../../../server/routes/uploads';

const uploadId = 'dde88d48-e477-4022-80a5-adc16bc64790';
const pathname = `marina/resource/${uploadId}.txt`;
const handler = uploadsRouter.stack.find(layer => layer.route?.path === '/token')!.route.stack[0].handle;
async function request(body: object) {
  let status = 200; let json: any;
  const res = { status: (code: number) => { status = code; return res; }, json: (value: unknown) => { json = value; return res; } };
  await handler({ body, headers: {} } as Request, res as unknown as Response, () => undefined);
  return { status, json };
}
function token(overrides: Record<string, unknown> = {}) {
  return { type: 'blob.generate-client-token', pathname, clientPayload: JSON.stringify({ kind: 'resource', uploadId, contentType: 'text/plain', size: 10, ...overrides }) };
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.auth.mockReturnValue(true);
  mocks.intent.mockResolvedValue({ id: uploadId, pathname, mime_type: 'text/plain', size: 10, expires_at: new Date(Date.now() + 86400000) });
  mocks.complete.mockResolvedValue({ id: uploadId });
});
describe('resource transfer authorization and callbacks', () => {
  it('issues an immutable token restricted to exact size, type, path, and expiry', async () => {
    const response = await request(token());
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ maximumSizeInBytes: 10, allowedContentTypes: ['text/plain'], addRandomSuffix: false, allowOverwrite: false });
    expect(response.json.validUntil).toBeLessThanOrEqual(Date.now() + 3600000);
    expect(JSON.parse(response.json.tokenPayload)).toEqual({ kind: 'resource', uploadId });
  });
  it('rejects token issuance without authentication', async () => {
    mocks.auth.mockReturnValue(false); expect((await request(token())).status).toBe(401); expect(mocks.intent).not.toHaveBeenCalled();
  });
  it.each([{ size: 11 }, { contentType: 'application/pdf' }, { uploadId: undefined }])('rejects metadata/identity changes: %j', async overrides => {
    expect((await request(token(overrides))).status).toBeGreaterThanOrEqual(400);
  });
  it('rejects a path belonging to another intent', async () => {
    expect((await request({ ...token(), pathname: 'marina/resource/another.txt' })).status).toBe(400);
  });
  it('does not swallow completion failures; returns a retryable server error', async () => {
    mocks.complete.mockRejectedValue(new Error('database unavailable'));
    const callback = { type: 'blob.upload-completed', payload: { blob: { url: 'x', pathname }, tokenPayload: JSON.stringify({ kind: 'resource', uploadId }) } };
    expect((await request(callback)).status).toBe(500); expect(mocks.wake).not.toHaveBeenCalled();
  });
  it('finalizes a verified completion using its token identity without a browser cookie', async () => {
    mocks.auth.mockReturnValue(false);
    const blob = { url: 'x', pathname };
    expect((await request({ type: 'blob.upload-completed', payload: { blob, tokenPayload: JSON.stringify({ kind: 'resource', uploadId }) } })).status).toBe(200);
    expect(mocks.complete).toHaveBeenCalledWith(uploadId, blob); expect(mocks.wake).toHaveBeenCalledTimes(1);
  });
  it('keeps note callbacks separate from resource registration', async () => {
    await request({ type: 'blob.upload-completed', payload: { blob: {}, tokenPayload: JSON.stringify({ kind: 'note' }) } });
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
