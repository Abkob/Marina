import { expect, it } from 'vitest';
// Only selected by PLANNING_NEGATIVE_CONTROL=1. The runner must observe failure.
it('P00.2-S01 deliberate failure proves the runner propagates failed assertions', () => { expect(1).toBe(2); });
