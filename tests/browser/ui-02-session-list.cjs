const {chromium}=require('playwright');
const assert=require('node:assert/strict');
// CODAST-UI-02: full-width session list with status filters and 10-row pages.
(async()=>{
 const origin=process.env.WORK_ITEM_TEST_URL||'http://127.0.0.1:8778',project='list-ui-'+Date.now();
 async function api(path,method='GET',data){const r=await fetch(origin+'/api'+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;}
 await api('/onboarding','PUT',{deferred:true});await api('/projects','POST',{name:project});
 const b='/projects/'+project,names=[];
 for(let i=1;i<=12;i++){const name='목록 채팅 '+String(i).padStart(2,'0');names.push(name);await api(b+'/tasks','POST',{task:name});}
 const chats=(await api(b+'/tasks')).tasks,id=name=>chats.find(c=>c.task===name).id;
 for(const name of names.slice(0,4))await api(b+'/commands','POST',{text:'가상 작업',task:name,chat_id:id(name),client:'codex'});
 await api(b+'/tasks','PATCH',{task:names[4],status:'paused'});await api(b+'/tasks','PATCH',{task:names[5],status:'done'});
 // Expected: 4 idle (대기 중), 1 paused (확인 필요 group), 1 done, 6 not started.
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
 try{
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/#dashboard');await page.locator('#startup-loading').waitFor({state:'hidden'});await page.selectOption('#project',project);
  const screen=page.locator('#session-dashboard-page');
  await screen.getByRole('heading',{level:1,name:'세션',exact:true}).waitFor();
  for(const tab of ['AI 세션','계정 사용량','실행환경'])assert.equal(await screen.getByRole('tab',{name:tab,exact:true}).count(),0,'tab removed: '+tab);
  assert.equal(await screen.getByText(/^\d+개 세션$/).count(),0,'count line removed');
  const filters=screen.getByRole('group',{name:'상태별 보기'});
  await page.waitForFunction(()=>!document.querySelector('#session-dashboard-page')?.textContent.includes('확인 중'));
  const count=async label=>Number((await filters.getByRole('button',{name:new RegExp('^'+label+' \\d+$')}).textContent()).match(/\d+/)[0]);
  const expected={'전체':12,'진행 중':0,'확인 필요':1,'대기 중':4,'시작 전':6,'완료':1};
  for(const [label,value] of Object.entries(expected))assert.equal(await count(label),value,label);
  assert.equal(expected['진행 중']+expected['확인 필요']+expected['대기 중']+expected['시작 전']+expected['완료'],expected['전체']);
  const all=filters.getByRole('button',{name:/^전체 \d+$/});assert.equal(await all.getAttribute('aria-pressed'),'true');
  const rows=screen.locator('tbody tr');assert.equal(await rows.count(),10,'first page holds 10 rows');
  await screen.getByText('1–10 / 12',{exact:true}).waitFor();
  await screen.getByRole('button',{name:'다음 페이지',exact:true}).click();
  await screen.getByText('11–12 / 12',{exact:true}).waitFor();assert.equal(await rows.count(),2);
  const notStarted=filters.getByRole('button',{name:/^시작 전 \d+$/});await notStarted.click();
  assert.equal(await notStarted.getAttribute('aria-pressed'),'true');assert.equal(await all.getAttribute('aria-pressed'),'false');
  await screen.getByText('1–6 / 6',{exact:true}).waitFor();
  const statuses=await rows.locator('td:nth-child(2)').allTextContents();assert.deepEqual([...new Set(statuses)],['시작 전'],'filter keeps only not-started rows');
  await filters.getByRole('button',{name:/^확인 필요 \d+$/}).click();
  assert.deepEqual(await rows.locator('td:nth-child(2)').allTextContents(),['보류']);
  await all.click();await screen.getByText('1–10 / 12',{exact:true}).waitFor();
  await screen.getByRole('button',{name:'새 작업',exact:true}).click();
  await page.getByLabel('새 채팅 이름',{exact:true}).waitFor();await page.keyboard.press('Escape');
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
  assert.equal(await screen.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true,'390px overflow');
  assert.deepEqual(errors,[]);console.log('PASS UI-02 session list without tabs, status filter counts, 10-row pages, filter reset, new task dialog, 390px');
 }finally{if(errors.length)console.error('Page errors:',errors);await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
