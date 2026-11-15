// Real browser and SSE transport; all application data is synthetic, with no model calls.
const fs=require('node:fs');
const http=require('node:http');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const chat='a'.repeat(32);
let started;
let settings={client:'codex',mode:'read-only',cwd:'.',context_paths:[],timeout_seconds:600};
let status='running',progress=null,connections=0,submissions=0,saves=0,cancellations=0;
const streams=new Set();
const lastEventIds=[];
const snapshot=()=>({run_id:'run-one',status,started_at:started,finished_at:status==='running'?null:new Date().toISOString(),
  server_time:new Date().toISOString(),last_progress_at:progress,timeout_seconds:null});
const event=(response,name,value)=>response.write((name==='run_event'?'id: '+value.seq+'\n':'')+'event: '+name+'\ndata: '+JSON.stringify(value)+'\n\n');
const server=http.createServer(async(request,response)=>{
 try{
  const url=new URL(request.url,'http://fixture'),path=url.pathname;
  const json=(data,code=200)=>{response.writeHead(code,{'content-type':'application/json'});response.end(JSON.stringify(data));};
  if(path==='/'){response.writeHead(200,{'content-type':'text/html'});return response.end(fs.readFileSync('app/web/templates/index.html'));}
  if(path.startsWith('/static/')){
   const file='app/web'+path;if(!fs.existsSync(file)){response.writeHead(404);return response.end();}
   response.writeHead(200,{'content-type':path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':path.endsWith('.woff2')?'font/woff2':'application/javascript'});
   return response.end(fs.readFileSync(file));
  }
  if(path==='/api/projects/sample/settings'){
   if(request.method==='PUT'){let body='';for await(const chunk of request)body+=chunk;settings=JSON.parse(body);saves++;}
   return json(settings);
  }
  if(path==='/api/projects/sample/runs/run-one/events'){
   connections++;lastEventIds.push(request.headers['last-event-id']);response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
   response.write('retry: 1500\n\n');event(response,'runtime',snapshot());streams.add(response);
   event(response,'run_event',{seq:1,kind:'tool',text:'saved fixture event',run_id:'run-one',created_at:started});
   if(connections>1)event(response,'run_event',{seq:2,kind:'tool',text:'new fixture event',run_id:'run-one',created_at:new Date().toISOString()});
   request.on('close',()=>streams.delete(response));return;
  }
  if(path==='/api/projects/sample/runs/run-one')return json({status,cancellable:status==='running'});
  if(path==='/api/projects/sample/runs/run-one/cancel'){
   cancellations++;status='interrupted';
   for(const stream of streams){event(stream,'runtime',snapshot());event(stream,'end',{status});stream.end();}
   return json({cancelled:true});
  }
  if(request.method==='POST'&&/\/(commands|chat)$/.test(path)){submissions++;return json({detail:'unexpected execution'},409);}
  if(path==='/api/projects/sample/messages')return json({messages:[{id:1,task:'긴 작업',text:'fixture request',created_at:started,
   run_id:'run-one',status,adapter:'codex',output:'',error:status==='interrupted'?'실행이 취소되었습니다.':null,
   cancellable:status==='running',metadata:{timeout_seconds:null}}]});
  const replies={
   '/api/onboarding':{status:'deferred',project:'sample'},'/api/projects':{projects:['sample']},
   '/api/clients':{clients:[]},'/api/clients/codex/status':{state:'available',models:[],limits:[]},
   '/api/notifications':{events:[],cursor:0,has_more:false},'/api/session-overview':{sessions:[],running:[],usage:[]},
   '/api/projects/sample/workspace':{path:'C:/fixture/sample'},
   '/api/projects/sample/tasks':{tasks:[{id:chat,task:'긴 작업',status:'active',count:1}]},
   '/api/projects/sample/runs':{runs:[]},'/api/projects/sample/questions':{messages:[]},'/api/projects/sample/rules':{rules:[]},
   '/api/projects/sample/materials':{materials:[]},'/api/projects/sample/guard':{level:'strong',privacy_mode:'replace',fields:[]},
   '/api/projects/sample/work-items':{items:[]},'/api/projects/sample/plan':{agent:'codex',run:{id:'run-one',status},items:[],earlierCompleted:[]},
   '/api/projects/sample/environment':{git:{state:'available',branch:'main'},ports:{values:[]},docker:{state:'available',containers:[]}},
  };
  json(replies[path]||{});
 }catch(error){response.writeHead(500);response.end(error.message);}
});

(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  browser=await chromium.launch({headless:true,channel:'msedge'});
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',dialog=>dialog.accept());
  started=new Date(Date.now()-660000).toISOString();
  await page.goto('http://127.0.0.1:'+server.address().port+'/#chat/'+chat);
  await page.locator('#startup-loading').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('.run-runtime')?.textContent.includes('제한 없음'));
  assert.match(await page.locator('.run-runtime').textContent(),/11분/);
  assert.match(await page.locator('.run-runtime').textContent(),/새 진행 이벤트가 2분 이상 없습니다/);
  const firstClock=await page.locator('.run-runtime').textContent();
  await page.waitForFunction(text=>document.querySelector('.run-runtime')?.textContent!==text,firstClock);
  progress=started;
  for(let i=0;i<3;i++)for(const stream of streams){stream.write(': heartbeat\n\n');event(stream,'runtime',snapshot());}
  await page.waitForFunction(()=>document.querySelector('.run-runtime')?.textContent.includes('마지막 진행'));
  assert.match(await page.locator('.run-runtime').textContent(),/새 진행 이벤트가 2분 이상 없습니다/);

  await page.evaluate(()=>window.settingsPage.open('execution'));
  await page.locator('#execution-timeout').waitFor({state:'visible'});
  assert.equal(await page.locator('#execution-timeout').inputValue(),'600');
  await page.locator('#execution-unlimited').check();
  assert.equal(await page.locator('#execution-timeout').isDisabled(),true);
  await page.locator('#save-settings').click();
  await page.waitForFunction(()=>document.querySelector('#status-toast').textContent.includes('설정을 저장했습니다'));
  assert.equal(settings.timeout_seconds,null);
  await page.locator('#execution-unlimited').uncheck();
  await page.locator('#execution-timeout').fill('45');
  const saved=page.waitForResponse(r=>r.url().endsWith('/settings')&&r.request().method()==='PUT');
  await page.locator('#save-settings').click();await saved;
  assert.equal(settings.timeout_seconds,45);
  await page.locator('#execution-timeout').fill('0');await page.locator('#save-settings').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('1초 이상의 정수'));
  assert.equal(saves,2);
  await page.evaluate(hash=>{location.hash=hash;},'#chat/'+chat);
  await page.locator('.run-runtime').waitFor({state:'visible'});
  assert.match(await page.locator('.run-runtime').textContent(),/제한 없음/);

  const before=connections;for(const stream of [...streams])stream.end();
  await page.waitForFunction(()=>document.querySelector('.run-runtime')?.textContent.includes('연결 끊김'));
  progress=new Date().toISOString();
  await page.waitForFunction(()=>{const text=document.querySelector('.run-runtime')?.textContent||'';return text.includes('마지막 진행')&&!text.includes('연결 끊김');});
  assert.ok(connections>before);assert.equal(submissions,0);
  assert.ok(lastEventIds.includes('1'));
  await page.waitForFunction(()=>document.querySelector('.stream')?.textContent.includes('new fixture event'));
  const log=await page.locator('.stream').textContent();
  assert.equal(log.split('saved fixture event').length-1,1);assert.equal(log.split('new fixture event').length-1,1);
  await page.getByRole('button',{name:'실행 취소',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#messages')?.textContent.includes('실행이 취소되었습니다.'));
  assert.equal(cancellations,1);assert.equal(await page.locator('.run-runtime').count(),0);
  assert.equal(submissions,0);assert.deepEqual(errors,[]);
  console.log('PASS: settings, frozen runtime, live clock, silence, SSE reconnect/replay and cancellation UI');
 }finally{
  if(browser)await browser.close();for(const stream of streams)stream.end();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
