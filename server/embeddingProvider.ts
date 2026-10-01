import { GoogleGenAI } from '@google/genai';
import { EMBED_MODEL, EMBED_DIMENSION } from './config/providers.js';

export { EMBED_MODEL, EMBED_DIMENSION };

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required for Gemini embeddings');
  }
  client ??= new GoogleGenAI({ apiKey });
  return client;
}

function extractEmbedding(
  response: Awaited<ReturnType<GoogleGenAI['models']['embedContent']>>,
): number[] {
  const values = response.embeddings?.[0]?.values;
  if (!values) {
    throw new Error(`Gemini ${EMBED_MODEL} returned no embedding`);
  }
  if (values.length !== EMBED_DIMENSION) {
    throw new Error(
      `Gemini ${EMBED_MODEL} returned ${values.length} dimensions; expected ${EMBED_DIMENSION}`,
    );
  }
  return values;
}

function documentTitle(text: string): string {
  return text.match(/^Title:\s*(.+)$/im)?.[1]?.trim() || 'none';
}

export async function embedDocument(text: string): Promise<number[]> {
  const response = await getClient().models.embedContent({
    model: EMBED_MODEL,
    contents: `title: ${documentTitle(text)} | text: ${text}`,
    config: { outputDimensionality: EMBED_DIMENSION, httpOptions: { timeout: 45_000 } },
  });
  return extractEmbedding(response);
}

export async function embedQuery(text: string): Promise<number[]> {
  const response = await getClient().models.embedContent({
    model: EMBED_MODEL,
    contents: `task: search result | query: ${text}`,
    config: { outputDimensionality: EMBED_DIMENSION, httpOptions: { timeout: 30_000 } },
  });
  return extractEmbedding(response);
}
