// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeekTimeGrid } from '../WeekTimeGrid';

afterEach(cleanup);
describe('routine calendar markers', () => {
  it('packs short routine markers side by side instead of covering one another', () => {
    const select = vi.fn();
    render(<WeekTimeGrid days={['2026-09-21']} events={[]} meetings={[]} linksByEvent={new Map()} workStart={9} workEnd={18} workDays={[1]}
      renderAllDayCell={() => null} onSlotClick={vi.fn()} onEventClick={vi.fn()} onEventMove={vi.fn()} onEventResize={vi.fn()} onDaySelect={select}
      routines={[
        { routine_id: 'a', title: 'Recall', date: '2026-09-21', minutes: 5, preferred_time: '09:00' },
        { routine_id: 'b', title: 'Practice', date: '2026-09-21', minutes: 5, preferred_time: '09:05' },
      ]} />);
    const first = screen.getByRole('button', { name: 'Routine Recall at 09:00' });
    const second = screen.getByRole('button', { name: 'Routine Practice at 09:05' });
    expect(first.style.width).toBe('calc(50% - 4px)');
    expect(second.style.left).not.toBe(first.style.left);
    fireEvent.click(second);
    expect(select).toHaveBeenCalledWith('2026-09-21');
    expect(screen.getByText('10m routines')).toBeInTheDocument();
  });
});
