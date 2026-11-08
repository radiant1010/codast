// #8 P-2 acceptance: Claude work plan pinned above the chat input, fed by GET /plan and live `plan` run events.
// Run: NODE_PATH="$APPDATA/npm/node_modules" node tests/browser/plan-panel.cjs
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');

// Chat ids must be lowercase hex: the app's #chat/<id> route only accepts [a-f0-9]{32}.
const id=letter=>letter.repeat(32);
const CHATS={b:'로그인 버그',c:'실패한 작업',d:'Codex 작업',e:'짧은 질문',f:'열린 항목',a:'많은 작업'};
const item=(i,subject,status,extra={})=>({id:String(i),subject,activeForm:extra.activeForm??null,status,thisRun:extra.thisRun??true});
const PLANS={
 b1:{agent:'claude',run:{id:'run-b',status:'running'},items:[item(2,'원인 찾기','completed'),item(3,'수정 적용','in_progress',{activeForm:'수정 적용하는 중'}),item(4,'전체 검사 실행','pending',{activeForm:'전체 검사 실행하는 중',thisRun:false})],earlierCompleted:[{id:'1',subject:'요구사항 확인'}],endedWithOpenItems:false},
 b2:{agent:'claude',run:{id:'run-b',status:'running'},items:[item(2,'원인 찾기','completed'),item(3,'수정 적용','completed'),item(4,'전체 검사 실행','in_progress',{activeForm:'전체 검사 실행하는 중'})],earlierCompleted:[{id:'1',subject:'요구사항 확인'}],endedWithOpenItems:false},
 c:{agent:'claude',run:{id:'run-c',status:'failed'},items:[item(1,'설정 읽기','completed'),item(2,'설정 고치기','in_progress',{activeForm:'설정 고치는 중'})],earlierCompleted:[],endedWithOpenItems:true},
 d:{agent:'codex',run:{id:'run-d',status:'running'},items:[],earlierCompleted:[],endedWithOpenItems:false},
 e:{agent:'claude',run:{id:'run-e',status:'completed'},items:[],earlierCompleted:[{id:'1',subject:'지난 작업'}],endedWithOpenItems:false},
 f:{agent:'claude',run:{id:'run-f',status:'completed'},items:[item(1,'문서 쓰기','completed'),item(2,'문서 검토','pending',{activeForm:'문서 검토하는 중'})],earlierCompleted:[],endedWithOpenItems:true},
 a:{agent:'claude',run:{id:'run-a',status:'running'},items:Array.from({length:30},(_,i)=>item(i+1,'작업 '+(i+1),i<10?'completed':i===10?'in_progress':'pending')),earlierCompleted:[],endedWithOpenItems:false},
};
const RUN_STATUS={b:'running',c:'failed',d:'running',e:'completed',f:'completed',a:'running'};
const ADAPTER={d:'codex'};
const planRow=JSON.stringify({op:'update',session:'session-a',id:'4',status:'in_progress'});

function routes(page,state){
 return page.route('http://harness.test/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname;
  if(path==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync('app/web/templates/index.html','utf8')});
  if(path.startsWith('/static/'))return route.fulfill({contentType:path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':path.endsWith('.woff2')?'font/woff2':'application/javascript',body:fs.readFileSync('app/web'+path)});
  const chat=url.searchParams.get('chat_id');
  if(path==='/api/projects/sample/plan'){
   const key=Object.keys(CHATS).find(k=>id(k)===chat);
   state.planCalls.push({chat:key,afterEvents:state.sse});
   if(state.delay[key])await new Promise(resolve=>setTimeout(resolve,state.delay[key]));
   if(!key)return route.fulfill({status:404,json:{detail:'채팅을 찾을 수 없습니다.'}});
   return route.fulfill({json:key==='b'?(state.sse?PLANS.b2:PLANS.b1):PLANS[key]});
  }
  const events=path.match(/^\/api\/projects\/sample\/runs\/run-([a-f])\/events$/);
  if(events){
   const rows=[{seq:1,kind:'status',text:'Claude, init'}];
   if(events[1]==='b'){rows.push({seq:2,kind:'tool',text:'TaskUpdate {"taskId": "4", "status": "in_progress"}'},{seq:3,kind:'plan',text:planRow});state.sse=true;}
   // retry keeps EventSource from reconnecting during the test; no `end`, so only the plan row can trigger the refetch.
   return route.fulfill({contentType:'text/event-stream',body:'retry: 600000\n\n'+rows.map(row=>'event: run_event\ndata: '+JSON.stringify({run_id:'run-'+events[1],created_at:'2026-11-08T08:00:00Z',...row})+'\n\n').join('')});
  }
  if(path==='/api/projects/sample/messages'){
   const key=Object.keys(CHATS).find(k=>id(k)===chat)||'b';
   return route.fulfill({json:{messages:[{id:1,task:CHATS[key],text:CHATS[key]+' 요청',created_at:'2026-11-08T08:00:00Z',run_id:'run-'+key,status:RUN_STATUS[key],adapter:ADAPTER[key]||'claude',output:RUN_STATUS[key]==='running'?'':'끝났습니다.',error:RUN_STATUS[key]==='failed'?'실행 실패':null,cancellable:true,metadata:{}}]}});
  }
  const replies={
   '/api/onboarding':{status:'deferred',project:'sample'},'/api/projects':{projects:['sample']},
   '/api/clients':{clients:[]},'/api/clients/codex/status':{state:'available',models:[],limits:[]},'/api/clients/claude/status':{state:'available',models:[],limits:[]},
   '/api/notifications':{events:[],cursor:0,has_more:false},'/api/session-overview':{sessions:[],running:[],usage:[]},
   '/api/projects/sample/settings':{client:'claude',mode:'read-only',cwd:'.',context_paths:[]},'/api/projects/sample/workspace':{path:'C:/fixture/sample'},
   '/api/projects/sample/tasks':{tasks:Object.entries(CHATS).map(([k,task])=>({task,id:id(k),status:'active',count:1}))},
   '/api/projects/sample/runs':{runs:[]},'/api/projects/sample/questions':{messages:[]},'/api/projects/sample/rules':{rules:[]},
   '/api/projects/sample/materials':{materials:[]},'/api/projects/sample/guard':{level:'strong',privacy_mode:'replace',fields:[]},
   '/api/projects/sample/work-items':{items:[]},
   '/api/projects/sample/environment':{git:{state:'available',branch:'main'},ports:{values:[]},docker:{state:'available',containers:[]}},
  };
  return route.fulfill({json:replies[path]||{}});
 });
}

async function open(page){
 const state={sse:false,planCalls:[],delay:{}},errors=[],external=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{if(!request.url().startsWith('http://harness.test/'))external.push(request.url());});
 await routes(page,state);
 await page.goto('http://harness.test/');await page.locator('#startup-loading').waitFor({state:'hidden'});
 return {state,errors,external};
}
const go=(page,key)=>page.evaluate(hash=>{location.hash=hash;},'#chat/'+id(key));
const until=async(page,check,message,tries=80)=>{for(let i=0;i<tries&&!(await check());i++)await page.waitForTimeout(50);assert.ok(await check(),message);};

(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 try{
  // Desktop.
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const {state,errors,external}=await open(page);
  const panel=page.locator('section#plan-panel'),composer=page.locator('#composer');
  const text=async()=>(await panel.textContent())||'';
  await go(page,'b');
  await panel.waitFor();
  assert.equal(await panel.getAttribute('aria-label'),'작업 계획');
  assert.equal(await page.evaluate(()=>document.querySelector('#plan-panel').nextElementSibling?.id),'composer','the plan sits right above the input');

  // A live `plan` run event (no `end`) makes the panel ask the server again.
  await until(page,async()=>(await text()).includes('전체 검사 실행하는 중'),'plan row triggers a refetch and the new active task is shown');
  assert.ok(state.planCalls.some(call=>call.chat==='b'&&call.afterEvents),'GET /plan after the plan row');
  const rows=panel.getByRole('listitem');
  assert.equal(await rows.count(),3);
  const rowText=await rows.allTextContents();
  assert.match(rowText[0],/완료/);assert.match(rowText[0],/원인 찾기/);
  assert.match(rowText[2],/진행 중/);assert.match(rowText[2],/전체 검사 실행하는 중/);
  assert.match(await text(),/완료 2 \/ 전체 3/);
  assert.doesNotMatch(await text(),/%/,'no percentage');
  const log=await page.locator('#messages').textContent();
  assert.match(log,/TaskUpdate/,'the raw tool line stays in the run log');
  assert.doesNotMatch(log,/"op":/,'plan rows are not drawn in the run log');

  // Earlier completed items are folded.
  const earlier=panel.getByRole('button',{name:/^이전 완료 1개/});
  assert.equal(await earlier.getAttribute('aria-expanded'),'false');
  assert.equal(await panel.getByText('요구사항 확인').isVisible(),false);
  await earlier.click();
  assert.equal(await earlier.getAttribute('aria-expanded'),'true');
  assert.equal(await panel.getByText('요구사항 확인').isVisible(),true);

  // Collapse and expand the whole plan.
  await panel.getByRole('button',{name:'접기',exact:true}).click();
  const expand=panel.getByRole('button',{name:'펼치기',exact:true});
  assert.equal(await expand.getAttribute('aria-expanded'),'false');
  assert.equal(await rows.first().isVisible(),false);
  await expand.click();
  assert.equal(await panel.getByRole('button',{name:'접기',exact:true}).getAttribute('aria-expanded'),'true');

  // Failed run: last reported state with a notice; the previous chat's plan is gone.
  await go(page,'c');
  await until(page,async()=>(await text()).includes('설정 고치는 중'),'failed chat plan');
  assert.match(await text(),/실행이 중단되었습니다\. Claude가 마지막으로 보고한 상태입니다\./);
  assert.doesNotMatch(await text(),/전체 검사 실행하는 중/);

  // Finished with open items.
  await go(page,'f');
  await until(page,async()=>(await text()).includes('문서 검토'),'open items chat plan');
  assert.match(await text(),/실행이 끝났지만 Claude가 완료로 표시하지 않은 항목이 있습니다\./);

  // Codex running: one line, no list.
  await go(page,'d');
  await until(page,async()=>(await text()).includes('Codex는 작업 계획을 보내지 않습니다.'),'codex notice');
  assert.equal(await rows.count(),0);

  // No current items (only earlier completed): hidden.
  await go(page,'e');
  await until(page,async()=>!(await panel.isVisible()),'panel hidden when there are no current items');

  // A late answer for a chat the user already left is dropped.
  state.delay.c=600;
  await go(page,'c');await page.waitForTimeout(50);await go(page,'e');
  await page.waitForTimeout(1000);
  assert.equal(await panel.isVisible(),false,'late plan of the previous chat must not appear');
  state.delay.c=0;

  // Many items: the panel stays within 30% of the height and scrolls inside.
  await go(page,'a');
  await until(page,async()=>(await text()).includes('작업 30'),'long plan');
  const box=await panel.boundingBox(),view=page.viewportSize();
  assert.ok(box.height<=view.height*0.3+2,'panel height '+box.height+' within 30vh');
  const composerBox=await composer.boundingBox();
  assert.ok(box.y+box.height<=composerBox.y+1,'panel does not cover the input');

  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);

  // Phone width in a fresh context: collapsed one-line summary, input visible, no sideways scroll.
  const phone=await browser.newPage({viewport:{width:390,height:844}});
  const narrow=await open(phone);
  const small=phone.locator('section#plan-panel');
  await go(phone,'b');
  await until(phone,async()=>((await small.textContent())||'').includes('전체 검사 실행하는 중'),'narrow summary after the plan row');
  const summary=(await small.textContent())||'';
  assert.match(summary,/작업 계획 2\/3, 진행 중: 전체 검사 실행하는 중/);
  assert.equal(await small.getByRole('listitem').first().isVisible(),false,'collapsed by default on a phone');
  assert.equal(await phone.locator('#text').isVisible(),true);
  const smallBox=await small.boundingBox(),inputBox=await phone.locator('#composer').boundingBox();
  assert.ok(smallBox.y+smallBox.height<=inputBox.y+1,'summary does not cover the input');
  assert.ok(await phone.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth),'no horizontal scroll');
  await small.getByRole('button',{name:'펼치기',exact:true}).click();
  const openBox=await small.boundingBox();
  assert.ok(openBox.height<=844*0.4+2,'expanded plan within 40vh on a phone');
  assert.deepEqual(narrow.external,[]);assert.deepEqual(narrow.errors,[]);
  console.log('PASS: plan pinned above input, live refetch, log without plan rows, folding, notices, chat switch, height, phone summary');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
