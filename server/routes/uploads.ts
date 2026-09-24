import { Router } from 'express';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { z } from 'zod';
import { isBlobStorageConfigured } from '../runtime.js';
import { isAuthenticatedRequest, requireApiAuth } from '../utils/auth.js';

const router = Router();
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'text/plain', 'text/markdown', 'text/csv',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
];
const ClientPayload = z.object({
  kind: z.enum(['resource', 'note']),
  contentType: z.string().max(200),
  size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
});

router.get('/capabilities', requireApiAuth, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ private_blob: isBlobStorageConfigured(), max_bytes: MAX_UPLOAD_BYTES });
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
      onUploadCompleted: async () => {
        // The authenticated browser registers the completed immutable Blob in
        // the database. Keeping this callback side-effect free makes retries safe.
      },
    });
    res.json(response);
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 400;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Upload authorization failed' });
  }
});

export { router as uploadsRouter };
