import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Layers, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { apiFetch, apiPost } from '../../utils/apiFetch';
import { isProcessing, processingLabel, type ResourceProcessing } from '../../utils/resourceFiles';

interface ChunkRow {
  id: string;
  chunk_index: number;
  page_start: number | null;
  page_end: number | null;
  content_chars: number;
  content_preview: string;
  has_embedding: boolean;
  embedding_stale: boolean;
}

/**
 * The RAG surface for one document: is it chunked, is every chunk embedded,
 * which pages does each chunk cover, and can it be re-indexed. This is what
 * makes "search finds page 3 of my PDF" and chat's chunk citations legible.
 */
export function SemanticIndexPanel({ resourceId, hasFile }: { resourceId: string; hasFile: boolean }) {
  const qc = useQueryClient();
  const { triggerToast } = useAppStore();
  const [expanded, setExpanded] = useState<string | null>(null);
  const processing = useQuery<ResourceProcessing>({
    queryKey: ['resource-processing', resourceId], enabled: hasFile,
    queryFn: () => apiFetch(`/api/resources/${resourceId}/processing`),
    refetchInterval: q => isProcessing(q.state.data?.status) ? 3000 : false,
  });
  const active = isProcessing(processing.data?.status);
  useEffect(() => {
    if (processing.data) {
      void qc.invalidateQueries({ queryKey: ['resource-chunks', resourceId] });
      void qc.invalidateQueries({ queryKey: ['resources'] });
      void qc.invalidateQueries({ queryKey: ['resource', resourceId] });
    }
  }, [processing.data?.status, resourceId, qc]);

  const { data: chunks = [], refetch, isLoading } = useQuery<ChunkRow[]>({
    queryKey: ['resource-chunks', resourceId],
    queryFn: () => apiFetch<ChunkRow[]>(`/api/resources/${resourceId}/chunks`),
    refetchInterval: active ? 5000 : false,
  });

  const rechunk = useMutation({
    mutationFn: () => apiPost<{ status: string }>(`/api/resources/${resourceId}/rechunk`, {}),
    onSuccess: () => {
      refetch();
      qc.invalidateQueries({ queryKey: ['resource-processing', resourceId] });
      qc.invalidateQueries({ queryKey: ['resource-chunks', resourceId] });
      triggerToast('Processing queued. Your original file is preserved.', 'success');
    },
    onError: (e: Error) => triggerToast(e.message, 'error'),
  });

  const embedded = chunks.filter(c => c.has_embedding && !c.embedding_stale).length;
  const allGood = chunks.length > 0 && embedded === chunks.length;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-gray-400 flex items-center gap-1.5">
          <Layers size={11} className="text-[#4648d4]" /> Semantic Index
        </p>
        {hasFile && (
          <button
            onClick={() => rechunk.mutate()}
            disabled={rechunk.isPending || active}
            aria-label={processing.data?.status === 'failed' ? 'Retry file processing' : 'Re-index file'}
            className="min-h-11 min-w-11 rounded-md text-[9px] font-mono uppercase text-[#4648d4] hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-[#4648d4]/40 disabled:opacity-40 flex items-center justify-center gap-1"
            title="Re-index text, page structure and visual evidence for this file"
          >
            <RefreshCw size={12} className={rechunk.isPending || active ? 'animate-spin' : ''} /><span className="hidden sm:inline">{processing.data?.status === 'failed' ? 'Retry' : 'Re-index'}</span>
          </button>
        )}
      </div>

      {hasFile && processing.data && <p role="status" className={`mb-2 text-xs leading-relaxed ${processing.data.status === 'failed' ? 'text-red-600' : 'text-gray-500'}`}>{processingLabel(processing.data)}</p>}
      {hasFile && processing.data?.status === 'ready' && processing.data.mime_type === 'application/pdf' && !processing.data.total_pages && <p className="mb-2 text-xs leading-relaxed text-gray-500">Text index only. Re-index this document to make page images and diagrams searchable.</p>}
      {processing.isError && <p role="alert" className="mb-2 text-xs text-red-600">Could not load processing status. <button className="min-h-11 underline" onClick={() => processing.refetch()}>Retry</button></p>}

      {isLoading && <p className="text-[11px] text-gray-400 font-mono">Loading…</p>}

      {!isLoading && chunks.length === 0 && (!hasFile || processing.data?.status === 'not_started') && (
        <p className="text-[11px] text-gray-400 leading-relaxed">
          {hasFile
            ? 'Not indexed yet — hit Re-index to chunk and embed this document so search and chat can cite its pages.'
            : 'No indexable file. Links and people aren’t chunked; upload a PDF/text file to make its content searchable.'}
        </p>
      )}

      {chunks.length > 0 && (
        <>
          <p className="text-[11px] text-gray-600 mb-2">
            <b>{chunks.length}</b> chunk{chunks.length !== 1 ? 's' : ''} ·{' '}
            <span className={allGood ? 'text-emerald-600' : 'text-amber-600'}>
              {embedded}/{chunks.length} embedded{allGood ? ' — indexed passages searchable' : active ? ' (indexing…)': ''}
            </span>
          </p>
          <div className="space-y-1 max-h-56 overflow-y-auto">
            {chunks.map(c => (
              <div key={c.id} className="border border-gray-100 rounded-lg">
                <button
                  onClick={() => setExpanded(e => e === c.id ? null : c.id)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-gray-50"
                >
                  {expanded === c.id ? <ChevronDown size={10} className="text-gray-400 shrink-0" /> : <ChevronRight size={10} className="text-gray-400 shrink-0" />}
                  <span className="text-[10px] font-mono text-gray-500 shrink-0">#{c.chunk_index}</span>
                  {c.page_start != null && (
                    <span className="text-[10px] font-mono text-[#4648d4] shrink-0">
                      p. {c.page_start}{c.page_end && c.page_end !== c.page_start ? `–${c.page_end}` : ''}
                    </span>
                  )}
                  <span className="text-[10px] text-gray-400 truncate flex-1">{c.content_preview.slice(0, 60)}</span>
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.has_embedding && !c.embedding_stale ? 'bg-emerald-500' : 'bg-amber-400 animate-pulse'}`}
                    title={c.has_embedding ? (c.embedding_stale ? 'Embedding stale — re-embedding queued' : 'Embedded') : 'Embedding pending'} />
                </button>
                {expanded === c.id && (
                  <p className="px-3 pb-2 text-[10px] text-gray-500 leading-relaxed whitespace-pre-wrap">
                    {c.content_preview}{c.content_chars > c.content_preview.length ? `… (${c.content_chars} chars total)` : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
