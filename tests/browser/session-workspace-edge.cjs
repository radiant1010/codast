const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const origin=process.env.WORK_ITEM_TEST_URL||'http://127.0.0.1:8778',project='edge-'+Date.now();
 async function api(path,method='GET',data){const r=await fetch(origin+'/api'+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const result=await r.json();assert.ok(r.ok,JSON.stringify(result));return result;}
 await api('/projects','POST',{name:project});await api('/onboarding','PUT',{deferred:true});
 const plain=await api('/projects/'+project+'/tasks','POST',{task:'일반 기록 세션'});
 const target=await api('/projects/'+project+'/tasks','POST',{task:'목표 세션'});
 await api('/projects/'+project+'/work-items','POST',{chat_id:target.id,title:'목표 세션',goal:'목표 근거',done_criteria:'결과 확인'});
 const run=await api('/projects/'+project+'/chat','POST',{chat_id:plain.id,text:'일반 세션의 고유 지시',client:'mock',action:'run'});
 for(let i=0;i<50;i++){if((await api('/projects/'+project+'/runs/'+run.run_id)).status!=='running')break;await new Promise(r=>setTimeout(r,100));}
 const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
 try{
  page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await page.locator('#startup-loading').waitFor({state:'hidden'});await page.selectOption('#project',project);
  const dashboard=page.locator('#session-dashboard-page');await dashboard.getByRole('button',{name:'일반 기록 세션 채팅 열기',exact:true}).click();
  await page.locator('#text').waitFor({state:'visible'});await page.waitForFunction(()=>!chatLoading);
  await page.getByRole('tab',{name:'작업 기록',exact:true}).click();await page.locator('.session-run-record').waitFor();
  await page.locator('#open-dashboard').click();await dashboard.getByRole('button',{name:'목표 세션 채팅 열기',exact:true}).click();await page.locator('#text').waitFor({state:'visible'});
  await page.getByRole('tab',{name:'작업 기록',exact:true}).click();await page.locator('#session-work-panel .work-items-embedded').waitFor();
  assert.equal(await page.locator('#session-work-panel .session-run-record').count(),0,'another chat history must be removed');
  await page.locator('#open-dashboard').click();
  let release,arrived;const gate=new Promise(r=>release=r),requested=new Promise(r=>arrived=r);let held=false;
  await page.route('**/messages?**',async route=>{if(!held&&route.request().url().includes(plain.id)){held=true;arrived();await gate;}await route.continue();});
  await dashboard.getByRole('button',{name:'일반 기록 세션 채팅 열기',exact:true}).click();await requested;
  await page.locator('#open-dashboard').click();await dashboard.waitFor({state:'visible'});release();await page.waitForFunction(()=>!chatLoading);
  assert.equal(new URL(page.url()).hash,'#dashboard','late response must not undo navigation');await page.unroute('**/messages?**');
  await dashboard.getByRole('button',{name:'목표 세션 채팅 열기',exact:true}).click();await page.locator('#text').waitFor({state:'visible'});
  await page.getByRole('tab',{name:'작업 기록',exact:true}).click();await page.locator('#session-work-panel .work-items-embedded').waitFor();
  await page.route('**/work-items',route=>route.abort('failed'));await page.reload();await page.locator('#startup-loading').waitFor({state:'hidden'});
  await page.locator('.session-current-goal').filter({hasText:'목표 상태를 불러오지 못했습니다.'}).waitFor({timeout:5000});
  assert.equal(await page.locator('#session-work-panel .session-run-record').count(),0);
  await page.locator('#session-work-panel').getByRole('button',{name:'다시 불러오기',exact:true}).waitFor();
  assert.deepEqual(errors,[]);console.log('PASS cross-chat history isolation, delayed navigation, failed goal lookup');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
