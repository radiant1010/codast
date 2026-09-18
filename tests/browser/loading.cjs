const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:"msedge"});const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let fail=false,hold=true,releaseEnvironment;const waiting=[];
 const chats={one:[{task:'one-chat',count:0,status:'active',pinned:0,archived:0}],two:[{task:'regular',count:0,status:'active',pinned:0,archived:0},{task:'other',count:0,status:'active',pinned:0,archived:0}]};
 let unfilteredMessages=0,fileRequests=0;
 const account={state:'available',limits:[{bucket:'codex',windowDurationMins:300,usedPercent:25,resetsAt:1790000000},{bucket:'codex',windowDurationMins:10080,usedPercent:63,resetsAt:1790100000}],models:[],source:'fixture',checked_at:new Date().toISOString()};
 await page.route('http://harness.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/files')||path.endsWith('/file'))fileRequests++;
  if(path.endsWith('/messages')&&!new URL(route.request().url()).searchParams.get('task'))unfilteredMessages++;
  if(path==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync('app/web/templates/index.html','utf8')});
  if(path.startsWith('/static/'))return route.fulfill({contentType:path.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync('app/web'+path)});
  if(path==='/api/clients/codex/status'){
   if(hold)await new Promise(done=>waiting.push(done));
   return route.fulfill({status:fail?503:200,json:fail?{detail:'offline'}:account});
  }
  const project=path.match(/^\/api\/projects\/(one|two)\/(.*)$/);
  if(project){
   const [,name,resource]=project;
   if(resource==='tasks'){
    if(route.request().method()==='PATCH'){
     const payload=route.request().postDataJSON(),chat=chats[name].find(row=>row.task===payload.task);
     if(payload.title)chat.task=payload.title;
     for(const field of ['pinned','archived'])if(field in payload)chat[field]=Number(payload[field]);
     return route.fulfill({json:{updated:true}});
    }
    return route.fulfill({json:{tasks:chats[name]}});
   }
   if(resource==='environment'){
    if(name==='one')await new Promise(done=>releaseEnvironment=done);
    return route.fulfill({json:{git:{state:'available',branch:name,changed_entries:0},docker:{state:'available',containers:[]},ports:{values:[]}}});
   }
   const data={settings:{client:'codex',mode:'read-only',cwd:'.',context_paths:['old-selected.txt']},workspace:{path:'C:/fixture/'+name},tasks:{tasks:[]},messages:{messages:[]},runs:{runs:[]},rules:{rules:[]},files:{files:[]}};
   return route.fulfill({json:data[resource]||{}});
  }
  const replies={'/api/projects':{projects:['one','two']},'/api/onboarding':{status:'deferred'},'/api/session-overview':{sessions:[],running:[],usage:[{project:'two',client:'codex',task:'긴 채팅 이름의 세션 표시 확인',runs:1,running:0,input_reports:1,output_reports:1,input_tokens:20000,output_tokens:2810,last_started_at:'2026-09-18T12:00:00Z'}]}};
  return route.fulfill({json:replies[path]||{}});
 });
 await page.goto('http://harness.test/');
 await page.locator('#startup-loading').waitFor({state:'hidden'});
 assert.equal(await page.locator('#workspace').evaluate(n=>n.inert),false);
 assert.match(await page.locator('.codex-account-summary .query-refresh').getAttribute('title'),/확인 중/);
 hold=false;waiting.splice(0).forEach(done=>done());
 await page.waitForFunction(()=>document.querySelector('.codex-account-summary').textContent.includes('25%'));
 fail=true;await page.getByRole('button',{name:'계정 정보 다시 조회',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.codex-account-summary .query-refresh').dataset.state==='error');
 assert.match(await page.locator('.codex-account-summary').innerText(),/25%/);
 fail=false;await page.getByRole('button',{name:'계정 정보 다시 조회',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.codex-account-summary .query-refresh').dataset.state==='ready');
 await page.selectOption('#project','one');
 await page.locator('#messages .empty').waitFor();
 assert.match(await page.locator('#messages').innerText(),/채팅을 선택하거나/);
 assert.equal(await page.locator('#composer').isVisible(),false);
 await page.locator('#task-list button.task',{hasText:'one-chat'}).click();
 await page.locator('#composer').waitFor({state:'visible'});
 await page.waitForFunction(()=>document.querySelector('#send').disabled===false);
 await page.fill('#text','draft while environment is pending');
 await page.selectOption('#project','two');
 await page.waitForFunction(()=>document.querySelector('.compact-environment .environment-value').textContent.startsWith('two'));
 assert.equal(typeof releaseEnvironment,'function');
 const oldResponse=page.waitForResponse('http://harness.test/api/projects/one/environment');releaseEnvironment();
 await (await oldResponse).finished();
 await page.waitForFunction(()=>document.querySelector('#send').disabled===false);
 assert.match(await page.locator('.compact-environment .environment-value').first().innerText(),/^two/);
 const chatRow=name=>page.locator('.chat-list-row').filter({has:page.locator('button.task',{hasText:new RegExp('^'+name+'$')})});
 await chatRow('regular').locator('button.task').click();
 await page.waitForFunction(()=>document.querySelector('#send').disabled===false);
 await page.fill('#text','보관 후에도 유지할 초안');
 await chatRow('regular').hover();await chatRow('regular').getByRole('button',{name:'채팅 고정',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#task-list .chat-list-row').dataset.task==='regular');
 await chatRow('regular').hover();await chatRow('regular').getByRole('button',{name:'채팅 보관',exact:true}).click();
 await chatRow('regular').waitFor({state:'detached'});
 assert.match(await page.locator('#messages').innerText(),/채팅을 선택하거나/);
 assert.equal(await page.locator('#composer').isVisible(),false);
 await page.reload();await page.locator('#startup-loading').waitFor({state:'hidden'});
 assert.equal(await chatRow('regular').count(),0);
 await page.locator('#archive-label').click();await page.getByRole('button',{name:'regular 채팅 복원',exact:true}).click();
 await chatRow('regular').locator('button.task').click();await page.waitForFunction(()=>document.querySelector('#send').disabled===false);
 assert.equal(await page.locator('#text').inputValue(),'보관 후에도 유지할 초안');
 page.once('dialog',dialog=>dialog.accept('renamed'));
 await chatRow('regular').hover();await chatRow('regular').getByRole('button',{name:'채팅 이름 변경',exact:true}).click();
 await chatRow('renamed').waitFor();await page.waitForFunction(()=>document.querySelector('#send').disabled===false);
 assert.equal(await page.locator('#text').inputValue(),'보관 후에도 유지할 초안');
 assert.equal(await chatRow('renamed').getByRole('button',{name:'채팅 고정 해제'}).getAttribute('aria-pressed'),'true');
 assert.equal(await page.getByRole('button',{name:'전체 채팅 기록',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'이전 미분류 기록',exact:true}).count(),0);
 await page.locator('#text').focus();await page.mouse.move(1000,900);
 const fill=await chatRow('renamed').evaluate(n=>({row:n.getBoundingClientRect().width,button:n.querySelector('.task').getBoundingClientRect().width}));
 assert.equal(fill.button,fill.row);
 await chatRow('renamed').hover();
 const boxes=await chatRow('renamed').locator('.chat-row-actions button').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};}));
 assert.equal(boxes.length,3);
 for(let i=1;i<3;i++){assert.equal(boxes[i].y,boxes[0].y);assert.equal(boxes[i].w,boxes[0].w);assert.equal(boxes[i].h,boxes[0].h);assert.equal(boxes[i].x,boxes[i-1].x+boxes[i-1].w);}
 assert.match(await page.locator('.account-table').innerText(),/주간 63%/);
 assert.match(await page.locator('.account-table').innerText(),/Claude\s+미수집/);
 assert.deepEqual(await page.locator('.environment-table th').allTextContents(),['항목','상태','값']);
 for(const panel of ['.compact-session-panel','.codex-account-summary','.compact-environment']){
  const result=await page.locator(panel).evaluate(node=>{
   const head=node.querySelector('.compact-panel-head'),body=node.querySelector('.dashboard-body'),table=body.querySelector('tbody');
   const before=head.getBoundingClientRect().top;const clones=[];
   for(let i=0;i<12;i++){const clone=table.firstElementChild.cloneNode(true);clones.push(clone);table.append(clone);}
   body.scrollTop=100;const moved=body.scrollTop;const after=head.getBoundingClientRect().top;
   clones.forEach(n=>n.remove());body.scrollTop=0;return {before,after,moved};
  });
  assert.equal(result.before,result.after);assert.ok(result.moved>0);
 }
 await page.getByRole('button',{name:'실행 설정',exact:true}).click();
 await page.locator('#session-drawer').evaluate(n=>n.querySelectorAll('details').forEach(d=>d.open=true));
 for(const selector of ['#name','#create button','#workspace-root','#choose-workspace','#cwd','#mode','#save-settings']){
  const box=await page.locator(selector).boundingBox();assert.equal(box.height,40,selector);
  if(await page.locator(selector).evaluate(n=>n.matches('button')))assert.equal(box.width,40,selector);
 }
 await page.screenshot({path:'work/control-sizes-wide.png',fullPage:true});
 await page.setViewportSize({width:600,height:900});
 assert.equal(await page.locator('#session-drawer').evaluate(n=>n.scrollWidth<=n.clientWidth),true);
 await page.screenshot({path:'work/control-sizes-narrow.png',fullPage:true});
 await page.getByRole('button',{name:'작업실 설정 닫기',exact:true}).click();
 await page.setViewportSize({width:1440,height:1000});
 await page.screenshot({path:'work/loading-ui-wide.png',fullPage:true});
 await page.setViewportSize({width:600,height:900});
 await page.screenshot({path:'work/loading-ui-narrow.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.equal(await page.locator('.compact-session-panel .dashboard-body').evaluate(n=>n.scrollWidth<=n.clientWidth),true);
 await page.fill('#text','홈 이동 후 복원할 초안');
 await page.getByRole('link',{name:'CODAST 홈으로'}).click();
 await page.locator('#welcome').waitFor({state:'visible'});
 assert.equal(await page.locator('#project').inputValue(),'');
 assert.equal(await page.locator('#composer').isVisible(),false);
 await page.selectOption('#project','two');
 await page.waitForFunction(()=>document.querySelector('#send').disabled===false);
 assert.equal(await page.locator('#text').inputValue(),'홈 이동 후 복원할 초안');
 assert.equal(unfilteredMessages,0);
 assert.equal(fileRequests,0);
 assert.deepEqual(await page.evaluate(()=>selectedPaths()),[]);
 assert.equal(await page.locator('#document-panel,#files-panel,#open-editor').count(),0);
 await page.getByRole('button',{name:'작업 룰북',exact:true}).click();
 assert.equal(await page.locator('#rules').isVisible(),true);
 await page.getByRole('button',{name:'작업실 설정 닫기',exact:true}).click();
 assert.deepEqual(errors,[]);console.log('PASS: pending account does not block workspace; failure retains data; retry recovers; pending environment does not block input or project switching; stale response ignored; narrow viewport has no horizontal overflow; no JS errors.');
 await browser.close();
})().catch(error=>{console.error(error);process.exit(1);});
