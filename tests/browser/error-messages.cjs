const fs=require('node:fs'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 const page=await browser.newPage({viewport:{width:1200,height:850}}),errors=[];
 const cliRaw='{"type":"turn.failed","error":{"code":"auth_failed","message":"Authentication failed"}}';
 const cliMessage='Codex: 인증에 실패했습니다. 설정의 CLI 연결에서 계정을 확인하고 다시 로그인하세요.';
 const validation={detail:[{type:'string_too_long',loc:['query','filename'],msg:'String should have at most 255 characters',ctx:{max_length:255}}]};
 const workflows=['sequential','parallel'].map(kind=>({id:kind,kind,title:kind==='parallel'?'가상 병렬 작업':'가상 순차 작업',status:'done',steps:[],current:0,fixed_at:'2026-10-25',source:{title:'가상 입력',version:1,identity:'fixture',sha256:'a'.repeat(64),content:'가상 승인 내용'}}));
 let failure={status:500,contentType:'text/plain',body:'Internal Server Error'};
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('http://localhost/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(path==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync('app/web/templates/index.html','utf8')});
  if(path.startsWith('/static/'))return route.fulfill({contentType:path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':path.endsWith('.woff2')?'font/woff2':'application/javascript',body:fs.readFileSync('app/web'+path)});
  if(path==='/api/projects/sample/settings'&&request.method()==='PUT')return route.fulfill(failure);
  if(['/api/projects/sample/materials','/api/projects/sample/material-preparations'].includes(path)&&request.method()==='POST')return route.fulfill({status:422,json:validation});
  if(path.endsWith('/export'))return route.fulfill(failure);
  if(path.endsWith('/events'))return route.fulfill({contentType:'text/event-stream',body:'event: end\ndata: {}\n\n'});
  const replies={
   '/api/projects':{projects:['sample']},'/api/onboarding':{status:'deferred'},'/api/notifications':{events:[],cursor:0,has_more:false},'/api/clients':{clients:[]},
   '/api/session-overview':{sessions:[],running:[],usage:[]},'/api/clients/codex/status':{state:'available',models:[],limits:[]},
   '/api/projects/sample/settings':{client:'codex',mode:'read-only',cwd:'.',context_paths:[]},'/api/projects/sample/workspace':{path:'C:/fixture/sample'},
   '/api/projects/sample/tasks':{tasks:[{task:'가상 오류 확인',id:'a'.repeat(32),count:1,status:'active'}]},
   '/api/projects/sample/messages':{messages:[{id:1,task:'가상 오류 확인',text:'가상 오류 확인',created_at:'2026-10-25T00:00:00Z',run_id:'fixture-error',status:'failed',adapter:'codex',output:'',error:cliMessage,metadata:{error_detail:cliRaw}}]},
   '/api/projects/sample/runs':{runs:[]},'/api/projects/sample/questions':{messages:[]},'/api/projects/sample/rules':{rules:[]},'/api/projects/sample/materials':{materials:[]},
   '/api/projects/sample/guard':{level:'strong',privacy_mode:'replace',fields:[]},'/api/projects/sample/environment':{git:{state:'not_repository'},docker:{state:'not_installed'},ports:{values:[]}},
   '/api/projects/sample/document-vault':{binding:{connection_id:'a'.repeat(32)}},'/api/projects/sample/workflows':workflows,
   ...Object.fromEntries(workflows.map(row=>['/api/projects/sample/workflows/'+row.id,row]))
  };
  return route.fulfill({json:replies[path]||{}});
 });
 try{
  await page.goto('http://localhost/');await page.locator('#startup-loading').waitFor({state:'hidden'});
  await page.selectOption('#project','sample');await page.waitForFunction(()=>projectReady&&!chatLoading);
  await page.locator('#task-list .task').first().click();await page.waitForFunction(()=>!chatLoading&&!!filter);
  assert.equal(await page.locator('#messages .console-output').innerText(),cliMessage);
  const raw=page.locator('#messages .error-detail');assert.equal(await raw.isVisible(),false);
  await page.locator('#messages .run-details>summary').click();assert.equal(await raw.innerText(),cliRaw);
  await page.locator('#attachment-picker').setInputFiles({name:'a'.repeat(256)+'.txt',mimeType:'text/plain',buffer:Buffer.from('fixture')});
  await page.waitForFunction(()=>document.querySelector('#composer').innerText.includes('파일 이름 입력 오류'));
  await page.locator('#open-settings').click();await page.locator('#settings-page').waitFor({state:'visible'});
  for(const test of [
   {status:500,contentType:'text/plain',body:'Internal Server Error'},
   {status:502,contentType:'text/html',body:'<script>window.rawErrorExecuted=true</script><p>Bad gateway</p>'},
   {status:503,body:''},
   {status:200,body:'not JSON'},
  ]){
   failure=test;await page.locator('#save-settings').click();
   await page.waitForFunction(body=>requestErrors[0]?.raw===body,test.body);
   assert.match(await page.locator('#status-toast').innerText(),/서버/);
   assert.doesNotMatch(await page.locator('#status-toast').innerText(),/Unexpected|JSON|<script>|Internal Server Error/);
   assert.match(await page.locator('#status-toast').getAttribute('class'),/is-error/);
  }
  await page.getByRole('button',{name:'워크플로 관리',exact:true}).click();await page.getByRole('button',{name:'새 워크플로',exact:true}).click();
  await page.getByLabel('요구사항 파일',{exact:true}).setInputFiles({name:'a'.repeat(256)+'.txt',mimeType:'text/plain',buffer:Buffer.from('fixture')});
  await page.waitForFunction(()=>document.querySelector('#workflow-dialog>[role=status]').textContent.includes('255'));
  assert.match(await page.locator('#workflow-dialog>[role=status]').innerText(),/파일 이름 입력 오류/);
  failure={status:502,contentType:'text/html',body:'<p>Download unavailable</p>'};
  for(const row of workflows){
   await page.getByRole('button',{name:'워크플로 목록',exact:true}).click();
   await page.getByRole('button',{name:row.title+' — 모든 단계 승인 완료',exact:true}).click();
   await page.getByRole('button',{name:'승인 산출물과 이력 내려받기',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('#workflow-dialog>[role=status]').textContent.includes('502'));
  }
  await page.getByRole('button',{name:'워크플로 닫기',exact:true}).click();
  await page.getByRole('link',{name:'오류 상세 로그',exact:true}).click();
  const logs=page.locator('#request-errors');await logs.waitFor({state:'visible'});
  assert.equal(await logs.locator('details').count(),8);
  assert.equal(await logs.locator('pre:visible').count(),0);
  await logs.locator('summary').first().click();assert.match(await logs.locator('pre').first().innerText(),/Download unavailable/);
  const html=logs.locator('details').filter({hasText:'rawErrorExecuted'});await html.locator('summary').click();
  assert.match(await html.locator('pre').innerText(),/<script>/);assert.equal(await page.evaluate(()=>window.rawErrorExecuted),undefined);
  fs.mkdirSync('docs/internal/screenshots',{recursive:true});
  await page.screenshot({path:'docs/internal/screenshots/error-details.png'});
  await page.setViewportSize({width:480,height:800});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.reload();await page.locator('#startup-loading').waitFor({state:'hidden'});
  assert.equal(await page.locator('#request-errors details').count(),0);
  assert.deepEqual(errors,[]);console.log('PASS Korean errors, CLI details, HTTP failures, uploads, both exports, raw text safety, narrow layout');
 }catch(error){console.error(errors);throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
