import { useMobileSchedulePreferences } from '../hooks/useMobileSchedulePreferences';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '../hooks/useMediaQuery';

export function MobileDisplaySettings() {
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const { compact, view, setCompact, setView } = useMobileSchedulePreferences();
  if (!mobile) return null;
  return <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="Phone display preferences">
    <h3 className="text-sm font-semibold text-slate-900">Your phone</h3>
    <label className="my-3 flex min-h-12 items-center justify-between gap-4"><span><span className="block text-sm font-medium text-slate-700">Compact calendar</span><span className="mt-1 block text-xs leading-5 text-slate-500">Smaller controls, more room for your day.</span></span><input aria-label="Compact calendar" type="checkbox" role="switch" checked={compact} onChange={event => setCompact(event.target.checked)} className="phone-preference-switch shrink-0" /></label>
    <label className="block text-xs font-semibold text-slate-500">Calendar view<select aria-label="Preferred calendar view" value={view} onChange={event => setView(event.target.value as 'day' | 'agenda')} className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-slate-800"><option value="day">Day timeline</option><option value="agenda">Agenda list</option></select></label>
    <p className="mt-3 text-xs text-slate-500">Saved automatically on this device.</p>
  </section>;
}
