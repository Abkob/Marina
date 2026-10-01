import { Router } from 'express';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { z } from 'zod';
import { canUseLocalPersistence, isBlobStorageConfigured } from '../runtime.js';
import { isAuthenticatedRequest, requireApiAuth } from '../utils/auth.js';
import { MAX_UPLOAD_BYTES, UPLOAD_TYPES } from '../../shared/uploadPolicy.js';
import { createUploadIntent, getUploadIntent, assertUploadOpen, finalizeBlobUpload } from '../services/resourceUploads.js';
import { durableProcessingConfigured, wakeResourceProcessing } from '../services/resourceDispatch.js';

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
  const intent = await createUploadIntent(IntentInput.parse(req.body));
  assertUploadOpen(intent);
  res.json({ id: intent.id, pathname: intent.pathname, state: intent.state });
});
router.get('/resources/:id', requireApiAuth, async (req, res) => {
  const intent = await getUploadIntent(req.params.id);
  assertUploadOpen(intent);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ id: intent.id, pathname: intent.pathname, state: intent.state });
});
router.post('/resources/:id/complete', requireApiAuth, async (req, res) => {
  const result = await finalizeBlobUpload(req.params.id);
  res.json(result);
  wakeResourceProcessing();
});

router.get('/capabilities', requireApiAuth, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ private_blob: isBlobStorageConfigured(), local_uploads: canUseLocalPersistence(), max_bytes: MAX_UPLOAD_BYTES,
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
