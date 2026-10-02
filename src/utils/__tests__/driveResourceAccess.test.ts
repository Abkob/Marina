import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({guard:vi.fn(),token:vi.fn()}));
vi.mock('../../../server/services/googleDrive.js',()=>({driveToken:mocks.token,driveRootGuard:async()=>mocks.guard}));
import { filterRootedDriveRows } from '../../../server/services/driveResourceAccess';
beforeEach(()=>{vi.resetAllMocks();mocks.token.mockResolvedValue('synthetic');mocks.guard.mockResolvedValue([]);});
describe('retrieval source ancestry authorization',()=>{
  it('checks unique Drive files and preserves local evidence',async()=>{
    const rows=[{file_id:'a'},{file_id:'a'},{file_id:null},{file_id:'b'}];
    expect(await filterRootedDriveRows(rows)).toEqual(rows);
    expect(mocks.guard).toHaveBeenCalledTimes(2);
  });
  it('excludes outside-root evidence before returning model candidates',async()=>{
    mocks.guard.mockImplementation(async id=>{if(id==='outside')throw Object.assign(new Error('outside'),{status:403});return[];});
    expect(await filterRootedDriveRows([{file_id:'outside'},{file_id:'inside'}])).toEqual([{file_id:'inside'}]);
  });
  it('reports provider outages instead of pretending the scoped library is empty',async()=>{
    mocks.guard.mockRejectedValue(Object.assign(new Error('busy'),{status:503}));
    await expect(filterRootedDriveRows([{file_id:'a'}])).rejects.toMatchObject({status:503});
  });
});
