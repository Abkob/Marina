// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeDocumentImage, transcribeDocumentImage, parseDocumentImage, rerankPassages, MAX_RERANK_PASSAGES } from '../../../server/services/nvidiaEvidence.js';
const fetchMock = vi.fn();
const rows = [{ content: 'irrelevant', id: 'a' }, { content: 'relevant', id: 'b' }];
const image = 'data:image/png;base64,aGVsbG8=';
beforeEach(() => { vi.stubEnv('NVIDIA_API_KEY', 'synthetic-key'); vi.stubEnv('NVIDIA_KIMI_API_KEY', ''); vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const detection = (text = 'NEBULA-731') => ({ text_prediction: { text, confidence: 0.9 }, bounding_box: { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] } });

describe('NVIDIA evidence contracts', () => {
  it.each(['moonshotai/kimi-k3', 'meta/muse-glimmer-30b'])('uses %s for transcription without inventing detector confidence', async model => {
    fetchMock.mockResolvedValue(json({ choices: [{ message: { content: 'NEBULA-731' }, finish_reason: 'stop' }] }));
    expect(await transcribeDocumentImage(image, model)).toMatchObject({ model, text: 'NEBULA-731', evidence_type: 'model_transcription', regions: [] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(model);
  });
  it.each(['moonshotai/kimi-k3', 'meta/muse-glimmer-30b'])('uses %s for layout reading with an explicit extraction limitation', async model => {
    fetchMock.mockResolvedValue(json({ choices: [{ message: { content: '| before | after |\n|25|45|' }, finish_reason: 'stop' }] }));
    const result = await parseDocumentImage(image, model);
    expect(result.model).toBe(model); expect(result.warning).toContain('not a validated cell grid');
  });
  it('uses the dedicated Kimi key for visual requests only', async () => {
    vi.stubEnv('NVIDIA_KIMI_API_KEY', 'kimi-synthetic');
    fetchMock.mockImplementation(async () => json({ choices: [{ message: { content: '25' }, finish_reason: 'stop' }] }));
    await analyzeDocumentImage('q', image, 'moonshotai/kimi-k3');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer kimi-synthetic');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ temperature: 1, reasoning_effort: 'low' });
    expect(body).not.toHaveProperty('reasoning_budget');
    await analyzeDocumentImage('q', image, 'meta/muse-glimmer-30b');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer synthetic-key');
  });
  it('orders by logits without detaching source identities or mutating input', async () => {
    fetchMock.mockResolvedValue(json({ rankings: [{ index: 0, logit: -9 }, { index: 1, logit: -1 }] }));
    const result = await rerankPassages('question', rows);
    expect(result).toEqual({ rows: [rows[1], rows[0]], status: 'applied' });
    expect(result.rows[0]).toBe(rows[1]); expect(rows[0].id).toBe('a');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ query: { text: 'question' }, passages: [{ text: 'irrelevant' }, { text: 'relevant' }] });
    expect(fetchMock.mock.calls[0][0]).toContain('rerank-vl-1b-v2/reranking');
  });
  it.each([
    [], [{ index: 0, logit: 2 }], [{ index: 0, logit: 2 }, { index: 0, logit: 1 }],
    [{ index: 0, logit: 2 }, { index: 2, logit: 1 }], [{ index: -1, logit: 2 }, { index: 1, logit: 1 }],
    [{ index: 0.5, logit: 2 }, { index: 1, logit: 1 }], [{ index: 0, logit: '2' }, { index: 1, logit: 1 }],
    [{ index: 0, logit: null }, { index: 1, logit: 1 }],
  ].map(rankings => ({ rankings })))('preserves every original candidate for malformed rankings %#', async ({ rankings }) => {
    fetchMock.mockResolvedValue(json({ rankings }));
    expect(await rerankPassages('question', rows)).toEqual({ rows, status: 'unavailable' });
  });
  it.each([401, 402, 422, 429, 500, 503])('degrades visibly on HTTP %i', async status => {
    fetchMock.mockResolvedValue(json({ secret: 'private provider error' }, status));
    expect(await rerankPassages('question', rows)).toEqual({ rows, status: 'unavailable' });
  });
  it('preserves hybrid ranking when the provider times out', async () => {
    fetchMock.mockRejectedValue(new DOMException('private prompt text', 'TimeoutError'));
    expect((await rerankPassages('question', rows)).status).toBe('unavailable');
  });
  it('does not call the provider without a configured key or for a single passage', async () => {
    vi.stubEnv('NVIDIA_API_KEY', '');
    expect((await rerankPassages('question', rows)).status).toBe('disabled');
    expect((await rerankPassages('question', rows.slice(0, 1))).status).toBe('not_needed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects excessive candidates rather than silently dropping sources', async () => {
    await expect(rerankPassages('question', Array(MAX_RERANK_PASSAGES + 1).fill(rows[0]))).rejects.toThrow('Too many');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('bounds passage and query inputs sent to the shared service', async () => {
    fetchMock.mockResolvedValue(json({ rankings: [{ index: 0, logit: 1 }, { index: 1, logit: 0 }] }));
    await rerankPassages('q'.repeat(5000), [{ content: 'x'.repeat(5000) }, rows[1]]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.query.text).toHaveLength(2000); expect(body.passages[0].text).toHaveLength(2400);
  });
  it('returns visual interpretation without exposing reasoning or image bytes', async () => {
    fetchMock.mockResolvedValue(json({ choices: [{ message: { content: 'After: 45, Before: 25.', reasoning_content: 'private reasoning' }, finish_reason: 'stop' }] }));
    const result = await analyzeDocumentImage('Read the bars.', image);
    expect(result).toMatchObject({ analysis: 'After: 45, Before: 25.', evidence_type: 'model_interpretation_of_image' });
    expect(JSON.stringify(result)).not.toContain('private reasoning'); expect(JSON.stringify(result)).not.toContain('base64');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0].content).toContain('untrusted'); expect(body.messages[1].content[0].image_url.url).toBe(image);
  });
  it.each(['https://example.com/private.png', 'data:image/svg+xml;base64,aGVsbG8=', 'data:image/png;base64,%%%%', 'data:text/html;base64,aGVsbG8='])('rejects unsupported image input %# before sending', async url => {
    await expect(analyzeDocumentImage('q', url)).rejects.toThrow('unsupported'); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects oversized images before an API request', async () => {
    await expect(analyzeDocumentImage('q', `data:image/png;base64,${Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64')}`)).rejects.toThrow('too large');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    { choices: [] }, { choices: [{ message: { content: '' }, finish_reason: 'stop' }] },
    { choices: [{ message: { reasoning_content: 'No final answer' }, finish_reason: 'stop' }] },
    { choices: [{ message: { content: 'Unfinished claim' }, finish_reason: 'length' }] },
  ])('rejects absent or incomplete final visual answers %#', async body => {
    fetchMock.mockResolvedValue(json(body)); await expect(analyzeDocumentImage('q', image)).rejects.toThrow('incomplete');
  });
  it('surfaces service exhaustion without leaking provider messages', async () => {
    fetchMock.mockResolvedValue(json({ error: 'secret source content' }, 503));
    await expect(analyzeDocumentImage('q', image)).rejects.toThrow('HTTP 503');
  });
  it.each(['nvidia/nemotron-ocr-v1', 'nvidia/nemotron-ocr-v2'])('transcribes with selected %s, bounds and confidence', async model => {
    fetchMock.mockResolvedValue(json({ data: [{ index: 0, text_detections: [detection()] }] }));
    expect(await transcribeDocumentImage(image, model)).toMatchObject({ text: 'NEBULA-731', model, truncated: false, regions: [{ confidence: 0.9, bounds: detection().bounding_box.points }] });
    expect(fetchMock.mock.calls[0][0]).toContain(model);
  });
  it('represents an empty scan honestly', async () => {
    fetchMock.mockResolvedValue(json({ data: [{ index: 0, text_detections: [] }] }));
    expect(await transcribeDocumentImage(image)).toMatchObject({ text: '', regions: [], truncated: false });
  });
  it.each([
    {}, { data: [] }, { data: [{ index: 1, text_detections: [] }] },
    { data: [{ index: 0, text_detections: [{ ...detection(), text_prediction: { text: 'x', confidence: 2 } }] }] },
    { data: [{ index: 0, text_detections: [{ ...detection(), bounding_box: { points: [] } }] }] },
  ])('rejects malformed OCR response %#', async body => {
    fetchMock.mockResolvedValue(json(body)); await expect(transcribeDocumentImage(image)).rejects.toThrow('unreadable');
  });
  it.each([Array.from({ length: 151 }, () => detection()), [detection('x'.repeat(12001))]].map(detections => ({ detections })))('reports OCR truncation %# explicitly', async ({ detections }) => {
    fetchMock.mockResolvedValue(json({ data: [{ index: 0, text_detections: detections }] }));
    expect(await transcribeDocumentImage(image)).toMatchObject({ truncated: true });
  });
  it('rejects unsupported WebP OCR before sending', async () => {
    await expect(transcribeDocumentImage(image.replace('png', 'webp'))).rejects.toThrow('PNG or JPEG'); expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([transcribeDocumentImage, parseDocumentImage])('honors disabled and unsupported choices %#', async specialist => {
    await expect(specialist(image, 'off')).rejects.toThrow('disabled');
    await expect(specialist(image, 'invented')).rejects.toThrow('Unsupported');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('returns structure as inert untrusted text and uses its control prompt', async () => {
    fetchMock.mockResolvedValue(json({ choices: [{ message: { content: '<table>25</table>' }, finish_reason: 'stop' }] }));
    expect(await parseDocumentImage(image)).toMatchObject({ text: '<table>25</table>', evidence_type: 'model_extracted_page_structure' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0].content[1].text).toBe('</s><output_markdown>'); expect(body.max_tokens).toBe(2048);
  });
  it('rejects truncated structure rather than using partial tables', async () => {
    fetchMock.mockResolvedValue(json({ choices: [{ message: { content: '<table>' }, finish_reason: 'length' }] }));
    await expect(parseDocumentImage(image)).rejects.toThrow('incomplete');
  });
  it('reports pending inference as unavailable evidence', async () => {
    fetchMock.mockResolvedValue(json({ requestId: 'pending' }, 202));
    await expect(transcribeDocumentImage(image)).rejects.toThrow('pending');
  });
});
