const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
 const origin=process.env.WORK_ITEM_TEST_URL||'http://127.0.0.1:8778',project='states-'+Date.now(),output=process.env.WORK_ITEM_SCREENSHOTS;
 async function api(path,method='GET',data){const r=await fetch(origin+'/api'+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;}
 await api('/projects','POST',{name:project});await api('/onboarding','PUT',{deferred:true});
 const b='/projects/'+project,chat={},longName='아주 긴 세션 이름이 목록에서 한 줄로 말줄임 처리되는지 확인하기 위한 가상 테스트 채팅';
 for(const name of ['새 채팅','실행 후 대기 채팅','실행 중 채팅','보류 채팅','완료 채팅','두 AI 비교 채팅','외부 실행 채팅','목표 연결 채팅',longName])chat[name]=await api(b+'/tasks','POST',{task:name});
 const run=(name,client)=>api(b+'/commands','POST',{text:'가상 작업',task:name,chat_id:chat[name].id,client});
 for(const [name,client] of [['실행 후 대기 채팅','codex'],['두 AI 비교 채팅','codex'],['두 AI 비교 채팅','claude'],['보류 채팅','codex'],['완료 채팅','claude']])await run(name,client);
 await api(b+'/tasks','PATCH',{task:'보류 채팅',status:'paused'});await api(b+'/tasks','PATCH',{task:'완료 채팅',status:'done'});
 await api(b+'/work-items','POST',{chat_id:chat['목표 연결 채팅'].id,title:'목표 연결 채팅',goal:'입력 검사를 확인한다.',done_criteria:'정상과 빈 입력 확인'});
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];
 try{
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/#dashboard');await page.locator('#startup-loading').waitFor({state:'hidden'});await page.selectOption('#project',project);
  const table=page.locator('.session-workspace-table'),cells=name=>table.locator('tbody tr',{hasText:name}).evaluate(tr=>[...tr.children].map(td=>td.textContent));
  await page.waitForFunction(()=>{const body=document.querySelector('.session-workspace-table tbody')?.textContent||'';return body.includes('외부 실행 채팅')&&!body.includes('확인 중');});
  assert.deepEqual(await table.locator('th').allTextContents(),['세션명','현재 상태','진행 단계','AI 종류','컨텍스트']);
  assert.deepEqual((await cells('외부 실행 채팅')).slice(1),['시작 전','—','미지정','—']);
  // A run started outside this tab must show up through polling, without a reload.
  await run('외부 실행 채팅','codex');
  await page.waitForFunction(()=>[...document.querySelectorAll('.session-workspace-table tbody tr')].some(tr=>tr.textContent.startsWith('외부 실행 채팅')&&tr.children[1].textContent==='대기 중'),null,{timeout:12000});
  assert.equal((await cells('외부 실행 채팅'))[3],'Codex');
  // Live run and per-AI context go through the app's own entry point; real polls are held back so they cannot replace them mid-check.
  await page.evaluate(()=>{const workspace=window.sessionWorkspace,apply=workspace.metricsChanged.bind(workspace);workspace.applyVirtualMetrics=apply;workspace.metricsChanged=()=>{};});
  const inject=active=>page.evaluate(({ids,active})=>{const usage=(used,size)=>({used_tokens:used,window_tokens:size,observed_at:new Date().toISOString()});
   window.sessionWorkspace.applyVirtualMetrics([
    {chat_id:ids.multi,client:'codex',execution_model:'virtual-codex',context_usage:usage(16000,100000),input_tokens:50000,output_tokens:2000,runs:1,input_reports:1,output_reports:1},
    {chat_id:ids.multi,client:'claude',execution_model:'virtual-claude',context_usage:usage(16000,200000),runs:1},
    {chat_id:ids.idle,client:'codex',context_usage:usage(16000,100000),input_tokens:900000,output_tokens:1000,runs:1,input_reports:1,output_reports:1},
    {chat_id:ids.held,client:'codex',runs:1},{chat_id:ids.done,client:'claude',runs:1},
   ],active?[{id:'virtual-run',cancellable:true,adapter:'codex',command:{chat_id:ids.live,client:'codex'}}]:[]);
  },{active,ids:{multi:chat['두 AI 비교 채팅'].id,idle:chat['실행 후 대기 채팅'].id,live:chat['실행 중 채팅'].id,held:chat['보류 채팅'].id,done:chat['완료 채팅'].id}});
  await inject(true);
  const expected={'새 채팅':['시작 전','—','미지정','—'],'실행 후 대기 채팅':['대기 중','—','Codex','16%'],'실행 중 채팅':['진행 중','—','Codex','—'],
   '보류 채팅':['보류','—','Codex','—'],'완료 채팅':['완료','—','Claude','—'],'두 AI 비교 채팅':['대기 중','—','CodexClaude','Codex 16% / Claude 8%']};
  for(const [name,values] of Object.entries(expected))assert.deepEqual((await cells(name)).slice(1),values,name);
  const goal=await cells('목표 연결 채팅');assert.equal(goal[1],'시작 전');assert.notEqual(goal[2],'—');
  const tones=await table.locator('tbody td:nth-child(2) .work-item-badge').evaluateAll(nodes=>Object.fromEntries(nodes.map(n=>[n.textContent,n.dataset.tone])));
  assert.deepEqual(tones,{'진행 중':'running','완료':'done','보류':'paused','대기 중':'neutral','시작 전':'neutral'});
  assert.deepEqual(await table.locator('[data-client]').evaluateAll(nodes=>[...new Set(nodes.map(n=>n.dataset.client))].sort()),['claude','codex']);
  const heights=await table.locator('tbody tr').evaluateAll(rows=>rows.map(row=>row.getBoundingClientRect().height));
  assert.ok(Math.max(...heights)<60,'desktop rows stay on one line: '+heights);
  const long=table.getByRole('button',{name:longName+' 채팅 열기'});
  assert.equal(await long.evaluate(node=>node.scrollWidth>node.clientWidth),true,'long title is truncated');assert.equal(await long.getAttribute('title'),longName);
  if(output){fs.mkdirSync(output,{recursive:true});await page.screenshot({path:output+'/session-states.png',fullPage:true});}
  await page.setViewportSize({width:390,height:900});
  const dashboard=page.locator('#session-dashboard-page');assert.equal(await dashboard.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true,'390px overflow');
  assert.ok(await table.locator('tbody tr',{hasText:'두 AI 비교 채팅'}).evaluate(row=>row.getBoundingClientRect().height>60),'narrow rows use the card layout');
  if(output)await page.screenshot({path:output+'/session-states-mobile.png',fullPage:true});
  await page.setViewportSize({width:1280,height:800});
  await table.getByRole('button',{name:'두 AI 비교 채팅 채팅 열기',exact:true}).click();await page.getByRole('tab',{name:'세션 정보',exact:true}).click();await inject(false);
  const info=page.locator('#session-info-panel');await info.getByText('virtual-claude',{exact:true}).waitFor();
  const text=await info.textContent();for(const value of ['상태 설명','다음 지시 대기','진행 단계','실행 방식','virtual-codex','52,000','16.0%','8.0%'])assert.ok(text.includes(value),value);
  assert.deepEqual(errors,[]);console.log('PASS session list states, external run polling, badges, context per AI, one-line desktop rows, 390px cards and session details');
 }finally{if(errors.length)console.error('Page errors:',errors);await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
