import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), entries: vi.fn() }));
vi.mock('../../../server/services/routines', () => ({ listRoutines: mocks.list, listRoutineEntries: mocks.entries, isRoutinesSchemaMissing: (error: {code?: string}) => error.code === '42P01' }));
import { loadRoutineReservations } from '../../../server/services/routinePlanning';
beforeEach(() => { vi.clearAllMocks(); mocks.list.mockResolvedValue([]); mocks.entries.mockResolvedValue([]); });
describe('routine planning loader', () => {
  it('loads complete boundary weeks for partial calendar views', async () => {
    await loadRoutineReservations('2026-09-23', '2026-09-30', '2026-09-22');
    expect(mocks.entries).toHaveBeenCalledWith('2026-09-21', '2026-10-04');
  });
  it('allows deployment staging before additive schema exists', async () => {
    mocks.list.mockRejectedValue({ code: '42P01' });
    expect(await loadRoutineReservations('2026-09-22', '2026-09-28', '2026-09-22')).toEqual([]);
  });
  it('does not hide real database failures as zero routine workload', async () => {
    mocks.list.mockRejectedValue(new Error('Database unreachable'));
    await expect(loadRoutineReservations('2026-09-22', '2026-09-28', '2026-09-22')).rejects.toThrow('Database unreachable');
  });
});
