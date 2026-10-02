import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ ocr:vi.fn(), visual:vi.fn(), structure:vi.fn() }));
vi.mock('../../../server/services/nvidiaEvidence.js', () => ({ transcribeDocumentImage:mocks.ocr, analyzeDocumentImage:mocks.visual, parseDocumentImage:mocks.structure }));
import { extractPageEvidence, pageElements } from '../../../server/services/structuredIngestion';
beforeEach(() => { vi.resetAllMocks(); mocks.ocr.mockResolvedValue({text:'scan',model:'ocr'}); mocks.structure.mockResolvedValue({text:'# Table\n| A | B |',model:'layout'}); mocks.visual.mockResolvedValue({analysis:'Chart with axes.',model:'vision'}); });
describe('automatic visual ingestion evidence', () => {
  it('adds OCR for scanned pages, and structure plus visual interpretation for every page', async () => {
    const evidence = await extractPageEvidence('synthetic-image','');
    expect(mocks.ocr).toHaveBeenCalledOnce();
    expect(pageElements({page_number:4,native_text:'',evidence,status:'ready',attempts:1}).map(e=>e.kind)).toEqual(['ocr','structure','visual']);
    expect(evidence.unavailable).toEqual([]);
  });
  it('preserves native text as distinct evidence and avoids redundant OCR', async () => {
    const native = 'Native source paragraph. '.repeat(10);
    const evidence = await extractPageEvidence('synthetic-image',native);
    expect(mocks.ocr).not.toHaveBeenCalled();
    const elements = pageElements({page_number:8,native_text:native,evidence,status:'ready',attempts:1});
    expect(elements[0]).toEqual({page:8,kind:'text',content:native});
    expect(elements[2]).toMatchObject({page:8,kind:'visual',model:'vision'});
  });
  it('records partial failure and retries only missing roles', async () => {
    mocks.visual.mockRejectedValueOnce(new Error('Unavailable'));
    const first = await extractPageEvidence('synthetic-image','');
    expect(first.unavailable).toEqual(['visual']);
    const second = await extractPageEvidence('synthetic-image','',first);
    expect(second.unavailable).toEqual([]);
    expect(mocks.ocr).toHaveBeenCalledOnce(); expect(mocks.structure).toHaveBeenCalledOnce(); expect(mocks.visual).toHaveBeenCalledTimes(2);
  });
});
