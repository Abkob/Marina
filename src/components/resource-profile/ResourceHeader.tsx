import { useState, useEffect } from 'react';
import { ExternalLink } from 'lucide-react';
import { ResourceTypeIcon } from '../ResourceMentionPicker';
import { nextReadState } from '../../db/queries/resources';
import type { DBResource, ResourceReadState, ResourceType } from '../../db/schema';

const RESOURCE_TYPES: { value: ResourceType; label: string }[] = [
  { value: 'paper',    label: 'Paper'    },
  { value: 'person',   label: 'Person'   },
  { value: 'dataset',  label: 'Dataset'  },
  { value: 'concept',  label: 'Concept'  },
  { value: 'link',     label: 'Link/URL' },
  { value: 'document', label: 'Document' },
  { value: 'figma',    label: 'Figma'    },
  { value: 'other',    label: 'Other'    },
];

const READ_STATE_STYLE: Record<ResourceReadState, string> = {
  Unread:  'bg-gray-100 text-gray-500',
  Reading: 'bg-amber-100 text-amber-700',
  Done:    'bg-emerald-100 text-emerald-700',
  Shelved: 'bg-slate-100 text-slate-500',
};

type SavePatch = Partial<Pick<DBResource, 'title' | 'type' | 'url' | 'info' | 'read_state' | 'next_action'>>;

export function ResourceHeader({
  resource,
  onSave,
}: {
  resource: DBResource;
  onSave: (patch: SavePatch) => void;
}) {
  const [title,      setTitle]      = useState(resource.title);
  const [url,        setUrl]        = useState(resource.url ?? '');
  const [nextAction, setNextAction] = useState(resource.next_action);

  useEffect(() => { setTitle(resource.title);           }, [resource.title]);
  useEffect(() => { setUrl(resource.url ?? '');         }, [resource.url]);
  useEffect(() => { setNextAction(resource.next_action);}, [resource.next_action]);

  const saveTitle = () => {
    const t = title.trim();
    if (!t) { setTitle(resource.title); return; }
    if (t !== resource.title) onSave({ title: t });
  };

  const saveUrl = () => {
    const u = url.trim();
    if (u !== (resource.url ?? '')) onSave({ url: u || null });
  };

  const saveNextAction = () => {
    if (nextAction !== resource.next_action) onSave({ next_action: nextAction });
  };

  return (
    <div className="border-b border-gray-100 bg-white px-8 py-6">
      {/* Row 1: icon + title + type + read state */}
      <div className="flex items-start gap-4">
        <div className="mt-1 shrink-0" data-testid="type-icon">
          <ResourceTypeIcon type={resource.type} size={22} />
        </div>

        <div className="min-w-0 flex-1">
          {/* Title */}
          <textarea rows={2}
            aria-label="Resource title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
            className="resize-none w-full text-xl font-bold text-gray-900 outline-none bg-transparent border-b border-transparent
              hover:border-gray-200 focus:border-[#4648d4] transition-colors pb-0.5 leading-tight"
          />

          {/* Row 2: type selector + read state */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              aria-label="Resource type"
              value={resource.type}
              onChange={e => onSave({ type: e.target.value as ResourceType })}
              className="rounded-full bg-gray-100 px-2.5 py-1 font-mono text-[9px] uppercase tracking-wide
                text-gray-500 outline-none cursor-pointer hover:bg-gray-200 transition-colors"
            >
              {RESOURCE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>

            <button
              onClick={() => onSave({ read_state: nextReadState(resource.read_state) })}
              className={`rounded-full px-3 py-1 font-mono text-[9px] uppercase tracking-widest
                font-bold transition-colors cursor-pointer select-none
                ${READ_STATE_STYLE[resource.read_state]}`}
            >
              {resource.read_state}
            </button>

            <span className="font-mono text-[9px] text-gray-300">
              Added {new Date(resource.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          </div>

          {/* Next action */}
          <div className="mt-3">
            <input
              aria-label="Next action for resource"
              value={nextAction}
              onChange={e => setNextAction(e.target.value)}
              onBlur={saveNextAction}
              placeholder="Next action on this resource…"
              className="w-full text-sm text-gray-600 italic outline-none bg-transparent border-b border-transparent
                hover:border-gray-200 focus:border-[#4648d4] focus:not-italic transition-colors pb-0.5
                placeholder:text-gray-300 placeholder:not-italic"
            />
          </div>
        </div>
      </div>

      {/* URL field */}
      <div className="mt-4 flex items-center gap-2">
        <input
          aria-label="Resource URL"
          value={url}
          onChange={e => setUrl(e.target.value)}
          onBlur={saveUrl}
          placeholder="URL or link…"
          className="flex-1 font-mono text-xs text-gray-400 outline-none bg-transparent border-b border-transparent
            hover:border-gray-200 focus:border-[#4648d4] transition-colors pb-0.5 placeholder:text-gray-200"
        />
        {resource.url?.startsWith('http') && (
          <a
            href={resource.url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[9px]
              text-[#4648d4] hover:bg-[#EEF2FF] transition-colors"
            aria-label="Open link"
          >
            <ExternalLink size={10} /> Open link
          </a>
        )}
      </div>
    </div>
  );
}
