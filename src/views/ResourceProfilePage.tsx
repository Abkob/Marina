import { MobileDisclosure } from '../components/MobileDisclosure';
import { useEffect, useState } from 'react';
import { ChevronLeft, Trash2 } from 'lucide-react';
import {
  getResource, updateResource, deleteResource,
  getResourceLogs, addResourceLog, deleteResourceLog,
  getResourceReferences, getResourceStats, getResourceGraph,
} from '../db/queries/resources';
import { useAppStore } from '../store/useAppStore';
import { useInvalidate } from '../api/hooks';
import type { DBResource, ResourceLog, ResourceStats } from '../db/schema';
import type { ResourceReference, ResourceGraphData } from '../db/queries/resources';

import { ResourceHeader }          from '../components/resource-profile/ResourceHeader';
import { ResourceTagEditor }       from '../components/resource-profile/ResourceTagEditor';
import { ResourceStatsBar }        from '../components/resource-profile/ResourceStatsBar';
import { ResourceActivityChart }   from '../components/resource-profile/ResourceActivityChart';
import { ResourceConnectionGraph } from '../components/resource-profile/ResourceConnectionGraph';
import { ResourceInsightsPinned }  from '../components/resource-profile/ResourceInsightsPinned';
import { ResourceTimeline }        from '../components/resource-profile/ResourceTimeline';
import { ResourceLogComposer }     from '../components/resource-profile/ResourceLogComposer';
import { CoCitationPanel }         from '../components/resource-profile/CoCitationPanel';
import { SemanticIndexPanel }      from '../components/resource-profile/SemanticIndexPanel';
import { EntityTopicChips }        from '../components/EntityTopicChips';
import { GoalCoveragePanel }       from '../components/resource-profile/GoalCoveragePanel';
import { ReferencedTasksPanel }    from '../components/resource-profile/ReferencedTasksPanel';

export function ResourceProfilePage({ resourceId }: { resourceId: string }) {
  const { setFocusedResourceId, navigateToGoal, showConfirm, triggerToast } = useAppStore();
  const invalidate = useInvalidate();
  // Navigate to a task: switch to Goals tab then focus that task
  const { setCurrentTab, setSelectedGoalId, setFocusedTaskId } = useAppStore();

  const [resource,  setResource]  = useState<DBResource | null>(null);
  const [logs,      setLogs]      = useState<ResourceLog[]>([]);
  const [refs,      setRefs]      = useState<ResourceReference[]>([]);
  const [stats,     setStats]     = useState<ResourceStats | null>(null);
  const [graphData, setGraphData] = useState<ResourceGraphData>({ nodes: [], edges: [] });
  const [notFound,  setNotFound]  = useState(false);

  const loadAll = async () => {
    const [r, l, rf, s, g] = await Promise.all([
      getResource(resourceId).catch(() => null),
      getResourceLogs(resourceId).catch(() => [] as ResourceLog[]),
      getResourceReferences(resourceId).catch(() => [] as ResourceReference[]),
      getResourceStats(resourceId).catch(() => null as ResourceStats | null),
      getResourceGraph(resourceId).catch(() => ({ nodes: [], edges: [] } as ResourceGraphData)),
    ]);
    if (!r) { setNotFound(true); return; }
    setResource(r);
    setLogs(l);
    setRefs(rf);
    setStats(s);
    setGraphData(g);
  };

  useEffect(() => {
    loadAll();
    const id = setInterval(loadAll, 3000);
    return () => clearInterval(id);
  }, [resourceId]);

  const save = async (patch: Parameters<typeof updateResource>[1]) => {
    await updateResource(resourceId, patch);
    setResource(prev => prev ? { ...prev, ...patch } : prev);
    loadAll();
  };

  const saveTags = (tags: string[]) => {
    save({ tags_json: JSON.stringify(tags) });
  };

  const handleSubmitLog = async (content: string, isInsight: boolean) => {
    await addResourceLog(resourceId, content, isInsight);
    triggerToast(isInsight ? 'Insight saved.' : 'Log entry added.', 'success');
    loadAll();
  };

  const handleDeleteLog = (log: ResourceLog) => {
    showConfirm('Remove this log entry?', async () => {
      await deleteResourceLog(resourceId, log.id);
      setLogs(prev => prev.filter(l => l.id !== log.id));
    });
  };

  const handleTaskClick = (taskId: string) => {
    // Find the task's goal from graph data
    const taskNode = graphData.nodes.find(n => n.id === taskId);
    const goalId   = taskNode?.meta?.goal_id as string | undefined;
    if (goalId) {
      navigateToGoal(goalId);
      setFocusedTaskId(taskId);
    }
  };

  const handleGoalClick = (goalId: string) => {
    navigateToGoal(goalId);
  };

  const handleResourceClick = (id: string) => {
    setFocusedResourceId(id);
  };

  if (notFound) {
    return (
      <div data-testid="resource-profile-page" className="flex flex-col items-center justify-center py-32">
        <p className="text-lg font-bold text-gray-400">Resource not found</p>
        <button onClick={() => setFocusedResourceId(null)} className="mt-4 text-sm text-[#4648d4] hover:underline" aria-label="Back to resource library">
          ← Back to library
        </button>
      </div>
    );
  }

  const tags = resource ? (() => { try { return JSON.parse(resource.tags_json); } catch { return []; } })() : [];

  return (
    <div data-testid="resource-profile-page" className="min-h-full bg-[#f8f9fa] animate-fade-in">
      {/* Back + delete */}
      <div className="flex items-center gap-2 px-8 pt-5 pb-2">
        <button
          onClick={() => setFocusedResourceId(null)}
          className="mobile-duplicate-back inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest
            text-gray-400 hover:text-gray-700 transition-colors"
          aria-label="back to library"
        >
          <ChevronLeft size={13} />
          Back to library
        </button>
        <button
          onClick={() => showConfirm(
            `Delete "${resource?.title ?? 'this resource'}"? Its file, chunks, and embeddings are removed. Tasks/goals that referenced it are untouched.`,
            async () => {
              await deleteResource(resourceId);
              // Without invalidation the library list stays cached and the
              // deleted resource "reappears" until a manual refresh.
              invalidate.resources();
              triggerToast('Resource deleted.', 'info');
              setFocusedResourceId(null);
            },
          )}
          className="ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest
            text-gray-400 hover:text-red-500 transition-colors"
          aria-label={`Delete resource ${resource?.title ?? ''}`}
        >
          <Trash2 size={12} />
          Delete resource
        </button>
      </div>

      {/* Header */}
      {resource ? (
        <ResourceHeader resource={resource} onSave={save} />
      ) : (
        <div className="h-28 animate-pulse bg-gray-100" />
      )}

      {/* Tags */}
      {resource && (
        <ResourceTagEditor
          tags={tags}
          onChange={saveTags}
        />
      )}

      {/* Topic memberships — same clusters the AI suggests against */}
      {resource && (
        <div className="px-8 pb-2">
          <EntityTopicChips entityType="resource" entityId={resourceId} />
        </div>
      )}

      {/* Stats bar */}
      <MobileDisclosure title="Reading activity" storageKey="resource-activity"><ResourceStatsBar stats={stats} /><ResourceActivityChart logs={logs} refs={refs} /></MobileDisclosure>

      <div className="px-8 pb-10 space-y-8">
        {/* Activity chart */}


        {/* Connection graph */}
        <MobileDisclosure title="Connections" storageKey="resource-connections"><div>
          <p className="mb-3 font-mono text-[9px] font-bold uppercase tracking-widest text-gray-400">
            Connection Graph
          </p>
          <ResourceConnectionGraph
            data={graphData}
            onTaskClick={handleTaskClick}
            onResourceClick={handleResourceClick}
          />
        </div></MobileDisclosure>

        {/* Two-column content */}
        <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
          {/* Left: insights + timeline + composer */}
          <div>
            <ResourceInsightsPinned logs={logs} onDelete={handleDeleteLog} />

            <div className="mb-4">
              <p className="mb-3 font-mono text-[9px] font-bold uppercase tracking-widest text-gray-400">
                Activity &amp; References
                <span className="ml-2 font-normal text-gray-300">
                  {logs.filter(l => l.is_insight === 0).length + refs.length} events
                </span>
              </p>
              <ResourceTimeline
                logs={logs}
                refs={refs}
                onDeleteLog={handleDeleteLog}
              />
            </div>

            <div className="mt-6">
              <p className="mb-2 font-mono text-[9px] font-bold uppercase tracking-widest text-gray-400">
                Add to Log
              </p>
              <ResourceLogComposer onSubmit={handleSubmitLog} />
            </div>
          </div>

          {/* Right: panels */}
          <div className="space-y-6">
            <SemanticIndexPanel
              resourceId={resourceId}
              hasFile={Boolean(resource?.file_path) || Boolean(resource?.url?.startsWith('/api/resources/serve/'))}
            />
            <CoCitationPanel
              graphData={graphData}
              onResourceClick={handleResourceClick}
            />
            <GoalCoveragePanel
              graphData={graphData}
              onGoalClick={handleGoalClick}
            />
            <ReferencedTasksPanel
              graphData={graphData}
              onTaskClick={handleTaskClick}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
