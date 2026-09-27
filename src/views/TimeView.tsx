import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { useSchedulePrefs } from '../api/hooks';
import { useCloudWorkTimer } from '../hooks/useCloudWorkTimer';
import { apiFetch } from '../utils/apiFetch';
import { addRoutineDays } from '../utils/routines';
import { mergeLiveTime, timeDate, timeLabel, timeLevel, timeMonth, timeWindow, type TimeHeatmap, type TimeLiveDay } from '../utils/timeHeatmap';
import './TimeView.css';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const fullDate = (date: string) => new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));

export function TimeView() {
  const cloud = useCloudWorkTimer();
  const prefs = useSchedulePrefs();
  const [chosenYear, setChosenYear] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const fallbackToday = timeDate(cloud.nowMs, prefs.data?.timezone ?? 'Asia/Beirut');
  const currentYear = Number(fallbackToday.slice(0, 4));
  const currentMonth = Number(fallbackToday.slice(5, 7)) - 1;
  const year = chosenYear ?? currentYear;
  const months = useMemo(() => timeWindow(year, currentMonth).map(month => ({
    ...month, name: MONTHS[month.month], cells: timeMonth(month.year, month.month),
  })), [year, currentMonth]);
  const years = [...new Set(months.map(month => month.year))];
  const queries = useQueries({
    queries: years.map(dataYear => ({
      queryKey: ['work-sessions', 'heatmap', dataYear],
      queryFn: ({ signal }: { signal: AbortSignal }) => apiFetch<TimeHeatmap>(`/api/work-sessions/heatmap?year=${dataYear}`, { signal, cache: 'no-store' }),
      refetchInterval: 30_000,
      refetchOnWindowFocus: 'always' as const,
      staleTime: 10_000,
    })),
  });
  const firstData = queries[0]?.data, secondData = queries[1]?.data;
  const unavailable = queries.some(query => !query.data);
  const isError = queries.some(query => query.isError);
  const today = firstData ? timeDate(cloud.nowMs, firstData.timezone) : fallbackToday;
  // Displayed durations have minute precision. Avoid rebuilding a year's
  // calendar on every second of a running timer.
  const nowMinute = Math.floor(cloud.nowMs / 60_000) * 60_000;
  const days = useMemo(() => {
    const result = new Map<string, TimeLiveDay>();
    if (unavailable) return result;
    const visible = new Set(months.map(month => month.key));
    for (const data of [firstData, secondData]) if (data) {
      for (const [date, day] of mergeLiveTime(data, cloud.timer, nowMinute)) {
        if (visible.has(date.slice(0, 7))) result.set(date, day);
      }
    }
    return result;
  }, [firstData, secondData, unavailable, months, cloud.timer, nowMinute]);
  const oldest = months[9], newest = months[2];
  const rangeLabel = `${oldest.name.slice(0, 3)} ${oldest.year} – ${newest.name.slice(0, 3)} ${newest.year}`;
  const total = [...days.values()].reduce((sum, day) => sum + day.minutes, 0);
  const visibleDate = (date: string | null) => date && months.some(month => date.startsWith(month.key)) ? date : null;
  const activeDate = visibleDate(hovered) ?? visibleDate(selected) ?? (year === currentYear ? today : null);
  const activeDay = activeDate ? days.get(activeDate) : null;
  // Hover previews must not add/remove content above the matrix and move the
  // square beneath the pointer. Only an intentional selection changes details.
  const detailDate = visibleDate(selected) ?? (year === currentYear ? today : null);
  const detailDay = detailDate ? days.get(detailDate) : null;

  function changeYear(next: number) {
    setChosenYear(next); setSelected(null); setFocused(null); setHovered(null);
  }
  function move(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const offset = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key];
    if (offset !== undefined) {
      event.preventDefault();
      const next = addRoutineDays(date, offset);
      buttons.current.get(next)?.focus();
    } else if (event.key === 'Escape') { setSelected(null); setHovered(null); }
  }

  return <section className="time-page" aria-labelledby="time-title">
    <header className="time-page-heading">
      <div><h1 id="time-title">Time</h1><p>Your time, day by day.</p></div>
      <span className="time-eyebrow">A year in focus</span>
    </header>

    <figure className="time-atlas" aria-label={`Accounted time, ${rangeLabel}`} aria-busy={queries.some(query => query.isPending)}>
      <div className="time-toolbar">
        <div className="time-year-block">
          <div className="time-year-controls">
            <h2>{year}</h2>
            <div>
              <button onClick={() => changeYear(year - 1)} disabled={oldest.year <= 2000} aria-label="Previous year"><ChevronLeft size={15} /></button>
              <button onClick={() => changeYear(year + 1)} disabled={year >= currentYear} aria-label="Next year"><ChevronRight size={15} /></button>
              {year !== currentYear && <button onClick={() => changeYear(currentYear)} aria-label="Return to this year" title="This year"><RotateCcw size={13} /></button>}
            </div>
          </div>
          <p className="time-window-range">{rangeLabel}</p>
          <p className="time-year-total">{unavailable ? (isError ? 'Time unavailable' : 'Reading your time…') : total > 0 ? `${timeLabel(total)} accounted for${[...days.values()].some(day => day.liveMinutes > 0) ? ' · including live' : ''}` : 'No time recorded in these months yet.'}</p>
        </div>
        <div className="time-readout" aria-live="polite" aria-atomic="true">
          {activeDate && !unavailable ? <>
            <span className="time-readout-date">{new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${activeDate}T12:00:00Z`))}{activeDate === today ? ' · Today' : ''}</span>
            <strong>{activeDate > today ? 'Ahead of you' : timeLabel(activeDay?.minutes ?? 0)}</strong>
            <span>{activeDay?.liveMinutes > 0 ? <><i className="time-live-dot" />Timer running</> : activeDay?.calendarMinutes ? `${timeLabel(activeDay.calendarMinutes)} from calendar` : activeDay?.sessions ? `${activeDay.sessions} ${activeDay.sessions === 1 ? 'session' : 'sessions'}` : activeDate > today ? 'An open day' : 'Quiet, or simply off the clock'}</span>
          </> : <span className="time-readout-hint">Select a day to look closer.</span>}
        </div>
      </div>

      {!!detailDay?.details?.length && <details className="time-day-details">
        <summary><span>Day breakdown</span>{detailDate && <span>{new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${detailDate}T12:00:00Z`))}</span>}<ChevronDown size={12} aria-hidden="true" /></summary>
        <ul aria-label={detailDate ? `Time breakdown for ${fullDate(detailDate)}` : 'Time breakdown'}>
          {detailDay.details.map(row => <li key={row.key}>
            <div className="time-detail-name"><strong>{row.title}</strong><span>{row.source === 'calendar'
              ? [row.taskTitle, row.goalTitle].filter(Boolean).join(' · ') || 'Miscellaneous'
              : row.goalTitle || (row.taskId ? 'Task' : 'Miscellaneous')}</span></div>
            <div className="time-detail-value"><strong>{timeLabel(row.minutes)}</strong><span>{row.source === 'calendar' ? 'Calendar' : 'Work'}</span></div>
          </li>)}
        </ul>
        <p>Calendar fills elapsed time not already logged. Overlapping blocks share the same time.</p>
      </details>}

      {(isError || cloud.error) && <div className="time-error" role="status">
        <span>{isError ? (!unavailable ? 'Showing the last saved view. New time could not be loaded.' : 'Your time could not be loaded.') : 'Live timer sync is reconnecting.'}</span>
        {isError && <button onClick={() => { for (const query of queries) if (query.isError) void query.refetch(); }}>Retry</button>}
      </div>}

      <p className="time-swipe-hint">Swipe to see all three months</p>
      <div className="time-months-viewport">
        <div className={`time-months${unavailable ? ' time-months-loading' : ''}`}>
        {months.map(({ name, cells, key: monthKey, year: monthYear }) => {
          const firstDay = `${monthKey}-01`;
          const tabDate = focused?.startsWith(monthKey) ? focused : today.startsWith(monthKey) ? today : firstDay;
          const monthTotal = cells.reduce((sum, date) => sum + (date ? days.get(date)?.minutes ?? 0 : 0), 0);
          return <div className="time-month" key={monthKey} role="group" aria-label={`${name} ${monthYear}`} data-month={monthKey} data-current={today.startsWith(monthKey) || undefined}>
            <div className="time-month-heading"><h3>{name}{monthYear !== year && <small>{monthYear}</small>}</h3><span>{monthTotal > 0 ? timeLabel(monthTotal) : ''}</span></div>
            <div className="time-month-body">
              <div className="time-weekdays" aria-hidden="true">{WEEKDAYS.map((day, i) => <span key={i}>{i % 2 === 0 ? day : ''}</span>)}</div>
              <div className="time-month-grid">
                {cells.map((date, slot) => {
                  if (!date) return <span key={slot} aria-hidden="true" />;
                  const day = days.get(date);
                  const future = date > today;
                  const label = `${fullDate(date)}: ${unavailable ? 'Time unavailable' : future ? 'Future day' : timeLabel(day?.minutes ?? 0)}${day?.liveMinutes > 0 ? ', timer running' : ''}`;
                  return <button key={date} ref={node => { if (node) buttons.current.set(date, node); else buttons.current.delete(date); }}
                    className="time-day" data-date={date} data-level={unavailable ? 0 : timeLevel(day?.minutes ?? 0)} data-future={future || undefined}
                    data-today={date === today || undefined} data-selected={selected === date || undefined} data-live={day?.liveMinutes > 0 || undefined}
                    aria-label={label} aria-pressed={selected === date} aria-current={date === today ? 'date' : undefined}
                    title={label} tabIndex={date === tabDate ? 0 : -1}
                    onKeyDown={event => move(event, date)}
                    onFocus={() => { setFocused(date); setSelected(date); }} onClick={() => setSelected(date)}
                    onPointerEnter={event => { if (event.pointerType === 'mouse') setHovered(date); }} onPointerLeave={() => setHovered(null)}
                  ><span aria-hidden="true" /></button>;
                })}
              </div>
            </div>
          </div>;
        })}
        </div>
      </div>

      <figcaption className="time-caption">
        <p>Work + elapsed calendar time.<span> Future hours stay planned.</span></p>
        <div className="time-legend" aria-label="Time intensity: no time, under 1 hour, 1–2 hours, 2–4 hours, 4–6 hours, 6 hours or more">
          <span>Less</span>{[0, 1, 2, 3, 4, 5].map(level => <i key={level} data-level={level} title={['No time logged', 'Under 1h', '1–2h', '2–4h', '4–6h', '6h+'][level]} />)}<span>6h+</span>
        </div>
      </figcaption>
    </figure>
  </section>;
}
