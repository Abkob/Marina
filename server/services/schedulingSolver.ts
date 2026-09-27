import { computeSchedule, type SchedulerInput, type SchedulerResult } from './scheduler.js';

export interface SchedulingSolver {
  readonly name: string;
  solve(input: SchedulerInput): Promise<SchedulerResult>;
}

/** Current verified in-process solver. It keeps the LLM outside scheduling
 * math and gives us a stable adapter to replace with CP-SAT/OR-Tools. */
export class DeterministicSchedulingSolver implements SchedulingSolver {
  readonly name = 'deterministic-constraint-v1';
  async solve(input: SchedulerInput): Promise<SchedulerResult> {
    return computeSchedule(input);
  }
}

export const schedulingSolver: SchedulingSolver = new DeterministicSchedulingSolver();
