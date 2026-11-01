const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const origin=process.env.WORK_ITEM_TEST_URL||'http://127.0.0.1:8778',project='detach-'+Date.now();
 async function api(path,method='GET',data){const r=await fetch(origin+'/api'+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;}
 await api('/projects','POST',{name:project});await api('/onboarding','PUT',{deferred:true});
 const chat=await api('/projects/'+project+'/tasks','POST',{task:'목표 채팅'});
 await api('/projects/'+project+'/work-items','POST',{chat_id:chat.id,title:'목표 채팅',goal:'가상 목표를 확인한다.',done_criteria:'가상 조건 확인'});
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
 try{
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);await page.locator('#startup-loading').waitFor({state:'hidden'});await page.selectOption('#project',project);
  await page.locator('#session-dashboard-page').getByRole('button',{name:'목표 채팅 채팅 열기',exact:true}).waitFor();
  const screen=page.locator('#work-items-page'),table=screen.locator('table.work-items-table');
  await page.evaluate(()=>{location.hash='#work-items';});await table.getByRole('link',{name:'목표 채팅',exact:true}).waitFor();
  // Repeated detach calls (project ready, chat selection, hash changes) must not blank a list that is already shown.
  const removed=await page.evaluate(async()=>{let count=0;const observer=new MutationObserver(records=>{for(const r of records)for(const n of r.removedNodes)if(n.nodeName==='TABLE'||n.querySelector?.('table'))count++;});
   observer.observe(document.getElementById('work-items-page'),{childList:true,subtree:true});
   for(let i=0;i<3;i++)window.workItems.attachToChat(null);
   await new Promise(resolve=>setTimeout(resolve,800));observer.disconnect();return count;});
  assert.equal(removed,0,'detached list was cleared');
  assert.deepEqual(await screen.getByRole('columnheader').allTextContents(),['작업 제목','현재 상태','작업 단계','AI','실행 방식']);
  // Attaching to a goal chat and coming back still shows the list.
  await page.evaluate(id=>{location.hash='#chat/'+id+'/history';},chat.id);
  await page.locator('#session-work-panel #work-items-page').getByRole('heading',{name:'작업 기록',exact:true}).waitFor();
  await page.evaluate(()=>{location.hash='#work-items';});await table.getByRole('link',{name:'목표 채팅',exact:true}).waitFor();
  assert.equal(await page.locator('#session-work-panel #work-items-page').count(),0);
  await page.locator('#open-dashboard').click();await page.locator('#session-dashboard-page').waitFor();
  await page.evaluate(()=>{location.hash='#work-items';});await table.getByRole('link',{name:'목표 채팅',exact:true}).waitFor();
  assert.deepEqual(errors,[]);console.log('PASS detached work item list stays rendered, goal chat history attach and return');
 }finally{if(errors.length)console.error('Page errors:',errors);await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
