// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CopilotSources, type ChatCitation } from '../../components/CopilotSources';

const source: ChatCitation = { entity_type: 'resource', entity_id: 'book', title: 'Introduction to Algebra', matched_via: ['text read'], source_url: 'https://drive.google.com/file/d/drive-id/view', page_start: 94, page_end: 94, excerpt: 'The exercises compare modular arithmetic and logical statements.', excerpt_kind: 'text', source_tool: 'read_document' };
describe('Copilot document cards', () => {
  it('shows a large document card, evidence and separate Drive/page links without expanding context', () => {
    render(<CopilotSources citations={[{ entity_type: 'task', entity_id: 't', title: 'Homework', matched_via: ['sql'] }, source]} />);
    const card = screen.getByRole('article', { name: 'Source: Introduction to Algebra' });
    expect(within(card).getByText(source.excerpt!)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Introduction to Algebra in Google Drive' })).toHaveAttribute('href', source.source_url);
    expect(screen.getByRole('link', { name: 'Open Introduction to Algebra, page 94' })).toHaveAttribute('href', '/api/resources/blob/book#page=94');
    expect(screen.getByText('Other context · 1 item')).toBeInTheDocument();
  });
  it('groups multiple passages by document, prioritizes actual reads and removes duplicate previews', () => {
    const preview = { ...source, page_start: 1, page_end: 1, excerpt: 'Cover page', source_tool: 'find_resources' };
    render(<CopilotSources citations={[preview, preview, source]} />);
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByText(source.excerpt!)).toBeVisible();
    expect(screen.getByText('1 more passage')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '1 more passage' }));
    expect(screen.getAllByText('Cover page')).toHaveLength(1);
  });
  it('expands the saved excerpt with an accessible control and preserves its literal source text', () => {
    const text = 'Evidence *not formatting* <script>not executable</script>. '.repeat(14) + 'Final fact.';
    const { container } = render(<CopilotSources citations={[{ ...source, excerpt: text }]} />);
    const more = screen.getByRole('button', { name: 'Read excerpt' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/Final fact/)).toBeNull();
    fireEvent.click(more);
    expect(screen.getByText(/Final fact/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('script')).toBeNull();
  });
  it('does not fabricate excerpts for saved replies from before excerpt capture', () => {
    render(<CopilotSources citations={[{ ...source, excerpt: undefined }]} />);
    expect(screen.getByText(/No excerpt was saved/)).toBeVisible();
    expect(screen.getByRole('link', { name: /in Google Drive/ })).toBeInTheDocument();
  });
  it('opens a named source dialog with an internal page preview and a reachable close control', () => {
    render(<CopilotSources citations={[source]} />);
    fireEvent.click(screen.getByRole('button',{name:'Preview page and excerpt'}));
    const dialog=screen.getByRole('dialog',{name:source.title});
    expect(within(dialog).getByTitle('Introduction to Algebra, Page 94')).toHaveAttribute('src','/api/resources/blob/book#page=94');
    expect(within(dialog).getByText(source.excerpt!)).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button',{name:'Close source preview'}));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('labels visual interpretations and OCR fallback instead of presenting them as quotations', () => {
    render(<CopilotSources citations={[{ ...source, excerpt_kind: 'visual' }, { ...source, entity_id: 'scan', title: 'Scan', matched_via: ['OCR fallback'], excerpt_kind: 'ocr' }]} />);
    expect(screen.getByText('Visual interpretation')).toBeVisible();
    expect(screen.getByText(/Model interpretation/)).toBeVisible();
    expect(screen.getByText(/Only text was read/)).toBeVisible();
  });
  it.each(['javascript:alert(1)', '//evil.test', 'https://drive.google.com.evil.test/file/d/id/view', '/api/resources/blob/../auth'])('does not make unsafe source %s clickable', source_url => {
    render(<CopilotSources citations={[{ ...source, source_url }]} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
  });
  it('keeps unknown pages honest and allows multiple documents without overwhelming the initial answer', () => {
    render(<CopilotSources citations={[source, { ...source, entity_id: 'other', title: 'Second', page_start: null, page_end: null }, { ...source, entity_id: 'third', title: 'Third' }]} />);
    expect(screen.getByText('Sources consulted · 3 documents')).toBeInTheDocument();
    expect(screen.getByText('1 more document')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Source: Second' })).getByText('Source excerpt')).toBeVisible();
    expect(screen.queryByRole('link', { name: /Open Second, page/ })).toBeNull();
  });
});
