import { Router, raw } from 'express';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { z } from 'zod';
import { canUseLocalPersistence, isBlobStorageConfigured } from '../runtime.js';
import { isAuthenticatedRequest, requireApiAuth } from '../utils/auth.js';
import { MAX_UPLOAD_BYTES, UPLOAD_TYPES } from '../../shared/uploadPolicy.js';
import { createUploadIntent, getUploadIntent, assertUploadOpen, finalizeBlobUpload } from '../services/resourceUploads.js';
import { durableProcessingConfigured, wakeResourceProcessing } from '../services/resourceDispatch.js';
import { driveConnection, finalizeDriveUpload, prepareDriveUpload, receiveDriveChunk } from '../services/googleDrive.js';
import { DRIVE_CHUNK_BYTES } from '../services/googleDriveClient.js';

const router = Router();
const ALLOWED_CONTENT_TYPES = Object.values(UPLOAD_TYPES);
const ClientPayload = z.object({
  kind: z.enum(['resource', 'note']),
  contentType: z.string().max(200),
  size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  uploadId: z.string().uuid().optional(),
});
const IntentInput = z.object({
  request_key: z.string().min(1).max(200), original_name: z.string().min(1).max(255),
  mime_type: z.string().max(200), size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  attach_to_id: z.string().min(1).max(200).optional(), attach_to_type: z.enum(['task', 'goal']).optional(),
});

router.post('/resources', requireApiAuth, async (req, res) => {
  const drive = await driveConnection();
  if (drive && !drive.encrypted_refresh_token) return res.status(409).json({ error: 'Reconnect Google Drive in Resource Library before uploading.' });
  const intent = await createUploadIntent(IntentInput.parse(req.body), undefined, drive ? 'drive' : 'blob');
  assertUploadOpen(intent);
  res.json({ id: intent.id, pathname: intent.pathname, state: intent.state, storage_provider: intent.storage_provider });
});
router.get('/resources/:id', requireApiAuth, async (req, res) => {
  const intent = await getUploadIntent(req.params.id);
  assertUploadOpen(intent);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ id: intent.id, pathname: intent.pathname, state: intent.state, storage_provider: intent.storage_provider });
});
router.post('/resources/:id/complete', requireApiAuth, async (req, res) => {
  const intent = await getUploadIntent(req.params.id);
  const result = intent.storage_provider === 'drive' ? await finalizeDriveUpload(intent.id) : await finalizeBlobUpload(intent.id);
  res.json(result);
  wakeResourceProcessing();
});

router.post('/resources/:id/drive-session', requireApiAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await prepareDriveUpload(req.params.id));
  wakeResourceProcessing();
});
router.put('/resources/:id/drive-chunk', requireApiAuth, raw({ type: 'application/octet-stream', limit: DRIVE_CHUNK_BYTES }), async (req, res) => {
  const offset = Number(req.query.offset);
  if (!/^\d+$/.test(String(req.query.offset)) || !Number.isSafeInteger(offset) || !Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Invalid upload chunk' });
  const result = await receiveDriveChunk(req.params.id, offset, req.body);
  res.json(result);
  if (result.complete) wakeResourceProcessing();
});

router.get('/capabilities', requireApiAuth, async (_req, res) => {
  const drive = await driveConnection();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ private_blob: isBlobStorageConfigured(), google_drive: Boolean(drive?.encrypted_refresh_token), drive_reconnect_required: Boolean(drive && !drive.encrypted_refresh_token), local_uploads: canUseLocalPersistence(), max_bytes: MAX_UPLOAD_BYTES,
    persistent_uploads: true, durable_processing: durableProcessingConfigured() || canUseLocalPersistence() });
});

router.post('/token', async (req, res) => {
  if (!isBlobStorageConfigured()) return res.status(503).json({ error: 'Private Blob storage is not configured' });
  const body = req.body as HandleUploadBody;
  if (body?.type === 'blob.generate-client-token' && !isAuthenticatedRequest(req)) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const response = await handleUpload({
      request: req,
      body,
      onBeforeGenerateToken: async (pathname, rawPayload) => {
        const payload = ClientPayload.parse(JSON.parse(rawPayload ?? '{}'));
        if (!ALLOWED_CONTENT_TYPES.includes(payload.contentType)) {
          throw Object.assign(new Error('Unsupported file type'), { status: 400 });
        }
        if (payload.kind === 'resource') {
          if (!payload.uploadId) throw Object.assign(new Error('Refresh the page before uploading resources'), { status: 409 });
          const intent = await getUploadIntent(payload.uploadId);
          assertUploadOpen(intent);
          if (intent.storage_provider === 'drive') throw Object.assign(new Error('This upload uses Google Drive'), { status: 409 });
          if (pathname !== intent.pathname || payload.contentType !== intent.mime_type || payload.size !== Number(intent.size)) {
            throw Object.assign(new Error('Upload token does not match the saved upload intent'), { status: 400 });
          }
          return {
            allowedContentTypes: [intent.mime_type], maximumSizeInBytes: Number(intent.size),
            addRandomSuffix: false, allowOverwrite: false,
            validUntil: Math.min(Date.now() + 60 * 60_000, new Date(intent.expires_at).getTime()),
            tokenPayload: JSON.stringify({ kind: 'resource', uploadId: intent.id }),
          };
        }
        const prefix = `marina/${payload.kind}/`;
        if (!pathname.startsWith(prefix) || pathname.includes('..') || pathname.length > 512) {
          throw Object.assign(new Error('Invalid upload path'), { status: 400 });
        }
        return {
          allowedContentTypes: [payload.contentType],
          maximumSizeInBytes: Math.min(payload.size, MAX_UPLOAD_BYTES),
          addRandomSuffix: true,
          tokenPayload: rawPayload,
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const payload = JSON.parse(tokenPayload ?? '{}');
        if (payload.kind === 'resource' && typeof payload.uploadId === 'string') {
          await finalizeBlobUpload(payload.uploadId, blob);
          wakeResourceProcessing();
        }
      },
    });
    res.json(response);
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status
      : err instanceof z.ZodError || err instanceof SyntaxError ? 400 : 500;
    res.status(status).json({ error: status >= 500 ? 'Upload service is temporarily unavailable' : err instanceof Error ? err.message : 'Upload authorization failed' });
  }
});

export { router as uploadsRouter };
