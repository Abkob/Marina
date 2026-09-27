import { useRef, useMemo, useState, useEffect } from 'react';
import ForceGraph2D, { type ForceGraphMethods, type NodeObject, type LinkObject } from 'react-force-graph-2d';
import { useAppStore } from '../../store/useAppStore';
import { TYPE_META, REL_EXPLAIN, type GraphData, type GraphNode } from './types';

/**
 * Obsidian-style force web: canvas + d3-force physics (react-force-graph-2d).
 * The signature traits, matched deliberately:
 *  - node size grows with connection count (hubs read as hubs)
 *  - hovering lights the neighborhood with a soft glow and fades the rest
 *  - labels appear as you zoom in (goals always labeled)
 *  - gentle physics; drag a node and the web reacts
 */

interface FGNode extends NodeObject {
  id: string;
  label: string;
  entityType: string;
  degree: number;
  meta: Record<string, unknown>;
}
interface FGLink extends LinkObject {
  source: string | FGNode;
  target: string | FGNode;
  rel: string;
}

const idOf = (v: string | FGNode): string => (typeof v === 'string' ? v : v.id);

export function ForceWeb({ data, visibleTypes, onFocus }: { data: GraphData; visibleTypes: Set<string>; onFocus?: (id: string) => void }) {
  const { navigateToGoal, navigateToResource, setFocusedTaskId, setCurrentTab, setSelectedGoalId } = useAppStore();
  const fgRef = useRef<ForceGraphMethods<FGNode, FGLink> | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const didFit = useRef(false);

  // Fill the container and track resizes — the canvas needs explicit px dims.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { graphData, neighbors } = useMemo(() => {
    const nodes: FGNode[] = data.nodes
      .filter(n => visibleTypes.has(n.type))
      .map(n => ({ id: n.id, label: n.label, entityType: n.type, degree: 0, meta: n.metadata }));
    const byId = new Map(nodes.map(n => [n.id, n]));
    const links: FGLink[] = [];
    const neighbors = new Map<string, Set<string>>();
    for (const e of data.edges) {
      if (!byId.has(e.source) || !byId.has(e.target)) continue;
      links.push({ source: e.source, target: e.target, rel: e.relationship });
      byId.get(e.source)!.degree++;
      byId.get(e.target)!.degree++;
      if (!neighbors.has(e.source)) neighbors.set(e.source, new Set());
      if (!neighbors.has(e.target)) neighbors.set(e.target, new Set());
      neighbors.get(e.source)!.add(e.target);
      neighbors.get(e.target)!.add(e.source);
    }
    return { graphData: { nodes, links }, neighbors };
  }, [data, visibleTypes]);

  // Physics tuning: a little more repulsion + shorter links than defaults
  // gives the airy, settled Obsidian look instead of a tight clump.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force('charge')?.strength(-180);
    fg.d3Force('link')?.distance(50);
    didFit.current = false;
  }, [graphData]);

  const highlight = useMemo(() => {
    if (!hoverId) return new Set<string>();
    const s = new Set<string>([hoverId]);
    for (const n of neighbors.get(hoverId) ?? []) s.add(n);
    return s;
  }, [hoverId, neighbors]);

  const openNode = (node: FGNode) => {
    const rawId = (node.meta.raw_id as string) ?? node.id.split(':')[1] ?? node.id;
    if (node.entityType === 'goal') return navigateToGoal(rawId);
    if (node.entityType === 'task') {
      const gid = node.meta.goal_id as string | undefined;
      if (gid) { navigateToGoal(gid); setFocusedTaskId(rawId); }
      return;
    }
    if (node.entityType === 'resource') return navigateToResource(rawId);
    if (node.entityType === 'journal') return setCurrentTab('Journal');
    if (node.entityType === 'milestone') {
      const gid = node.meta.goal_id as string | undefined;
      if (gid) navigateToGoal(gid);
    }
  };

  const radiusOf = (node: FGNode) =>
    (node.entityType === 'goal' ? 6 : 3) + Math.sqrt(node.degree + 1) * 1.6;

  return (
    <div ref={wrapRef} className="w-full h-full">
      <ForceGraph2D<FGNode, FGLink>
        ref={fgRef}
        width={size.w}
        height={size.h}
        graphData={graphData}
        backgroundColor="#05070d"
        d3VelocityDecay={0.25}
        cooldownTicks={140}
        onEngineStop={() => {
          if (!didFit.current) { didFit.current = true; fgRef.current?.zoomToFit(600, 70); }
        }}
        nodeVal={n => radiusOf(n) ** 2 / 4}
        nodeLabel={() => ''}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const x = node.x ?? 0, y = node.y ?? 0;
          const r = radiusOf(node);
          const anyHover = highlight.size > 0;
          const active = highlight.has(node.id);
          const color = TYPE_META[node.entityType]?.color ?? '#6b7280';

          ctx.globalAlpha = anyHover && !active ? 0.10 : 1;

          // soft glow halo on the active neighborhood (and always, faintly, on goals)
          if ((active && anyHover) || node.entityType === 'goal') {
            ctx.beginPath();
            ctx.arc(x, y, r * 2.1, 0, 2 * Math.PI);
            ctx.fillStyle = color + (active && anyHover ? '33' : '14');
            ctx.fill();
          }

          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
          if (node.id === hoverId) {
            ctx.lineWidth = 1.2 / globalScale;
            ctx.strokeStyle = '#e0e7ff';
            ctx.stroke();
          }

          // Labels: goals always; everything else fades in with zoom or on hover.
          const showLabel = node.entityType === 'goal' || active || globalScale > 2.1;
          if (showLabel && !(anyHover && !active)) {
            const fs = Math.max(11 / globalScale, node.entityType === 'goal' ? 3.2 : 2.6);
            ctx.font = `500 ${fs}px ui-sans-serif, system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            const text = node.label.length > 30 ? node.label.slice(0, 29) + '…' : node.label;
            ctx.fillStyle = active ? '#e0e7ff' : 'rgba(203,213,225,0.85)';
            ctx.fillText(text, x, y + r + 1.5);
          }
          ctx.globalAlpha = 1;
        }}
        nodePointerAreaPaint={(node, color, ctx) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(node.x ?? 0, node.y ?? 0, radiusOf(node) + 4, 0, 2 * Math.PI);
          ctx.fill();
        }}
        linkColor={l => {
          const active = hoverId && (idOf(l.source) === hoverId || idOf(l.target) === hoverId);
          if (active) return '#818cf8';
          return highlight.size > 0 ? 'rgba(71,85,105,0.06)' : 'rgba(100,116,139,0.22)';
        }}
        linkWidth={l => (hoverId && (idOf(l.source) === hoverId || idOf(l.target) === hoverId) ? 1.6 : 0.7)}
        linkLabel={l => REL_EXPLAIN[l.rel] ?? l.rel}
        onNodeHover={n => setHoverId(n ? n.id : null)}
        onNodeClick={n => openNode(n)}
        onNodeRightClick={n => onFocus?.(n.id)}
        onBackgroundClick={() => setHoverId(null)}
      />
    </div>
  );
}

export type { GraphNode };
