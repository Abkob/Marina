import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { query } from '../db.js';
import { searchResearchEvidence } from '../services/researchRag.js';

export const researchRouter = Router();

researchRouter.get('/search', async (req, res) => {
  const parsed = z.object({ q: z.string().min(2), limit: z.coerce.number().int().min(1).max(25).default(8) }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'A research query of at least 2 characters is required.' });
  const evidence = await searchResearchEvidence(parsed.data.q, parsed.data.limit);
  res.json({ query: parsed.data.q, evidence, evidence_count: evidence.length });
});

researchRouter.post('/papers/from-resource/:resourceId', async (req, res) => {
  const body = z.object({ doi: z.string().optional(), authors: z.array(z.string()).default([]), publication_year: z.number().int().optional(), venue: z.string().optional(), abstract: z.string().optional() }).parse(req.body ?? {});
  const { rows } = await query<{ id: string }>('SELECT id FROM resources WHERE id=$1', [req.params.resourceId]);
  if (!rows[0]) return res.status(404).json({ error: 'Resource not found' });
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const { rows: papers } = await query(
    `INSERT INTO research_papers (id,resource_id,doi,authors_json,publication_year,venue,abstract,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
     ON CONFLICT (resource_id) DO UPDATE SET doi=EXCLUDED.doi, authors_json=EXCLUDED.authors_json,
       publication_year=EXCLUDED.publication_year, venue=EXCLUDED.venue, abstract=EXCLUDED.abstract, updated_at=EXCLUDED.updated_at
     RETURNING *`,
    [id, req.params.resourceId, body.doi ?? null, JSON.stringify(body.authors), body.publication_year ?? null, body.venue ?? null, body.abstract ?? null, now],
  );
  res.status(201).json(papers[0]);
});
