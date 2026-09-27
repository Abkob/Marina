import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { useSchedulePrefs } from '../api/hooks';
import { useCloudWorkTimer } from '../hooks/useCloudWorkTimer';
import { apiFetch } from '../utils/apiFetch';
import { addRoutineDays } from '../utils/routines';
import { mergeLiveTime, timeDate, timeLabel, timeLevel, timeMonth, type TimeHeatmap, type TimeDay } from '../utils/timeHeatmap';
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
  const year = chosenYear ?? currentYear;
  const query = useQuery({
    queryKey: ['work-sessions', 'heatmap', year],
    queryFn: ({ signal }) => apiFetch<TimeHeatmap>(`/api/work-sessions/heatmap?year=${year}`, { signal, cache: 'no-store' }),
    refetchInterval: 30_000,
    refetchOnWindowFocus: 'always',
    staleTime: 10_000,
  });
  const today = query.data ? timeDate(cloud.nowMs, query.data.timezone) : fallbackToday;
  const days = useMemo(() => query.data ? mergeLiveTime(query.data, cloud.timer, cloud.nowMs) : new Map<string, TimeDay & { liveMinutes: number }>(), [query.data, cloud.timer, cloud.nowMs]);
  const months = useMemo(() => MONTHS.map((name, month) => ({ name, cells: timeMonth(year, month) })), [year]);
  const total = [...days.values()].reduce((sum, day) => sum + day.minutes, 0);
  const activeDate = hovered ?? selected ?? (year === currentYear ? today : null);
  const activeDay = activeDate ? days.get(activeDate) : null;
  const unavailable = !query.data;

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

    <figure className="time-atlas" aria-label={`Work time in ${year}`} aria-busy={query.isPending}>
      <div className="time-toolbar">
        <div className="time-year-block">
          <div className="time-year-controls">
            <h2>{year}</h2>
            <div>
              <button onClick={() => changeYear(year - 1)} disabled={year <= 2000} aria-label="Previous year"><ChevronLeft size={15} /></button>
              <button onClick={() => changeYear(year + 1)} disabled={year >= currentYear} aria-label="Next year"><ChevronRight size={15} /></button>
              {year !== currentYear && <button onClick={() => changeYear(currentYear)} aria-label="Return to this year" title="This year"><RotateCcw size={13} /></button>}
            </div>
          </div>
          <p className="time-year-total">{unavailable ? (query.isError ? 'Time unavailable' : 'Reading your time…') : total > 0 ? `${timeLabel(total)} of recorded focus${[...days.values()].some(day => day.liveMinutes > 0) ? ' · including live' : ''}` : 'No time logged this year yet.'}</p>
        </div>
        <div className="time-readout" aria-live="polite" aria-atomic="true">
          {activeDate && !unavailable ? <>
            <span className="time-readout-date">{new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${activeDate}T12:00:00Z`))}{activeDate === today ? ' · Today' : ''}</span>
            <strong>{activeDate > today ? 'Ahead of you' : timeLabel(activeDay?.minutes ?? 0)}</strong>
            <span>{activeDay?.liveMinutes > 0 ? <><i className="time-live-dot" />Timer running</> : activeDay?.sessions ? `${activeDay.sessions} ${activeDay.sessions === 1 ? 'session' : 'sessions'}` : activeDate > today ? 'An open day' : 'Quiet, or simply off the clock'}</span>
          </> : <span className="time-readout-hint">Select a day to look closer.</span>}
        </div>
      </div>

      {(query.isError || cloud.error) && <div className="time-error" role="status">
        <span>{query.isError ? (query.data ? 'Showing the last saved view. New time could not be loaded.' : 'Your time could not be loaded.') : 'Live timer sync is reconnecting.'}</span>
        {query.isError && <button onClick={() => void query.refetch()}>Retry</button>}
      </div>}

      <div className={`time-months${unavailable ? ' time-months-loading' : ''}`}>
        {months.map(({ name, cells }, month) => {
          const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
          const firstDay = `${monthKey}-01`;
          const tabDate = focused?.startsWith(monthKey) ? focused : today.startsWith(monthKey) ? today : firstDay;
          const monthTotal = cells.reduce((sum, date) => sum + (date ? days.get(date)?.minutes ?? 0 : 0), 0);
          return <div className="time-month" key={name} role="group" aria-label={name}>
            <div className="time-month-heading"><h3>{name}</h3><span>{monthTotal > 0 ? timeLabel(monthTotal) : ''}</span></div>
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

      <figcaption className="time-caption">
        <p>One square, one day.<span> Pale squares mean no logged time.</span></p>
        <div className="time-legend" aria-label="Focus intensity: no time, under 1 hour, 1–2 hours, 2–4 hours, 4–6 hours, 6 hours or more">
          <span>Less</span>{[0, 1, 2, 3, 4, 5].map(level => <i key={level} data-level={level} title={['No time logged', 'Under 1h', '1–2h', '2–4h', '4–6h', '6h+'][level]} />)}<span>6h+</span>
        </div>
      </figcaption>
    </figure>
  </section>;
}
