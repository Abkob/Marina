// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SchedulerResult, ScheduleTaskInfo } from '../../../api/hooks';
import type { DBTask } from '../../../db/schema';
import { buildWorkloadHorizonModel, WorkloadHorizon } from '../WorkloadHorizon';

const tasks = [
  { id: 'root', title: 'Courses', parent_task_id: null, position: 0 },
  { id: 'parent', title: 'Physics 210', parent_task_id: 'root', position: 0 },
  { id: 'overdue', title: 'Finish studying', parent_task_id: 'parent', position: 0 },
  { id: 'miss', title: 'Complete exam questions', parent_task_id: 'root', position: 1 },
  { id: 'unknown', title: 'Watch lecture videos', parent_task_id: 'parent', position: 2 },
] as DBTask[];

const taskLookup: Record<string, ScheduleTaskInfo> = {
  overdue: {
    title: 'Finish studying', goal_id: 'goal', goal_title: 'University', priority: 'high',
    estimated_minutes: 600, logged_minutes: 120, committed_minutes: 300, remaining_minutes: 180,
    start_date: '2026-08-01', due_date: '2026-08-17', start_date_source: null, due_date_source: null,
  },
  miss: {
    title: 'Complete exam questions', goal_id: 'goal', goal_title: 'University', priority: 'high',
    estimated_minutes: 300, logged_minutes: 0, committed_minutes: 0, remaining_minutes: 300,
    start_date: '2026-08-18', due_date: '2026-08-20', start_date_source: null, due_date_source: null,
  },
  unknown: {
    title: 'Watch lecture videos', goal_id: 'goal', goal_title: 'University', priority: 'medium',
    estimated_minutes: 0, logged_minutes: 0, committed_minutes: 0, remaining_minutes: 0,
    start_date: null, due_date: '2026-08-21', start_date_source: null, due_date_source: null,
  },
};

const scheduler: SchedulerResult = {
  status: 'impossible', total_available_minutes: 1800, total_required_minutes: 480, gap_minutes: 1320,
  tasks_fit: [], tasks_overflow: ['overdue', 'miss'], unestimated_task_ids: ['unknown'], cycle_task_ids: [],
  day_assignments: [],
  capacity_days: [
    { date: '2026-08-18', available_minutes: 600, used_minutes: 120, task_ids: ['overdue'], task_minutes: { overdue: 120 } },
    { date: '2026-08-19', available_minutes: 600, used_minutes: 60, task_ids: ['overdue'], task_minutes: { overdue: 60 } },
    { date: '2026-08-20', available_minutes: 600, used_minutes: 240, task_ids: ['miss'], task_minutes: { miss: 240 } },
  ],
  task_diagnostics: [
    { task_id: 'overdue', outcome: 'overflow', required_minutes: 180, due_date: '2026-08-17', earliest_date: '2026-08-18', available_before_deadline_minutes: 0, allocated_minutes: 0, shortfall_minutes: 180, recovery_allocated_minutes: 180, recovery_finish_date: '2026-08-19', unscheduled_minutes: 0, days: [] },
    { task_id: 'miss', outcome: 'overflow', required_minutes: 300, due_date: '2026-08-20', earliest_date: '2026-08-18', available_before_deadline_minutes: 240, allocated_minutes: 240, shortfall_minutes: 60, recovery_allocated_minutes: 240, recovery_finish_date: null, unscheduled_minutes: 60, days: [] },
    { task_id: 'unknown', outcome: 'unestimated', required_minutes: 0, due_date: '2026-08-21', earliest_date: '2026-08-18', available_before_deadline_minutes: 0, allocated_minutes: 0, shortfall_minutes: 0, recovery_allocated_minutes: 0, recovery_finish_date: null, unscheduled_minutes: 0, days: [] },
  ],
};

describe('WorkloadHorizon', () => {
  it('compresses estimate, completed work, calendar commitments, recovery, and shortfall without double-counting parents', () => {
    const model = buildWorkloadHorizonModel({
      scheduler, taskLookup, allTasks: tasks,
      rangeStart: '2026-08-18', rangeEnd: '2026-08-24', today: '2026-08-18', mode: 'week',
    });

    expect(model.estimateMinutes).toBe(900);
    expect(model.loggedMinutes).toBe(120);
    expect(model.committedMinutes).toBe(300);
    expect(model.creditedLoggedMinutes).toBe(120);
    expect(model.creditedCommittedMinutes).toBe(300);
    expect(model.commitmentOverageMinutes).toBe(0);
    expect(model.remainingMinutes).toBe(480);
    expect(model.plannedMinutes).toBe(420);
    expect(model.remainingAfterRangeMinutes).toBe(60);
    expect(model.overdueCount).toBe(1);
    expect(model.overdueMinutes).toBe(180);
    expect(model.missedCount).toBe(1);
    expect(model.shortfallMinutes).toBe(60);
    expect(model.unestimatedCount).toBe(1);
    expect(model.tasks[0].path).toBe('Courses › Physics 210 › Finish studying');
  });

  it('caps calendar credit at the task estimate so extra calendar time cannot make remaining work negative', () => {
    const overcommittedScheduler: SchedulerResult = {
      ...scheduler,
      total_required_minutes: 0,
      tasks_fit: ['overdue'],
      tasks_overflow: [],
      unestimated_task_ids: [],
      capacity_days: [],
      task_diagnostics: [{
        task_id: 'overdue', outcome: 'fit', required_minutes: 0, due_date: '2026-08-24',
        earliest_date: '2026-08-18', available_before_deadline_minutes: 0, allocated_minutes: 0,
        shortfall_minutes: 0, recovery_allocated_minutes: 0, recovery_finish_date: null,
        unscheduled_minutes: 0, days: [],
      }],
    };
    const overcommittedLookup: Record<string, ScheduleTaskInfo> = {
      overdue: {
        ...taskLookup.overdue,
        estimated_minutes: 600,
        logged_minutes: 0,
        committed_minutes: 900,
        remaining_minutes: 0,
      },
    };

    const model = buildWorkloadHorizonModel({
      scheduler: overcommittedScheduler,
      taskLookup: overcommittedLookup,
      allTasks: tasks,
      rangeStart: '2026-08-18',
      rangeEnd: '2026-08-24',
      today: '2026-08-18',
      mode: 'week',
    });

    expect(model.creditedCommittedMinutes).toBe(600);
    expect(model.commitmentOverageMinutes).toBe(300);
    expect(model.tasks[0].remaining).toBe(0);
  });

  it('explains why later spare time does not repair an earlier deadline', () => {
    render(<WorkloadHorizon
      scheduler={scheduler}
      taskLookup={taskLookup}
      allTasks={tasks}
      rangeStart="2026-08-18"
      rangeEnd="2026-08-24"
      today="2026-08-18"
      mode="week"
      onOpenAudit={vi.fn()}
    />);

    const explanationToggle = screen.getByRole('button', { name: 'Show schedule explanation' });
    expect(explanationToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/later hours cannot repair an earlier deadline/i)).not.toBeInTheDocument();

    fireEvent.click(explanationToggle);

    expect(screen.getByRole('button', { name: 'Hide schedule explanation' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('How Marina calculated this')).toBeInTheDocument();
    expect(screen.getByText(/later hours cannot repair an earlier deadline/i)).toBeInTheDocument();
    expect(screen.getByText(/old date stays red, but the work is carried/i)).toBeInTheDocument();
    expect(screen.getByText(/Courses › Physics 210 › Finish studying/)).toBeInTheDocument();
    expect(screen.getByText(/10h estimate − 2h worked − 5h calendar credit =/)).toHaveTextContent('3h left');
  });
});
