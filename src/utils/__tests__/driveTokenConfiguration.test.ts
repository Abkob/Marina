import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({query:vi.fn(),config:vi.fn(),refresh:vi.fn()}));
vi.mock('../../../server/db',()=>({query:mocks.query,transaction:vi.fn()}));
vi.mock('../../../server/services/googleWorkspaceAuth',async()=>({...await vi.importActual<any>('../../../server/services/googleWorkspaceAuth'),googleConfiguration:mocks.config,refreshGoogleAccessToken:mocks.refresh}));
import {driveToken} from '../../../server/services/googleDrive';
beforeEach(()=>{mocks.query.mockReset();mocks.config.mockReset();mocks.refresh.mockReset();});
describe('Drive maintenance configuration boundaries',()=>{
 it('does not mutate the real connection warning when a maintenance process lacks configuration',async()=>{
  mocks.config.mockReturnValue({configured:false});await expect(driveToken()).rejects.toMatchObject({status:503});
  expect(mocks.query).not.toHaveBeenCalled();expect(mocks.refresh).not.toHaveBeenCalled();
 });
 it('clears only the same connection refresh warning after a verified provider success',async()=>{
  mocks.config.mockReturnValue({configured:true});mocks.refresh.mockResolvedValue('access-token');
  mocks.query.mockImplementation(async sql=>sql.includes('to_regclass')?{rows:[{connection:1,files:1,states:1,uploads:1}]}:sql.startsWith('SELECT account_id')?{rows:[{encrypted_refresh_token:'connection-A'}]}:{rows:[]});
  expect(await driveToken()).toBe('access-token');
  expect(mocks.query).toHaveBeenLastCalledWith(expect.stringContaining("AND encrypted_refresh_token=$1 AND last_error=$2"),['connection-A','Google Drive access could not be refreshed. Reconnect the same Google account.']);
 });
 it('retains a genuine refresh failure as a visible warning without exposing provider details',async()=>{
  mocks.config.mockReturnValue({configured:true});mocks.refresh.mockRejectedValue(new Error('private provider details'));
  mocks.query.mockImplementation(async sql=>sql.includes('to_regclass')?{rows:[{connection:1,files:1,states:1,uploads:1}]}:sql.startsWith('SELECT account_id')?{rows:[{encrypted_refresh_token:'connection-B'}]}:{rows:[]});
  await expect(driveToken()).rejects.toMatchObject({message:'Google Drive access could not be refreshed. Reconnect the same Google account.',status:503});
  expect(mocks.query).toHaveBeenLastCalledWith(expect.stringContaining('SET last_error=$1'),['Google Drive access could not be refreshed. Reconnect the same Google account.']);
 });
});
