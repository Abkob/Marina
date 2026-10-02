import { useId, useState } from 'react';
import { BookOpen, ExternalLink } from 'lucide-react';

export interface ChatCitation {
  entity_type: string;
  entity_id: string;
  title: string;
  matched_via: string[];
  similarity?: number;
  topics?: string[];
  source_url?: string;
  page_start?: number | null;
  page_end?: number | null;
  excerpt?: string;
  excerpt_kind?: 'text' | 'ocr' | 'visual' | 'structure';
  excerpt_truncated?: boolean;
  source_tool?: string;
  chunk_id?: string;
}

function sourceHref(source: ChatCitation) {
  const url = source.source_url ?? '';
  return /^https:\/\/drive\.google\.com\/file\/d\/[\w-]+\/view$/.test(url) || /^\/api\/resources\/blob\/[\w-]+$/.test(url) ? url : undefined;
}

function pageLabel(source: ChatCitation) {
  const start = source.page_start, end = source.page_end;
  if (!Number.isInteger(start) || start! < 1) return 'Source excerpt';
  return Number.isInteger(end) && end! > start! ? `Pages ${start}–${end}` : `Page ${start}`;
}

const excerptLabels = { text: 'Document excerpt', ocr: 'Text read from image', visual: 'Visual interpretation', structure: 'Extracted page structure' };

function Passage({ source }: { source: ChatCitation }) {
  const [expanded, setExpanded] = useState(false);
  const excerptId = useId();
  const text = source.excerpt?.trim();
  const pageHref = source.page_start && Number.isInteger(source.page_start) && source.page_start > 0 && /^[\w-]+$/.test(source.entity_id)
    ? `/api/resources/blob/${source.entity_id}#page=${source.page_start}` : undefined;
  return <div className="copilot-source-passage">
    <div className="copilot-source-passage-label">
      {pageHref ? <a href={pageHref} target="_blank" rel="noopener noreferrer" aria-label={`Open ${source.title}, ${pageLabel(source).toLowerCase()}`}>{pageLabel(source)}<ExternalLink size={12} aria-hidden="true" /></a> : <span>{pageLabel(source)}</span>}
      {text && <span>{excerptLabels[source.excerpt_kind ?? 'text'] ?? excerptLabels.text}</span>}
    </div>
    {text ? <>
      <p id={excerptId} className="copilot-source-excerpt">{expanded ? text : text.slice(0, 360)}{(!expanded && text.length > 360) || source.excerpt_truncated ? '…' : ''}</p>
      {text.length > 360 && <button className="copilot-source-more" aria-expanded={expanded} aria-controls={excerptId} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Read excerpt'}</button>}
      {source.excerpt_kind === 'visual' && <p className="copilot-source-note">Model interpretation; verify details against the original.</p>}
      {source.matched_via?.includes('OCR fallback') && <p className="copilot-source-note">Only text was read; visual details were unavailable.</p>}
    </> : <p className="copilot-source-note">No excerpt was saved with this reply. Open the source to read it.</p>}
  </div>;
}

function ResourceCard({ sources }: { sources: ChatCitation[] }) {
  // A deliberate page read comes before cover/contents previews from discovery.
  const ordered = [...sources].sort((a, b) => Number(['read_document', 'inspect_document_page'].includes(b.source_tool ?? '')) - Number(['read_document', 'inspect_document_page'].includes(a.source_tool ?? '')));
  const source = ordered[0];
  const seen = new Set<string>();
  const passages = ordered.filter(row => {
    const key = JSON.stringify([row.page_start, row.page_end, row.excerpt]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const drive = source.source_url!.startsWith('https://drive.google.com/');
  return <article className="copilot-source-card" aria-label={`Source: ${source.title}`}>
    <div className="copilot-source-header">
      <BookOpen size={20} aria-hidden="true" />
      <div><p className="copilot-source-location">{drive ? 'Google Drive' : 'Resource Library'}</p><h3>{source.title}</h3></div>
      <a className="copilot-source-open" href={sourceHref(source)} target="_blank" rel="noopener noreferrer" aria-label={`Open ${source.title}${drive ? ' in Google Drive' : ''}`} title={drive ? 'Open in Google Drive' : 'Open original'}><ExternalLink size={17} aria-hidden="true" /></a>
    </div>
    <Passage source={passages[0]} />
    {passages.length > 1 && <details className="copilot-source-details"><summary>{passages.length - 1} more passage{passages.length > 2 ? 's' : ''}</summary>
      {passages.slice(1).map((row, i) => <Passage key={i} source={row} />)}
    </details>}
  </article>;
}

/** Document evidence is visible; background task/goal context stays secondary. */
export function CopilotSources({ citations }: { citations: ChatCitation[] }) {
  const documents = new Map<string, ChatCitation[]>();
  const context: ChatCitation[] = [];
  for (const citation of citations) {
    if (citation.entity_type === 'resource' && sourceHref(citation)) {
      const key = `${citation.entity_id}:${citation.source_url}`;
      const group = documents.get(key) ?? [];
      group.push(citation); documents.set(key, group);
    } else context.push(citation);
  }
  const groups = [...documents.entries()];
  if (!citations.length) return null;
  return <div className="copilot-sources">
    {groups.length > 0 && <section aria-label="Document sources consulted">
      <p className="copilot-sources-label">Sources consulted · {groups.length} document{groups.length === 1 ? '' : 's'}</p>
      <div className="copilot-source-cards">{groups.slice(0, 2).map(([key, sources]) => <ResourceCard key={key} sources={sources} />)}</div>
      {groups.length > 2 && <details className="copilot-source-details"><summary>{groups.length - 2} more document{groups.length > 3 ? 's' : ''}</summary><div className="copilot-source-cards">{groups.slice(2).map(([key, sources]) => <ResourceCard key={key} sources={sources} />)}</div></details>}
    </section>}
    {context.length > 0 && <details className="copilot-context-details"><summary>{groups.length ? 'Other context' : 'Context consulted'} · {context.length} item{context.length === 1 ? '' : 's'}</summary>
      <ul>{context.map((source, i) => <li key={i}><span>{source.title}</span><small>{source.entity_type.replaceAll('_', ' ')}</small></li>)}</ul>
    </details>}
  </div>;
}
