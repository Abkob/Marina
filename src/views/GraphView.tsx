import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HelpCircle, X, Link2, Search, Crosshair, LayoutGrid, Share2 } from 'lucide-react';
import { apiFetch } from '../utils/apiFetch';
import { TYPE_META, REL_EXPLAIN, type GraphData } from './graph/types';
import { ForceWeb } from './graph/ForceWeb';
import { useMediaQuery, MOBILE_LAYOUT_QUERY } from '../hooks/useMediaQuery';
import { GraphBoard } from './graph/GraphBoard';

/**
 * Connections explorer — the graph as a search engine. The pipeline narrows
 * the graph live: relationship-type chips → topic membership → text query /
 * focused node expanded N hops → entity-type chips. Two renderers: the
 * Obsidian-style force web and the readable board.
 */

interface TopicRow { id: string; name: string }
interface MembershipRow { entity_type: string; entity_id: string }

// topic memberships use entity_type 'journal_entry'; graph nodes use 'journal'
const memberKey = (m: MembershipRow) =>
  `${m.entity_type === 'journal_entry' ? 'journal' : m.entity_type}:${m.entity_id}`;

export function GraphView() {
  const isMobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const [mode, setMode] = useState<'web' | 'board'>(() => window.matchMedia(MOBILE_LAYOUT_QUERY).matches ? 'board' : 'web');
  const [visibleTypes, setVisibleTypes] = useState<Set<string>>(new Set(Object.keys(TYPE_META)));
  const [relFilter, setRelFilter] = useState<Set<string>>(new Set()); // empty = all relationships
  const [topicId, setTopicId] = useState('');
  const [query, setQuery] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [depth, setDepth] = useState<1 | 2>(1);
  const [showHelp, setShowHelp] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const { data, isLoading, error: queryError, refetch } = useQuery<GraphData>({
    queryKey: ['graph'],
    queryFn: () => apiFetch<GraphData>('/api/graph'),
    staleTime: 60_000,
    retry: false,
  });
  const error = queryError instanceof Error ? queryError.message : queryError ? 'Unknown error' : null;

  const { data: topics = [] } = useQuery<TopicRow[]>({
    queryKey: ['topics'],
    queryFn: () => apiFetch<TopicRow[]>('/api/topics'),
    staleTime: 60_000,
  });
  const { data: topicMembers = [] } = useQuery<MembershipRow[]>({
    queryKey: ['graph-topic-members', topicId],
    queryFn: () => apiFetch<MembershipRow[]>(`/api/topics/${topicId}/members`),
    enabled: Boolean(topicId),
  });

  const relTypes = useMemo(
    () => [...new Set((data?.edges ?? []).map(e => e.relationship))].sort(),
    [data],
  );

  // ── The filter pipeline ─────────────────────────────────────────────────────
  const filtered: GraphData | null = useMemo(() => {
    if (!data) return null;

    // 1. Relationship kinds (empty selection = all)
    let edges = relFilter.size ? data.edges.filter(e => relFilter.has(e.relationship)) : data.edges;
    let nodes = data.nodes;

    // 2. Topic membership: only members of the chosen cluster (+ edges among them)
    if (topicId && topicMembers.length) {
      const allowed = new Set(topicMembers.map(memberKey));
      nodes = nodes.filter(n => allowed.has(n.id));
      const ids = new Set(nodes.map(n => n.id));
      edges = edges.filter(e => ids.has(e.source) && ids.has(e.target));
    } else if (topicId) {
      nodes = []; edges = [];
    }

    // 3. Query / focus → seed set expanded N hops over the surviving edges
    const q = query.trim().toLowerCase();
    const seeds = new Set<string>();
    if (focusId && nodes.some(n => n.id === focusId)) seeds.add(focusId);
    else if (q) for (const n of nodes) if (n.label.toLowerCase().includes(q)) seeds.add(n.id);

    if (seeds.size || (q && !focusId) || (focusId && !seeds.size)) {
      if (!seeds.size) { nodes = []; edges = []; }
      else {
        const adj = new Map<string, string[]>();
        for (const e of edges) {
          (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
          (adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push(e.source);
        }
        const keep = new Set(seeds);
        let frontier = [...seeds];
        for (let hop = 0; hop < depth; hop++) {
          const next: string[] = [];
          for (const id of frontier) {
            for (const nb of adj.get(id) ?? []) {
              if (!keep.has(nb)) { keep.add(nb); next.push(nb); }
            }
          }
          frontier = next;
        }
        nodes = nodes.filter(n => keep.has(n.id));
        const ids = new Set(nodes.map(n => n.id));
        edges = edges.filter(e => ids.has(e.source) && ids.has(e.target));
      }
    }

    // 4. Entity types last (board/web also respect visibleTypes for sections)
    nodes = nodes.filter(n => visibleTypes.has(n.type));
    const ids = new Set(nodes.map(n => n.id));
    edges = edges.filter(e => ids.has(e.source) && ids.has(e.target));

    return { ...data, nodes, edges };
  }, [data, relFilter, topicId, topicMembers, query, focusId, depth, visibleTypes]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of filtered?.nodes ?? []) c[n.type] = (c[n.type] ?? 0) + 1;
    return c;
  }, [filtered]);

  const focusNode = focusId ? data?.nodes.find(n => n.id === focusId) : null;
  const isNarrowed = Boolean(query.trim() || focusId || topicId || relFilter.size);

  const toggleType = (t: string) =>
    setVisibleTypes(s => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  const toggleRel = (r: string) =>
    setRelFilter(s => { const n = new Set(s); if (n.has(r)) n.delete(r); else n.add(r); return n; });
  const clearAll = () => { setQuery(''); setFocusId(null); setTopicId(''); setRelFilter(new Set()); setVisibleTypes(new Set(Object.keys(TYPE_META))); };

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-950">
        <p className="text-sm text-gray-500 font-mono animate-pulse">Loading connections…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 bg-gray-950">
        <p className="text-sm text-red-400 font-mono">Failed to load: {error}</p>
        <button onClick={() => refetch()} className="px-4 py-2 text-xs font-mono bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg" aria-label="Retry loading connections graph">Retry</button>
      </div>
    );
  }

  return (
    <div className="h-full bg-gray-950 flex flex-col">
      {/* Row 1: title, search-as-filter, mode switch */}
      <div className="mobile-graph-toolbar shrink-0 px-6 pt-4 pb-2 flex items-center gap-3 flex-wrap">
        <h2 className="font-headline text-lg font-bold text-white flex items-center gap-2 shrink-0">
          <Link2 size={16} className="text-indigo-400" /> Connections
        </h2>

        <div className="graph-search relative flex-1 min-w-[220px] max-w-md">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-600" />
          <input
            aria-label="Filter connections"
            value={query}
            onChange={e => { setQuery(e.target.value); setFocusId(null); }}
            placeholder="Filter the web — type a task, resource, milestone…"
            className="w-full bg-gray-900 border border-gray-800 rounded-lg pl-7 pr-7 py-1.5 text-[11px] text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-indigo-500"
          />
          {query && (
            <button onClick={() => setQuery('')} className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-gray-600 hover:bg-gray-800 hover:text-gray-300" aria-label="Clear graph search"><X size={11} /></button>
          )}
        </div>

        {(query.trim() || focusId) && (
          <select
            aria-label="Connection expansion depth"
            value={depth}
            onChange={e => setDepth(Number(e.target.value) as 1 | 2)}
            className="bg-gray-900 border border-gray-800 text-[10px] font-mono text-gray-300 rounded-lg px-2 py-1.5 focus:outline-none"
            title="How far to expand around the matches"
          >
            <option value={1}>+ direct links</option>
            <option value={2}>+ 2 hops</option>
          </select>
        )}

        <select
          aria-label="Filter graph by topic"
          value={topicId}
          onChange={e => setTopicId(e.target.value)}
          className="bg-gray-900 border border-gray-800 text-[10px] font-mono text-gray-300 rounded-lg px-2 py-1.5 focus:outline-none"
          title="Filter to one of your Topics — the cross-goal clusters you manage on the Topics tab"
        >
          <option value="">Topic filter: off</option>
          {topics.map(t => <option key={t.id} value={t.id}>Topic: {t.name}</option>)}
        </select>

        <div className="flex rounded-lg border border-gray-800 bg-gray-900 p-0.5 shrink-0">
          <button
            onClick={() => setMode('web')}
            aria-pressed={mode === 'web'}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-mono uppercase ${mode === 'web' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:text-gray-300'}`}
            title="Force-directed web (Obsidian-style)"
          >
            <Share2 size={11} /> Web
          </button>
          <button
            onClick={() => setMode('board')}
            aria-pressed={mode === 'board'}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-mono uppercase ${mode === 'board' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:text-gray-300'}`}
            title="Grouped board — everything by name"
          >
            <LayoutGrid size={11} /> Board
          </button>
        </div>

        <button onClick={() => setShowHelp(h => !h)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-900 hover:text-gray-300" title="How to read this" aria-label="Toggle graph help" aria-expanded={showHelp}>
          <HelpCircle size={14} />
        </button>
        {isMobile && <button onClick={() => setFiltersOpen(open => !open)} aria-expanded={filtersOpen} aria-controls="connection-filters" className="rounded-xl border border-gray-700 px-3 text-xs font-semibold text-gray-300">Filters{isNarrowed ? ' · active' : ''}</button>}
      </div>

      {/* Row 2: entity-type chips + relationship chips + active-filter status */}
      <div id="connection-filters" hidden={isMobile && !filtersOpen} className={`mobile-graph-filters shrink-0 px-6 pb-2.5 flex items-center gap-2 flex-wrap border-b border-white/5 ${isMobile && !filtersOpen ? 'mobile-filters-closed' : ''}`}>
        {Object.entries(TYPE_META).map(([t, m]) => (
          <button
            key={t}
            onClick={() => toggleType(t)}
            aria-pressed={visibleTypes.has(t)}
            className={`px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider rounded-full border transition-colors ${
              visibleTypes.has(t) ? 'text-gray-950 font-bold border-transparent' : 'text-gray-600 border-gray-800'
            }`}
            style={visibleTypes.has(t) ? { background: m.color } : {}}
          >
            {m.label} {counts[t] ?? 0}
          </button>
        ))}
        <span className="w-px h-4 bg-gray-800 mx-1" />
        {relTypes.map(r => (
          <button
            key={r}
            onClick={() => toggleRel(r)}
            aria-pressed={relFilter.has(r)}
            title={relFilter.size === 0 ? 'Click to show ONLY this kind of link' : relFilter.has(r) ? 'Remove from selection' : 'Add to selection'}
            className={`px-2 py-0.5 text-[9px] font-mono rounded-full border transition-colors ${
              relFilter.has(r)
                ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300 font-bold'
                : relFilter.size
                  ? 'text-gray-700 border-gray-800'
                  : 'text-gray-500 border-gray-800 hover:text-gray-300'
            }`}
          >
            {REL_EXPLAIN[r] ?? r}
          </button>
        ))}
        {isNarrowed && (
          <button onClick={clearAll} className="ml-auto flex items-center gap-1 text-[10px] font-mono text-amber-400 hover:text-amber-300" aria-label="Clear all graph filters">
            <X size={10} /> clear filters ({filtered?.nodes.length ?? 0}/{data?.nodes.length ?? 0} shown)
          </button>
        )}
      </div>

      {focusNode && (
        <div className="shrink-0 mx-6 mt-2 px-3 py-1.5 bg-indigo-500/10 border border-indigo-500/30 rounded-lg flex items-center gap-2">
          <Crosshair size={12} className="text-indigo-400" />
          <span className="text-[11px] text-indigo-200">
            Focused on <b>{focusNode.label}</b> — showing its {depth === 1 ? 'direct connections' : '2-hop neighborhood'}
          </span>
          <button onClick={() => setFocusId(null)} className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-900 hover:text-gray-300" aria-label="Clear focused graph node"><X size={11} /></button>
        </div>
      )}

      {showHelp && (
        <div className="shrink-0 mx-6 mt-2 px-4 py-2.5 bg-indigo-500/5 border border-indigo-500/20 rounded-xl flex items-start gap-2">
          <HelpCircle size={13} className="text-indigo-400 shrink-0 mt-0.5" />
          <p className="text-[11px] text-gray-400 leading-relaxed">
            {isMobile && <span className="block mb-2 text-indigo-200">Use Board to tap a record, or the target icon to explore its connections. Scroll the filters sideways to see more.</span>}This is a search engine over your connections. <b className="text-gray-300">Type</b> to keep only matching records
            plus whatever they link to (choose 1 or 2 hops). <b className="text-gray-300">Right-click</b> any node to focus its
            neighborhood. Pick a <b className="text-gray-300">#topic</b> to see just that cluster. Click a
            <b className="text-indigo-300"> link-kind chip</b> (e.g. “attached to”, “used together with”) to see only that kind of
            relationship — e.g. select “mentions” to see what your journals touch. <b className="text-gray-300">Hover</b> lights
            neighbors; <b className="text-gray-300">click</b> opens; node size = how connected it is.
          </p>
          <button onClick={() => setShowHelp(false)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-600 hover:bg-gray-900 hover:text-gray-300" aria-label="Close graph help"><X size={12} /></button>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {filtered && filtered.nodes.length > 0 ? (
          mode === 'web'
            ? <ForceWeb data={filtered} visibleTypes={visibleTypes} onFocus={id => { setFocusId(id); setQuery(''); }} />
            : <GraphBoard data={filtered} visibleTypes={visibleTypes} onFocus={id => { setFocusId(id); setQuery(''); }} />
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-2">
            <p className="text-sm text-gray-500 font-mono">No matches.</p>
            <p className="text-xs text-gray-600">Loosen the filters — or <button onClick={clearAll} className="text-indigo-400 hover:underline">clear everything</button>.</p>
          </div>
        )}
      </div>
    </div>
  );
}
