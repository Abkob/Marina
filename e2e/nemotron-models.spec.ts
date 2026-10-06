import {test,expect} from '@playwright/test';
import {NEMOTRON_CHAT_MODELS,NEMOTRON_SUPER_MODEL,NEMOTRON_ULTRA_MODEL} from '../server/config/nemotronChat';
import {modelRoleCatalog} from '../server/services/copilotModelRoles';
import {NEMOTRON_EMBED_MODEL} from '../shared/embeddingTrial';
for(const savedModel of ['gemini-3.8-flash',NEMOTRON_ULTRA_MODEL]){
 test(`Nemotron-only picker and saved ${savedModel} conversation remain usable`,async({page,isMobile},info)=>{
  const session='00000000-0000-4000-8000-000000000123';const errors:string[]=[];const unexpected:string[]=[];const sent:unknown[]=[];let trials=0;
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(({session})=>localStorage.setItem('marina-os-ui-v1',JSON.stringify({version:0,state:{currentTab:'Copilot',copilotActiveSessionId:session,copilotMessages:[]}})),{session});
  await page.route('**/api/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   let body:unknown;
   if(path==='/api/auth/status')body={required:false,configured:true,authenticated:true};
   else if(path==='/api/health/ready')body={models:{primary:{model:NEMOTRON_SUPER_MODEL,status:'cloud'},available:NEMOTRON_CHAT_MODELS.map(model=>({model,provider:'nvidia',status:'cloud'}))}};
   else if(path===`/api/ai/sessions/${session}/messages`)body=[{id:'old-reply',role:'assistant',content:'Historical conversation is preserved.',created_at:'2026-10-05T10:00:00Z',metadata:{model:savedModel,actions:[]}}];
   else if(path===`/api/ai/sessions/${session}/chat`&&request.method()==='POST'){sent.push(request.postDataJSON());body={reply:'Synthetic continuation received.',actions:[]};}
   else if(path==='/api/ai/model-roles'){const catalog=modelRoleCatalog();body={...catalog,embeddings:{...catalog.embeddings,model:NEMOTRON_EMBED_MODEL,label:'Nemotron 3 Embed 1B',trials:catalog.embeddings.trials.map(row=>({...row,configured:true}))}};}
   else if(path==='/api/ai/embedding-models/trial'&&request.method()==='POST'){
    expect(request.postDataJSON()).toEqual({model:NEMOTRON_EMBED_MODEL});trials++;
    if(trials===2){await route.fulfill({status:503,json:{error:'Synthetic provider unavailable'}});return;}
    body={model:NEMOTRON_EMBED_MODEL,dimension:2048,correct_top_matches:2,total_queries:3,elapsed_ms:1087,sample_only:true,index_changed:false};
   }
   else if(path==='/api/work-timer')body={timer:null,serverNow:new Date().toISOString()};
   else if(request.method()==='GET')body=[];
   else{unexpected.push(`${request.method()} ${path}`);await route.abort();return;}
   await route.fulfill({json:body});
  });
  await page.goto('/',{waitUntil:'domcontentloaded'});
  if(isMobile){await page.getByRole('button',{name:'Open all pages'}).click();await page.getByRole('button',{name:'Open Copilot',exact:true}).click();}
  await expect(page.getByText('Historical conversation is preserved.',{exact:true})).toBeVisible();
  const settings=page.getByRole('button',{name:'Chat model and tools'});await settings.click();
  const picker=page.getByRole('combobox',{name:'Chat & reasoning'});await expect(picker).toBeVisible();
  await expect(picker.locator('option')).toHaveCount(3);
  expect(await picker.locator('option').evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value))).toEqual([...NEMOTRON_CHAT_MODELS]);
  const expected=savedModel===NEMOTRON_ULTRA_MODEL?NEMOTRON_ULTRA_MODEL:NEMOTRON_SUPER_MODEL;
  await expect(picker).toHaveValue(expected);
  // Measure after the modal's scale animation reaches its usable layout.
  await expect.poll(async()=> (await picker.boundingBox())?.height??0).toBeGreaterThanOrEqual(44);
  if(isMobile){await picker.tap();await picker.selectOption(expected);}else{await picker.focus();await expect(picker).toBeFocused();}
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await expect(page.getByText(/Search index: Nemotron 3 Embed 1B/)).toBeVisible();
  const summary=page.getByText('Try a search model',{exact:true});await summary.scrollIntoViewIfNeeded();
  if(isMobile)await summary.tap();else{await summary.focus();await page.keyboard.press('Enter');}
  const trialPicker=page.getByRole('combobox',{name:'Sample search model'});await expect(trialPicker).toBeVisible();
  await expect(trialPicker).toHaveValue(NEMOTRON_EMBED_MODEL);
  const trialButton=page.getByRole('button',{name:'Try sample search',exact:true});await trialButton.scrollIntoViewIfNeeded();
  await expect.poll(async()=>(await trialButton.boundingBox())?.height??0).toBeGreaterThanOrEqual(44);
  if(isMobile)await trialButton.tap();else{await trialButton.focus();await page.keyboard.press('Enter');}
  await expect(page.getByText(/Correct source matches: 2\/3/)).toBeVisible();
  await expect(page.getByText(/library search index stays unchanged/)).toBeVisible();
  await expect(picker).toHaveValue(expected);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:`tmp/nemotron-browser/${info.project.name}-${savedModel===NEMOTRON_ULTRA_MODEL?'supported':'retired'}.png`,fullPage:true});
  await trialButton.click();await expect(page.getByRole('alert').filter({hasText:'sample search could not finish'})).toBeVisible();expect(trials).toBe(2);
  await page.getByRole('button',{name:'Close chat panel',exact:true}).click();
  await page.getByRole('textbox',{name:'Message Copilot'}).fill('Continue our conversation.');await page.getByRole('button',{name:'Send message'}).click();
  await expect(page.getByText('Synthetic continuation received.',{exact:true})).toBeVisible();
  expect(sent).toHaveLength(1);expect(sent[0]).toMatchObject({model:expected});expect(unexpected).toEqual([]);expect(errors).toEqual([]);
 });
}
