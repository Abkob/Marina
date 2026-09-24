import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Crosshair } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { TYPE_META, REL_EXPLAIN, type GraphData, type GraphNode, type GraphEdge } from './types';

/**
 * Board mode: each goal is a card listing its connected work by name
 * (containment as grouping); curves show only cross-goal relationships.
 * The readable complement to the force web.
 */

const SECTION_ORDER = ['milestone', 'task', 'resource', 'meeting', 'journal'];

interface Cluster { goal: GraphNode; members: GraphNode[] }

function buildClusters(data: GraphData): { clusters: Cluster[]; unlinked: GraphNode[]; crossEdges: GraphEdge[] } {
  const nodeById = new Map(data.nodes.map(n => [n.id, n]));
  const goals = data.nodes.filter(n => n.type === 'goal');

  const adj = new Map<string, string[]>();
  for (const e of data.edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source)!.push(e.target);
    adj.get(e.target)!.push(e.source);
  }

  const clusterOf = new Map<string, string>();
  for (const g of goals) clusterOf.set(g.id, g.id);
  for (const g of goals) {
    const queue = [g.id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nb of adj.get(cur) ?? []) {
        if (nodeById.get(nb)?.type === 'goal') continue;
        if (!clusterOf.has(nb)) { clusterOf.set(nb, g.id); queue.push(nb); }
      }
    }
  }

  const clusters: Cluster[] = goals.map(g => ({
    goal: g,
    members: data.nodes
      .filter(n => n.type !== 'goal' && clusterOf.get(n.id) === g.id)
      .sort((a, b) => SECTION_ORDER.indexOf(a.type) - SECTION_ORDER.indexOf(b.type) || a.label.localeCompare(b.label)),
  }));
  const unlinked = data.nodes.filter(n => n.type !== 'goal' && !clusterOf.has(n.id));

  const crossEdges = data.edges.filter(e => {
    if (!nodeById.has(e.source) || !nodeById.has(e.target)) return false;
    const sameCluster = clusterOf.get(e.source) !== undefined && clusterOf.get(e.source) === clusterOf.get(e.target);
    if (e.relationship === 'contains' && sameCluster) return false;
    if (sameCluster && (e.source.startsWith('goal:') || e.target.startsWith('goal:'))) return false;
    return true;
  });

  return { clusters, unlinked, crossEdges };
}

function Chip({ node, dimmed, related, hovered, onHover, onClick, onFocus, registerRef }: {
  node: GraphNode;
  dimmed: boolean;
  related: boolean;
  hovered: boolean;
  onHover: (id: string | null) => void;
  onClick: (n: GraphNode) => void;
  onFocus?: (id: string) => void;
  registerRef: (id: string, el: HTMLElement | null) => void;
}) {
  const meta = TYPE_META[node.type] ?? TYPE_META.task;
  const Icon = meta.Icon;
  const done = node.metadata.completed === true || node.metadata.status === 'done';
  return (
    <div className="flex min-w-0 items-center gap-1">
    <button
      ref={el => registerRef(node.id, el)}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onClick(node)}
      onContextMenu={e => { if (onFocus) { e.preventDefault(); onFocus(node.id); } }}
      title={`${meta.label}: ${node.label} — click to open · right-click to focus its connections`}
      className={`flex min-w-0 flex-1 items-center gap-1.5 text-left px-2 py-1 rounded-lg border text-[11px] leading-snug transition-all ${meta.chip}
        ${hovered ? 'ring-2 ring-indigo-400 bg-indigo-500/20' : ''}
        ${related && !hovered ? 'ring-1 ring-indigo-400/70' : ''}
        ${dimmed ? 'opacity-25' : 'hover:brightness-125'}`}
    >
      <Icon size={11} className="shrink-0 opacity-70" />
      <span className={`truncate ${done ? 'line-through opacity-60' : ''}`}>{node.label}</span>
    </button>
    {onFocus && <button onClick={() => onFocus(node.id)} aria-label={`Explore connections for ${node.label}`} className="flex shrink-0 items-center justify-center rounded-lg bg-slate-800 text-indigo-300 md:hidden"><Crosshair size={17} /></button>}
    </div>
  );
}

export function GraphBoard({ data, visibleTypes, onFocus }: { data: GraphData; visibleTypes: Set<string>; onFocus?: (id: string) => void }) {
  const { navigateToGoal, navigateToResource, setFocusedTaskId, setCurrentTab, setSelectedGoalId } = useAppStore();
  const [hovered, setHovered] = useState<string | null>(null);

  const { clusters, unlinked, crossEdges } = useMemo(() => buildClusters(data), [data]);

  const relatedIds = useMemo(() => {
    if (!hovered) return new Set<string>();
    const s = new Set<string>();
    for (const e of crossEdges) {
      if (e.source === hovered) s.add(e.target);
      if (e.target === hovered) s.add(e.source);
    }
    return s;
  }, [hovered, crossEdges]);

  const contentRef = useRef<HTMLDivElement>(null);
  const chipEls = useRef(new Map<string, HTMLElement>());
  const [paths, setPaths] = useState<Array<{ edge: GraphEdge; d: string; mx: number; my: number }>>([]);
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });

  const registerRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) chipEls.current.set(id, el);
    else chipEls.current.delete(id);
  }, []);

  const measure = useCallback(() => {
    const root = contentRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    setSvgSize({ w: root.scrollWidth, h: root.scrollHeight });
    const next: Array<{ edge: GraphEdge; d: string; mx: number; my: number }> = [];
    for (const e of crossEdges) {
      const a = chipEls.current.get(e.source);
      const b = chipEls.current.get(e.target);
      if (!a || !b) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      // Anchor to chip EDGES, not centers — center-to-center produced lines
      // slicing vertically through cards. Chips in different columns connect
      // side-to-side with a horizontal S-curve; same-column chips bow out to
      // the side instead of drawing a straight rule through the card.
      const aCy = ra.top - rootRect.top + ra.height / 2;
      const bCy = rb.top - rootRect.top + rb.height / 2;
      const gapX = rb.left - ra.left;
      let d: string, mx: number, my: number;
      if (Math.abs(gapX) > ra.width * 0.6) {
        // different columns → leave from facing sides, horizontal curve
        const aRight = gapX > 0;
        const x1 = (aRight ? ra.right : ra.left) - rootRect.left;
        const x2 = (aRight ? rb.left : rb.right) - rootRect.left;
        const cx = (x2 - x1) * 0.45;
        d = `M ${x1} ${aCy} C ${x1 + cx} ${aCy}, ${x2 - cx} ${bCy}, ${x2} ${bCy}`;
        mx = (x1 + x2) / 2; my = (aCy + bCy) / 2 - 6;
      } else {
        // same column → bow out to the right in a clean arc
        const x1 = ra.right - rootRect.left;
        const x2 = rb.right - rootRect.left;
        const bow = 36 + Math.min(40, Math.abs(bCy - aCy) * 0.12);
        d = `M ${x1} ${aCy} C ${x1 + bow} ${aCy}, ${x2 + bow} ${bCy}, ${x2} ${bCy}`;
        mx = Math.max(x1, x2) + bow * 0.8; my = (aCy + bCy) / 2;
      }
      next.push({ edge: e, d, mx, my });
    }
    setPaths(next);
  }, [crossEdges]);

  useEffect(() => {
    const t = setTimeout(measure, 50);
    const ro = new ResizeObserver(() => measure());
    if (contentRef.current) ro.observe(contentRef.current);
    return () => { clearTimeout(t); ro.disconnect(); };
  }, [measure, visibleTypes, data]);

  const openNode = (n: GraphNode) => {
    const rawId = (n.metadata.raw_id as string) ?? n.id.split(':')[1] ?? n.id;
    if (n.type === 'goal') return navigateToGoal(rawId);
    if (n.type === 'task') {
      const gid = n.metadata.goal_id as string | undefined;
      if (gid) { navigateToGoal(gid); setFocusedTaskId(rawId); }
      return;
    }
    if (n.type === 'resource') return navigateToResource(rawId);
    if (n.type === 'journal') return setCurrentTab('Journal');
    if (n.type === 'milestone') {
      const gid = n.metadata.goal_id as string | undefined;
      if (gid) navigateToGoal(gid);
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div ref={contentRef} className="relative p-6 min-h-full">
        <svg width={svgSize.w} height={svgSize.h} className="absolute top-0 left-0 pointer-events-none" style={{ zIndex: 5 }}>
          {paths.map(({ edge, d, mx, my }) => {
            const active = hovered && (edge.source === hovered || edge.target === hovered);
            const anyHover = Boolean(hovered);
            return (
              <g key={edge.id}>
                <path
                  d={d}
                  fill="none"
                  stroke={active ? '#818cf8' : '#475569'}
                  strokeWidth={active ? 2 : 1}
                  strokeDasharray={edge.relationship === 'co_cited' ? '4 3' : undefined}
                  opacity={anyHover ? (active ? 0.95 : 0.08) : 0.35}
                />
                {active && (
                  <text x={mx} y={my} textAnchor="middle" fontSize="10" fill="#a5b4fc" className="font-mono">
                    {REL_EXPLAIN[edge.relationship] ?? edge.relationship}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        <div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3 relative" style={{ zIndex: 1 }}>
          {clusters.map(({ goal, members }) => {
            const visMembers = members.filter(m => visibleTypes.has(m.type));
            const byType: Record<string, GraphNode[]> = {};
            for (const m of visMembers) (byType[m.type] ??= []).push(m);
            return (
              <div key={goal.id} className="bg-gray-900/70 border border-gray-800 rounded-2xl p-4 min-w-0">
                {visibleTypes.has('goal') && (
                  <Chip
                    node={goal}
                    dimmed={Boolean(hovered) && hovered !== goal.id && !relatedIds.has(goal.id)}
                    related={relatedIds.has(goal.id)}
                    hovered={hovered === goal.id}
                    onHover={setHovered}
                    onClick={openNode}
                    onFocus={onFocus}
                    registerRef={registerRef}
                  />
                )}
                {visMembers.length === 0 && (
                  <p className="text-[10px] text-gray-600 font-mono mt-2">nothing connected (or filtered out)</p>
                )}
                {SECTION_ORDER.filter(t => byType[t]?.length).map(t => (
                  <div key={t} className="mt-3">
                    <p className="text-[9px] font-mono uppercase tracking-widest mb-1" style={{ color: TYPE_META[t].color }}>
                      {TYPE_META[t].plural} ({byType[t].length})
                    </p>
                    <div className="space-y-1">
                      {byType[t].map(m => (
                        <Chip
                          key={m.id}
                          node={m}
                          dimmed={Boolean(hovered) && hovered !== m.id && !relatedIds.has(m.id)}
                          related={relatedIds.has(m.id)}
                          hovered={hovered === m.id}
                          onHover={setHovered}
                          onClick={openNode}
                          onFocus={onFocus}
                          registerRef={registerRef}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}

          {unlinked.filter(n => visibleTypes.has(n.type)).length > 0 && (
            <div className="bg-gray-900/40 border border-dashed border-gray-800 rounded-2xl p-4 min-w-0">
              <p className="text-[11px] font-bold text-gray-500 mb-1">Not connected to any goal</p>
              <p className="text-[10px] text-gray-600 mb-2 leading-relaxed">
                These float free — link them from their pages, or let journal ingestion and topic suggestions pull them in.
              </p>
              <div className="space-y-1">
                {unlinked.filter(n => visibleTypes.has(n.type)).map(n => (
                  <Chip
                    key={n.id}
                    node={n}
                    dimmed={Boolean(hovered) && hovered !== n.id && !relatedIds.has(n.id)}
                    related={relatedIds.has(n.id)}
                    hovered={hovered === n.id}
                    onHover={setHovered}
                    onClick={openNode}
                    onFocus={onFocus}
                    registerRef={registerRef}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {data.truncated && (
          <p className="text-center text-[10px] font-mono text-gray-600 mt-4">
            Showing 300 of {data.total_nodes} records.
          </p>
        )}
      </div>
    </div>
  );
}
