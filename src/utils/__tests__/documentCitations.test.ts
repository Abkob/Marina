// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { documentCitations, documentEvidenceWarning } from '../../../server/services/documentCitations.js';
const row = { resource_id: 'r', title: 'Scan', source_url: 'https://drive.google.com/file/d/file-id/view', page_start: 3, page_end: 3 };
describe('document citation provenance', () => {
  it('provides a deterministic visible warning for fallback, independent of model compliance', () => {
    const data = { ...row, text: 'OCR', vision_unavailable: true };
    expect(documentEvidenceWarning('inspect_document_page', data)).toContain('Only OCR text was read');
    expect(documentCitations('inspect_document_page', data)[0].matched_via).toEqual(['OCR fallback']);
    expect(documentEvidenceWarning('find_resources', data)).toBeNull();
    expect(documentEvidenceWarning('inspect_document_page', { ...row, analysis: 'image' })).toBeNull();
  });
  it('retains links and physical pages from visual, OCR and structure evidence', () => {
    for (const evidence of [{ analysis: 'chart' }, { text: 'OCR' }, { text: '<table>25</table>' }]) {
      expect(documentCitations('inspect_document_page', { ...row, ...evidence })).toEqual([{ entity_type: 'resource', entity_id: 'r', title: 'Scan', source_url: row.source_url, page_start: 3, page_end: 3, matched_via: ['page inspected'] }]);
    }
  });
  it('joins text passage pages with the original source identity', () => {
    expect(documentCitations('read_document', { ...row, passages: [{ page_start: 4, page_end: 5 }] })[0]).toMatchObject({ entity_id: 'r', page_start: 4, page_end: 5 });
    expect(documentCitations('search_documents', { evidence: [row] })).toHaveLength(1);
    expect(documentCitations('find_resources', { resources: [{ ...row, resource_id: 'unread' }], evidence: [row] })).toEqual(documentCitations('search_documents', { evidence: [row] }));
  });
  it.each(['javascript:alert(1)', 'https://evil.test/file', 'https://drive.google.com.evil.test/file/d/id/view', '//evil.test', '/api/resources/blob/../auth'])('rejects unsafe source URL %s', source_url => {
    expect(documentCitations('inspect_document_page', { ...row, source_url, text: 'source' })).toEqual([]);
  });
  it('does not attach empty, failed or merely discovered sources as inspected evidence', () => {
    expect(documentCitations('inspect_document_page', row)).toEqual([]);
    expect(documentCitations('inspect_document_page', { ...row, text: '' })).toEqual([]);
    expect(documentCitations('find_resources', { resources: [row] })).toEqual([]);
    expect(documentCitations('read_document', { ...row, passages: [] })).toEqual([]);
  });
  it('includes only actual opening-preview passages and keeps their physical pages', () => {
    const result = documentCitations('find_resources', { resources: [{ ...row, resource_id: 'metadata-only' }], evidence: [], previews: [
      { ...row, passages: [{ page_start: 1, page_end: 1 }, { page_start: 4, page_end: 4 }] }, { resource_id: 'unavailable', unavailable: true },
    ] });
    expect(result.map(citation => [citation.entity_id, citation.page_start])).toEqual([['r', 1], ['r', 4]]);
  });
});
