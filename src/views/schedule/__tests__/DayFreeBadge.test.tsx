// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DayFreeBadge, type DayCapacityBreakdown } from '../WeekTimeGrid';

const breakdown: DayCapacityBreakdown = {
  date: '2026-07-27',
  capacityMinutes: 480,
  bookedMinutes: 120,
  freeMinutes: 360,
  items: [{ label: 'Free focus time', minutes: 360, tone: 'free' }],
};

describe('DayFreeBadge', () => {
  it('shows only while hovered and closes when the pointer leaves', async () => {
    const user = userEvent.setup();
    render(<DayFreeBadge breakdown={breakdown} />);
    const button = screen.getByRole('button', { name: /show day capacity breakdown/i });

    await user.hover(button);
    expect(screen.getByText('Day hours')).toBeInTheDocument();

    await user.unhover(button);
    expect(screen.queryByText('Day hours')).not.toBeInTheDocument();
  });

  it('does not pin the popover when clicked', async () => {
    const user = userEvent.setup();
    render(<DayFreeBadge breakdown={breakdown} />);
    const button = screen.getByRole('button', { name: /show day capacity breakdown/i });

    await user.click(button);
    expect(screen.queryByText('Day hours')).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });
});
