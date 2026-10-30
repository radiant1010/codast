const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
 const origin=process.env.WORK_ITEM_TEST_URL||'http://127.0.0.1:8778',project='sessions-'+Date.now();
 async function api(path,method='GET',data){const response=await fetch(origin+'/api'+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;}
 await api('/projects','POST',{name:project});await api('/onboarding','PUT',{deferred:true});
 const first=await api('/projects/'+project+'/tasks','POST',{task:'첫 채팅'});
 const second=await api('/projects/'+project+'/tasks','POST',{task:'두 번째 채팅'});
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
 try{
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);await page.locator('#startup-loading').waitFor({state:'hidden'});
  await page.selectOption('#project',project);
  await page.locator('#open-dashboard').click({timeout:3000});
  const dashboard=page.locator('#session-dashboard-page');
  for(const tab of ['AI 세션','계정 사용량','실행환경']){await dashboard.getByRole('tab',{name:tab,exact:true}).click();await dashboard.locator('[role=tab][aria-selected=true]').filter({hasText:tab}).waitFor();}
  await dashboard.getByRole('tab',{name:'AI 세션',exact:true}).click();
  await dashboard.getByRole('button',{name:'첫 채팅 채팅 열기',exact:true}).click();
  await dashboard.waitFor({state:'hidden'});await page.locator('#text').fill('첫 채팅의 초안');
  await page.locator('#open-dashboard').click();await dashboard.getByRole('button',{name:'두 번째 채팅 채팅 열기',exact:true}).click();
  assert.equal(await page.locator('#text').inputValue(),'');await page.locator('#text').fill('두 번째 초안');
  await page.locator('#open-dashboard').click();await dashboard.getByRole('button',{name:'첫 채팅 채팅 열기',exact:true}).click();
  assert.equal(await page.locator('#text').inputValue(),'첫 채팅의 초안');
  await page.getByRole('tab',{name:'세션 정보',exact:true}).click();
  await page.getByLabel('현재 목표',{exact:true}).fill('입력 예외를 확인한다.');
  await page.getByLabel('완료 조건',{exact:true}).fill('정상 입력과 빈 입력을 확인한다.');
  await page.getByRole('button',{name:'이 세션에 목표 연결',exact:true}).click();
  await page.getByText('목표를 연결했습니다.',{exact:true}).waitFor();
  await page.getByRole('tab',{name:'대화',exact:true}).click();await page.locator('#text').fill('입력 예외를 조사해줘');
  await page.locator('#send').click();
  await page.locator('#messages .message').first().waitFor();
  await page.getByRole('tab',{name:'작업 기록',exact:true}).click();
  await page.locator('#session-work-panel').getByRole('heading',{name:'완료 조건 확인',exact:true}).waitFor();
  const goal=(await api('/projects/'+project+'/work-items')).items[0];assert.equal(goal.chat_id,first.id);
  const work=page.locator('#session-work-panel');await work.getByLabel('판단',{exact:true}).selectOption('passed');
  await work.getByLabel('확인 근거',{exact:true}).fill('정상 입력과 빈 입력의 테스트 결과를 확인했다.');
  await work.getByLabel('완료 조건을 모두 확인했습니다.').check();await work.getByRole('button',{name:'확인 결과 저장',exact:true}).click();
  await work.locator('[data-state=done]').waitFor();
  await page.reload();await page.locator('#startup-loading').waitFor({state:'hidden'});
  await page.getByRole('tab',{name:'작업 기록',exact:true}).waitFor();assert.equal(await page.getByRole('tab',{name:'작업 기록',exact:true}).getAttribute('aria-selected'),'true');
  await page.getByRole('tab',{name:'대화',exact:true}).click();
  await page.locator('#text').fill('재실행 전에 남기는 초안');
  await page.locator('#open-dashboard').click();await dashboard.getByRole('button',{name:'첫 채팅 채팅 열기',exact:true}).click();
  assert.equal(await page.locator('#text').inputValue(),'재실행 전에 남기는 초안');
  const output=process.env.WORK_ITEM_SCREENSHOTS;if(output){fs.mkdirSync(output,{recursive:true});await page.locator('#text').waitFor({state:'visible'});await page.screenshot({path:output+'/session-chat.png'});}
  await page.locator('#open-dashboard').click();await dashboard.waitFor({state:'visible'});if(output)await page.screenshot({path:output+'/session-dashboard.png'});
  for(const width of [900,390]){await page.setViewportSize({width,height:900});for(const tab of ['AI 세션','계정 사용량','실행환경']){await dashboard.getByRole('tab',{name:tab,exact:true}).click();assert.equal(await dashboard.evaluate(n=>n.scrollWidth<=n.clientWidth+1),true,tab+' overflow '+width);}}
  await dashboard.getByRole('tab',{name:'AI 세션',exact:true}).click();if(output)await page.screenshot({path:output+'/session-dashboard-mobile.png'});
  await dashboard.getByRole('button',{name:'첫 채팅 채팅 열기',exact:true}).click();await page.locator('#text').waitFor({state:'visible'});
  assert.equal(await page.locator('#console').evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);
  if(output)await page.screenshot({path:output+'/session-chat-mobile.png'});
  await page.setViewportSize({width:1280,height:900});
  await page.locator('.new-chat').click();await page.getByLabel('새 채팅 이름',{exact:true}).fill('실행 전 새 채팅');
  await page.getByRole('button',{name:'새 채팅 만들기',exact:true}).click();
  await page.locator('#chat-title').filter({hasText:'실행 전 새 채팅'}).waitFor();await page.locator('#text').waitFor({state:'visible'});
  const newChat=(await api('/projects/'+project+'/tasks')).tasks.find(chat=>chat.task==='실행 전 새 채팅');
  await page.waitForURL('**/#chat/'+newChat.id);
  await page.locator('#open-dashboard').click();await dashboard.getByRole('button',{name:'실행 전 새 채팅 채팅 열기',exact:true}).waitFor();
  const other=project+'-other';await api('/projects','POST',{name:other});
  await page.evaluate(()=>projects(document.getElementById('project').value));await page.selectOption('#project',other);
  await dashboard.getByText('아직 채팅이 없습니다. 새 채팅을 만들어 시작하세요.',{exact:true}).waitFor();
  assert.equal(await dashboard.getByRole('button',{name:'첫 채팅 채팅 열기',exact:true}).count(),0);
  assert.deepEqual(errors,[]);console.log('PASS dashboard tabs, session navigation, per-chat drafts, goal attachment, chat execution, verification, reload and 390px layout');
 }finally{if(errors.length)console.error('Page errors:',errors);await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
