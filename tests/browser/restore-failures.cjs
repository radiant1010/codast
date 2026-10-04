const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');

(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let failure='',held='',release;
  const chats=[{id:'a',task:'A',count:0},{id:'b',task:'B',count:0}];
  await page.route('http://harness.test/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync('app/web/templates/index.html','utf8')});
   if(path.startsWith('/static/'))return route.fulfill({contentType:path.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync('app/web'+path)});
   const match=path.match(/^\/api\/projects\/(one|two)\/(.*)$/);
   if(match){
    const [,name,resource]=match,key=name+'/'+resource;
    if(key===held){held='';await new Promise(done=>release=done);return route.fulfill({status:503,json:{detail:'delayed failure'}});}
    if(key===failure)return route.fulfill({status:503,json:{detail:'fixture unavailable'}});
    const data={settings:{client:'codex',mode:'read-only',cwd:'.'},workspace:{path:'fixture/'+name},tasks:{tasks:chats},messages:{messages:[]},questions:{messages:[]},runs:{runs:[]},rules:{rules:[]},environment:{git:{state:'unavailable'},docker:{state:'unavailable'},ports:{values:[]}}};
    return route.fulfill({json:data[resource]||{}});
   }
   const data={'/api/projects':{projects:['one','two']},'/api/onboarding':{status:'deferred'},'/api/notifications':{events:[],cursor:0,has_more:false},'/api/clients/codex/status':{models:[],limits:[]},'/api/session-overview':{sessions:[],running:[],usage:[]}};
   return route.fulfill({json:data[path]||{}});
  });
  await page.goto('http://harness.test/');await page.locator('#startup-loading').waitFor({state:'hidden'});
  await page.evaluate(()=>{
   for(const client of ['codex','claude']){
    const task=client==='codex'?'A':'B';
    window.chatState.seed('one',task,{client,model:client+'-saved',cwd:'.',mode:'read-only',fresh:false,action:'run',paths:[]});
   }
  });
  await page.selectOption('#project','one');
  const ready=()=>page.waitForFunction(()=>!document.getElementById('send').disabled);
  await ready();
  const open=async task=>{await page.locator('#task-list button.task',{hasText:new RegExp('^'+task+'$')}).click();};
  // Both agents preserve edits made after failed conversation reads, including reload.
  for(const [task,agent] of [['A','codex'],['B','claude']]){
   failure='one/messages';await open(task);
   await page.waitForFunction(()=>document.getElementById('status').textContent.includes('대화 조회 실패'));
   assert.equal(await page.locator('#client').inputValue(),agent);
   assert.equal(await page.locator('#execution-model').inputValue(),agent+'-saved');
   assert.equal(await page.locator('#send').isDisabled(),true);
   await page.fill('#text',agent+' draft after failure');
   await page.reload();await page.locator('#startup-loading').waitFor({state:'hidden'});
   assert.equal(await page.locator('#text').inputValue(),agent+' draft after failure');
   assert.equal(await page.locator('#execution-model').inputValue(),agent+'-saved');
   failure='';await page.locator('#reload').click();await ready();
   assert.equal(await page.locator('#text').inputValue(),agent+' draft after failure');
  }
  // Project prerequisites may fail independently; retry must not overwrite saved drafts.
  for(const resource of ['settings','workspace','tasks']){
   failure='one/'+resource;await page.reload();await page.locator('#startup-loading').waitFor({state:'hidden'});
   assert.match(await page.locator('#status').textContent(),/프로젝트 조회 실패/);
   assert.equal(await page.locator('#composer').evaluate(n=>n.inert),true);
   failure='';await page.locator('#reload').click();await ready();
   assert.equal(await page.locator('#text').inputValue(),'claude draft after failure');
   assert.equal(await page.locator('#client').inputValue(),'claude');
  }
  // Rulebook failures retain drafts and are never masked by a success notice.
  failure='one/rules';await page.locator('#reload').click();
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('룰북 조회 실패'));
  await page.fill('#text','edited while rules failed');failure='';await page.locator('#reload').click();await ready();
  assert.equal(await page.locator('#text').inputValue(),'edited while rules failed');
  for(const resource of ['runs','questions']){
   failure='one/'+resource;await page.locator('#reload').click();
   await page.waitForFunction(()=>document.getElementById('status').textContent.includes('대화 조회 실패'));
   await page.fill('#text','edited while '+resource+' failed');
   failure='';await page.locator('#reload').click();await ready();
   assert.equal(await page.locator('#text').inputValue(),'edited while '+resource+' failed');
  }
  // Typing during a pending read is saved before switching; obsolete failures stay silent.
  held='one/messages';await open('A');
  await page.waitForFunction(()=>document.getElementById('task-name').value==='A'&&!document.getElementById('composer').inert);
  await page.fill('#text','typed during pending read');
  await open('B');await ready();const status=await page.locator('#status').textContent();
  assert.equal(typeof release,'function');release();
  await page.waitForResponse(r=>r.url().includes('/one/messages')&&r.status()===503);
  await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,50)));
  assert.equal(await page.locator('#status').textContent(),status);
  assert.equal(await page.locator('#text').inputValue(),'edited while questions failed');
  await open('A');await ready();assert.equal(await page.locator('#text').inputValue(),'typed during pending read');
  // A failed project remains escapable through the project selector.
  failure='two/settings';await page.selectOption('#project','two');
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('프로젝트 조회 실패'));
  await page.selectOption('#project','one');await ready();
  assert.equal(await page.locator('#text').inputValue(),'typed during pending read');
  assert.deepEqual(errors,[]);
  console.log('PASS: Codex/Claude drafts and models survive read failures, reload, retry, delayed responses and project switches.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
