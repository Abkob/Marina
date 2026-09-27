// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobalSearch } from '../Header';

const mocks = vi.hoisted(() => ({ work: vi.fn(), tab: vi.fn(), goal: vi.fn(), focus: vi.fn() }));
vi.mock('../../store/useAppStore', () => ({ useAppStore: () => ({ setWorkTaskId: mocks.work, setCurrentTab: mocks.tab, navigateToGoal: mocks.goal, setFocusedTaskId: mocks.focus }) }));
vi.mock('../../api/hooks', () => ({
  useAllTasks: () => ({ data: [
    { id: 'physics', title: 'Physics' }, { id: 'biology', title: 'Biology' },
    { id: 'a', title: 'Review notes', parent_task_id: 'physics', goal_id: 'course' },
    { id: 'b', title: 'Review notes', parent_task_id: 'biology', goal_id: 'course' },
  ] }),
  useGoals: () => ({ data: [{ id: 'course', title: 'Courses' }] }),
  useOrgInbox: () => ({ data: null }),
  useSearch: (query: string) => ({ data: { results: query ? [
    { entity_type: 'task', entity_id: 'a', title: 'Review notes', goal_id: 'course' },
    { entity_type: 'task', entity_id: 'b', title: 'Review notes', goal_id: 'course' },
    { entity_type: 'task', entity_id: 'standalone', title: 'Call the library', goal_id: null },
  ] : [] } }),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('search task context', () => {
  it('distinguishes matching task titles and opens the right task', async () => {
    render(<GlobalSearch mobile />);
    fireEvent.change(screen.getByLabelText('Search everything'), { target: { value: 'notes' } });
    const result = await screen.findByRole('option', { name: /Physics · Courses/ });
    expect(result).toHaveTextContent('Review notes');
    expect(screen.getByRole('option', { name: /Biology · Courses/ })).toHaveTextContent('Review notes');
    fireEvent.click(result);
    expect(mocks.goal).toHaveBeenCalledWith('course');
    expect(mocks.focus).toHaveBeenCalledWith('a');
  });
  it('opens standalone tasks in Work rather than leaving a search result without a destination', async () => {
    render(<GlobalSearch mobile />);
    fireEvent.change(screen.getByLabelText('Search everything'), { target: { value: 'library' } });
    fireEvent.click(await screen.findByRole('option', { name: /Call the library/ }));
    expect(mocks.work).toHaveBeenCalledWith('standalone');
    expect(mocks.tab).toHaveBeenCalledWith('Work');
  });
});
