import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(()=>({folder:vi.fn(),token:vi.fn(),root:vi.fn(),import:vi.fn(),sync:vi.fn(),get:vi.fn(),list:vi.fn()}));
vi.mock('../../../server/services/googleDrive.js',()=>({resourceDriveFolder:mocks.folder,driveToken:mocks.token,driveRootGuard:mocks.root,importDriveFile:mocks.import,syncDriveResource:mocks.sync}));
vi.mock('../../../server/services/googleDriveClient.js',async original=>({...await original<typeof import('../../../server/services/googleDriveClient.js')>(),getDriveFile:mocks.get,listDriveFiles:mocks.list}));
import { scanResourceDirectory } from '../../../server/services/driveDirectoryScan';
const folder = (id:string,parents:string[]=[],task=false)=>({id,name:id,mimeType:'application/vnd.google-apps.folder',parents,...(task?{appProperties:{marinaEntityType:'task',marinaEntityId:id}}:{})});
beforeEach(()=>{
  vi.resetAllMocks(); mocks.token.mockResolvedValue('synthetic'); mocks.root.mockResolvedValue(async()=>[]);
  mocks.folder.mockResolvedValue({folder_id:'selected',folder_url:'https://drive.google.com/drive/folders/selected',path:[]});
  mocks.get.mockImplementation(async (_token,id)=>id==='selected'?folder(id):id==='child'?folder(id,['selected'],true):folder(id));
  mocks.list.mockResolvedValue({files:[]}); mocks.import.mockResolvedValue({id:'resource'}); mocks.sync.mockResolvedValue(undefined);
});
describe('bounded directory ingestion for a selected context',()=>{
  it('imports only the current page, then returns a resumable cursor',async()=>{
    mocks.list.mockResolvedValue({files:[{id:'doc',name:'Notes.txt',mimeType:'text/plain',size:'15',version:'1'}],nextPageToken:'page-two'});
    const result=await scanResourceDirectory({attach_to_id:'task',attach_to_type:'task'},false);
    expect(result.checked).toBe(1); expect(mocks.import).toHaveBeenCalledWith('doc',{attach_to_id:'task',attach_to_type:'task'});
    expect(mocks.list).toHaveBeenCalledWith('synthetic','','selected',undefined,10);
    expect(JSON.parse(Buffer.from(result.next_cursor!,'base64url').toString())).toEqual([{folder:'selected',page:'page-two'}]);
  });
  it('does not descend into subtask folders unless explicitly selected',async()=>{
    mocks.list.mockResolvedValue({files:[folder('child',['selected'],true)]});
    expect((await scanResourceDirectory({attach_to_id:'task',attach_to_type:'task'},false)).next_cursor).toBeNull();
    expect((await scanResourceDirectory({attach_to_id:'task',attach_to_type:'task'},true)).next_cursor).not.toBeNull();
    expect((await scanResourceDirectory({attach_to_id:'goal',attach_to_type:'goal'},false)).next_cursor).not.toBeNull();
  });
  it.each(['outside','child'])('rejects a cursor tampered to traverse %s outside the task-only boundary',async id=>{
    const cursor=Buffer.from(JSON.stringify([{folder:id}])).toString('base64url');
    await expect(scanResourceDirectory({attach_to_id:'task',attach_to_type:'task'},false,cursor)).rejects.toMatchObject({status:403});
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.import).not.toHaveBeenCalled();
  });
  it('reports individual import failures without claiming everything indexed',async()=>{
    mocks.list.mockResolvedValue({files:[{id:'doc',name:'Notes.txt',mimeType:'text/plain',size:'15',version:'1'}]});
    mocks.import.mockRejectedValue(new Error('synthetic failure'));
    expect(await scanResourceDirectory({},false)).toMatchObject({checked:0,errors:['Notes.txt']});
  });
});
