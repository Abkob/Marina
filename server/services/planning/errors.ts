import type { PlanErrorCode } from '../../../shared/planningState.js';
export class PlanningError extends Error {
  constructor(public code: PlanErrorCode, message: string, public status = 409, public retryable = false) { super(message); }
}
