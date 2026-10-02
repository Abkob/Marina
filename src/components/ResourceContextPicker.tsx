import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as Popover from '@radix-ui/react-popover';
import { AtSign, Check, X } from 'lucide-react';
import { apiFetch } from '../utils/apiFetch';
import type { ResourceScope, ResourceSelection } from '../../shared/resourceScope';
export type { ResourceSelection } from '../../shared/resourceScope';

export const selectionScope = (value: ResourceSelection | null): ResourceScope => !value ? {} : value.kind === 'resource'
  ? { resource_ids: [value.id] } : value.kind === 'goal' ? { goal_id: value.id } : { task_id: value.id, include_subtasks: Boolean(value.include_subtasks) };
export const selectionTarget = (value: ResourceSelection | null) => value && value.kind !== 'resource'
  ? { attach_to_id: value.id, attach_to_type: value.kind } : undefined;

export function ResourceContextPicker({ value, onChange, disabled, uploads = false, open: controlledOpen, onOpenChange }: {
  value: ResourceSelection | null; onChange: (value: ResourceSelection | null) => void; disabled?: boolean; uploads?: boolean;
  open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => { setInternalOpen(next); onOpenChange?.(next); };
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const timer = setTimeout(() => setQuery(search), 200); return () => clearTimeout(timer); }, [search]);
  const choices = useQuery<ResourceSelection[]>({ queryKey: ['resource-context-options', query], enabled: open,
    queryFn: () => apiFetch(`/api/google-drive/context-options?search=${encodeURIComponent(query)}`), retry: false });
  return <div className="flex min-w-0 items-center gap-1">
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger disabled={disabled} aria-label={uploads ? 'Choose resource folder' : 'Choose chat resource context'}
        className="inline-flex min-h-11 min-w-11 max-w-64 items-center gap-2 rounded-lg px-2 text-xs text-slate-500 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-indigo-400">
        <AtSign size={15} className="shrink-0" /><span className="truncate">{value?.title ?? (uploads ? 'Marina / Library' : 'Marina resources')}</span>
      </Popover.Trigger>
      <Popover.Portal><Popover.Content side="top" align="start" sideOffset={8} collisionPadding={12}
        className="z-[100] w-[min(360px,calc(100vw-24px))] rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
        <p className="px-2 py-1 text-xs text-slate-500">{uploads ? 'Save into a goal or task folder' : 'Use only these resources'}</p>
        <input aria-label="Find a goal, task or resource" placeholder={uploads ? 'Find goal or task…' : 'Find goal, task or document…'} value={search} onChange={e => setSearch(e.target.value)}
          className="my-2 min-h-11 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-indigo-400" />
        <div className="max-h-64 overflow-y-auto">
          {choices.isFetching && <p role="status" className="p-2 text-xs text-slate-400">Finding context…</p>}
          {choices.isError && <p role="alert" className="p-2 text-xs text-red-600">{choices.error.message}</p>}
          {choices.data?.filter(item => !uploads || item.kind !== 'resource').map(item => <button key={`${item.kind}:${item.id}`} type="button"
            onClick={() => { onChange(item); setOpen(false); setSearch(''); }}
            className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-indigo-400">
            <span className="min-w-0 flex-1 truncate">{item.title}</span><small className="text-slate-400">{item.kind}</small>{value?.id === item.id && <Check size={14} />}
          </button>)}
          {!choices.isFetching && choices.data?.length === 0 && <p className="p-2 text-xs text-slate-500">No matching context.</p>}
        </div>
        {value?.kind === 'task' && !uploads && <label className="flex min-h-11 items-center gap-2 px-2 text-xs text-slate-500"><input type="checkbox" checked={Boolean(value.include_subtasks)} onChange={e => onChange({ ...value, include_subtasks: e.target.checked })} />Include subtask resources</label>}
      </Popover.Content></Popover.Portal>
    </Popover.Root>
    {value && <button type="button" disabled={disabled} aria-label="Clear resource context" onClick={() => onChange(null)} className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-indigo-400"><X size={14} /></button>}
  </div>;
}
