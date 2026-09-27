import { Layers3 } from 'lucide-react';
import { PlanCalendarWidget, type ChatPlan } from './PlanCalendarWidget';

export interface ChatPlanOption extends ChatPlan {
  option_id: string;
  name: string;
  description: string;
}

export interface ChatPlanOptions {
  kind: 'plan_options';
  title: string;
  summary: string;
  advisory?: string | null;
  options: ChatPlanOption[];
}

function fmtMins(mins: number): string {
  const rounded = Math.round(mins);
  const abs = Math.abs(rounded);
  if (abs === 0) return '0h';
  if (abs < 60) return `${rounded}m`;
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${rounded < 0 ? '-' : ''}${h}h${m ? ` ${m}m` : ''}`;
}

function StatusPill({ option }: { option: ChatPlanOption }) {
  const tone =
    option.scheduler.status === 'feasible' ? 'text-emerald-700 border-emerald-400/25 bg-emerald-500/10'
      : option.scheduler.status === 'impossible' ? 'text-red-700 border-red-400/25 bg-red-500/10'
        : 'text-amber-700 border-amber-400/25 bg-amber-500/10';

  return (
    <span className={`rounded-full border px-2 py-0.5 font-mono text-[8px] font-bold uppercase ${tone}`}>
      {option.scheduler.status}
    </span>
  );
}

export function PlanOptionsWidget({ planOptions }: { planOptions: ChatPlanOptions }) {
  if (!planOptions.options.length) return null;
  if (planOptions.options.length === 1) {
    return <PlanCalendarWidget plan={planOptions.options[0]} sessionId={null} />;
  }

  return (
    <div className="mt-2 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="flex items-start gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-700">
            <Layers3 size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-slate-900">{planOptions.title}</p>
            <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{planOptions.summary}</p>
          </div>
          <span className="shrink-0 rounded-full border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-[9px] font-bold uppercase text-slate-500">
            {planOptions.options.length} schedule{planOptions.options.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      <div className="space-y-4 p-3">
        {planOptions.options.map((option, index) => (
          <section key={option.option_id} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <div className="mb-2 flex flex-wrap items-start gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15 font-mono text-[10px] font-bold text-indigo-700">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-bold text-slate-900">{option.name}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{option.description}</p>
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                <StatusPill option={option} />
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[8px] font-bold uppercase text-slate-500">
                  {option.blocks.length} blocks
                </span>
                {option.scheduler.gap_minutes !== 0 && (
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[8px] font-bold uppercase text-slate-500">
                    {option.scheduler.gap_minutes > 0 ? '+' : ''}{fmtMins(option.scheduler.gap_minutes)}
                  </span>
                )}
              </div>
            </div>

            <PlanCalendarWidget
              key={option.option_id}
              plan={option}
              sessionId={null}
            />
          </section>
        ))}
      </div>
    </div>
  );
}
