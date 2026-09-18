const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:"msedge",args:["--unsafely-treat-insecure-origin-as-secure=http://harness.test"]});const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let fail=false,hold=true,releaseEnvironment;const waiting=[];
 const chats={one:[{task:'one-chat',count:0,status:'active',pinned:0,archived:0}],two:[{task:'regular',count:0,status:'active',pinned:0,archived:0},{task:'other',count:0,status:'active',pinned:0,archived:0}]};
 for(const rows of Object.values(chats))for(const row of rows)row.id=require('node:crypto').randomBytes(16).toString('hex');
 const rulebooks={};let notificationRows=[],notificationOffline=false,questionMessage=null,replyAttempts=[];
 let unfilteredMessages=0,fileRequests=0;
 const account={state:'available',limits:[{bucket:'codex',windowDurationMins:300,usedPercent:25,resetsAt:1790000000},{bucket:'codex',windowDurationMins:10080,usedPercent:63,resetsAt:1790100000}],models:[],source:'fixture',checked_at:new Date().toISOString()};
 await page.route('http://harness.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/files')||path.endsWith('/file'))fileRequests++;
  if(path.endsWith('/messages')&&!new URL(route.request().url()).searchParams.get('task')&&!new URL(route.request().url()).searchParams.get('chat_id'))unfilteredMessages++;
  if(path==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync('app/web/templates/index.html','utf8')});
  if(path.startsWith('/static/'))return route.fulfill({contentType:path.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync('app/web'+path)});
  if(path==='/api/notifications'){
   if(notificationOffline)return route.fulfill({status:503,json:{detail:'offline'}});
   const after=Number(new URL(route.request().url()).searchParams.get('after')),events=notificationRows.filter(row=>row.seq>after);
   return route.fulfill({json:{events,cursor:events.at(-1)?.seq||after,has_more:false}});
  }
  if(path==='/api/clients/codex/status'){
   if(hold)await new Promise(done=>waiting.push(done));
   return route.fulfill({status:fail?503:200,json:fail?{detail:'offline'}:account});
  }
  const project=path.match(/^\/api\/projects\/(one|two)\/(.*)$/);
  if(project){
   const [,name,resource]=project;
   if(resource==='questions')return route.fulfill({json:{messages:questionMessage&&!questionMessage.metadata.reply_run_id?[questionMessage]:[]}});
   if(resource==='messages'&&questionMessage)return route.fulfill({json:{messages:[questionMessage]}});
   if(resource==='runs/question-fixture/reply'){
    const payload=route.request().postDataJSON();replyAttempts.push(payload);
    if(replyAttempts.length===1)return route.fulfill({status:503,json:{detail:'temporary reply failure'}});
    questionMessage.metadata.reply_run_id='reply-fixture';return route.fulfill({json:{run_id:'reply-fixture'}});
   }
   if(resource==='rules'){
    if(route.request().method()==='PUT'){rulebooks[name]=route.request().postDataJSON();return route.fulfill({json:{saved:true}});}
    return route.fulfill({json:{settings:rulebooks[name]||{enabled:true,include_project_rules:true,content:null},default_content:'기본 규정',rules:[]}});
   }
   if(resource==='tasks'){
    if(route.request().method()==='PATCH'){
     const payload=route.request().postDataJSON(),chat=chats[name].find(row=>payload.chat_id?row.id===payload.chat_id:row.task===payload.task);
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
 await page.getByRole('button',{name:'설정',exact:true}).click();
 await page.locator('#settings-page').waitFor({state:'visible'});

 for(const selector of ['#workspace-root','#choose-workspace','#cwd','#mode','#save-settings']){
  const box=await page.locator(selector).boundingBox();assert.equal(box.height,40,selector);
  if(await page.locator(selector).evaluate(n=>n.matches('button')))assert.equal(box.width,40,selector);
 }
 await page.screenshot({path:'work/control-sizes-wide.png',fullPage:true});
 await page.setViewportSize({width:600,height:900});
 assert.equal(await page.locator('#settings-page').evaluate(n=>n.scrollWidth<=n.clientWidth),true);
 await page.screenshot({path:'work/control-sizes-narrow.png',fullPage:true});
 await page.getByRole('button',{name:'← 작업실',exact:true}).click();
 await page.locator('#settings-page').waitFor({state:'hidden'});
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
 await page.evaluate(()=>{
  const messages=document.querySelector('#messages');messages.replaceChildren();
  for(let i=0;i<8;i++)messages.append(messageCard({id:100+i,task:'renamed',created_at:'2026-09-18T12:00:00Z',text:'목차 요청 '+(i+1)+'\n'+('요청 내용\n'.repeat(12))},base()));
 });
 await page.waitForFunction(()=>document.querySelectorAll('.outline-item').length===8);
 const outline=page.locator('.outline-item');
 await outline.nth(4).focus();assert.equal(await outline.nth(4).locator('.outline-preview').isVisible(),true);
 await outline.nth(4).press('Enter');
 await page.waitForFunction(()=>document.querySelectorAll('.outline-item')[4].getAttribute('aria-current')==='location');
 const distance=await page.evaluate(()=>document.querySelectorAll('#messages>.message')[4].getBoundingClientRect().top-document.querySelector('#messages').getBoundingClientRect().top);
 assert.ok(Math.abs(distance-8)<2);
 await page.locator('#messages').evaluate(n=>n.scrollTop=0);
 await page.waitForFunction(()=>document.querySelector('.outline-item').getAttribute('aria-current')==='location');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:'work/chat-outline-narrow.png',fullPage:true});
 await page.setViewportSize({width:1440,height:1000});
 await outline.nth(2).hover();await page.screenshot({path:'work/chat-outline-wide.png',fullPage:true});
 await page.evaluate(()=>document.querySelector('#messages').replaceChildren());
 await page.locator('.chat-outline').waitFor({state:'hidden'});
 assert.equal(unfilteredMessages,0);
 assert.equal(fileRequests,0);
 assert.deepEqual(await page.evaluate(()=>selectedPaths()),[]);
 assert.equal(await page.locator('#document-panel,#files-panel,#open-editor').count(),0);
 await page.getByRole('button',{name:'작업 룰북',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#rulebook-content').value==='기본 규정');
 await page.getByText('변경 후 저장 버튼을 누르세요.',{exact:true}).waitFor();
 await page.fill('#rulebook-content','내 작업 규정');
 const checkStyle=await page.locator('#rulebook-tree input[type=checkbox]').first().evaluate(n=>({radius:getComputedStyle(n).borderRadius,bg:getComputedStyle(n).backgroundColor,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height}));
 assert.deepEqual(checkStyle,{radius:'0px',bg:'rgb(237, 155, 95)',width:14,height:14});
 await page.locator('#rulebook-tree input[type=checkbox]').first().focus();await page.keyboard.press('Space');
 assert.equal(await page.locator('#rulebook-tree input[type=checkbox]').first().isChecked(),false);
 await page.keyboard.press('Space');assert.equal(await page.locator('#rulebook-tree input[type=checkbox]').first().isChecked(),true);
 await page.screenshot({path:'work/orange-checkboxes.png',fullPage:true});
 await page.locator('#rulebook-tree input[type=checkbox]').first().uncheck();
 await page.getByRole('button',{name:'룰북 저장',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('#save-rulebook').disabled);
 assert.equal(rulebooks.two.books[0].content,'내 작업 규정');
 assert.equal(rulebooks.two.books[0].enabled,false);
 page.once('dialog',dialog=>dialog.accept('UI 규칙'));await page.getByRole('button',{name:'룰북 폴더 추가',exact:true}).click();
 await page.getByRole('button',{name:'룰북 추가',exact:true}).click();await page.fill('#rulebook-name','접근성');
 await page.selectOption('#rulebook-folder','UI 규칙');await page.fill('#rulebook-content','키보드 조작을 지원한다.');
 await page.getByRole('button',{name:'룰북 저장',exact:true}).click();
 await page.getByText('저장했습니다. 다음 요청부터 적용됩니다.',{exact:true}).waitFor();
 assert.equal(rulebooks.two.books.length,2);assert.equal(rulebooks.two.books[1].folder,'UI 규칙');
 assert.equal(rulebooks.two.books[1].enabled,true);
 assert.equal(await page.locator('#reload-rules').count(),0);
 await page.locator('details[data-folder="UI 규칙"]>summary').hover();
 page.once('dialog',dialog=>dialog.accept('웹'));await page.getByRole('button',{name:'UI 규칙 하위 폴더 추가',exact:true}).click();
 await page.locator('details[data-folder="UI 규칙"]').evaluate(n=>n.open=true);
 await page.locator('details[data-folder="UI 규칙/웹"]>summary').hover();
 page.once('dialog',dialog=>dialog.accept('CSS'));await page.getByRole('button',{name:'UI 규칙/웹 하위 폴더 추가',exact:true}).click();
 await page.locator('details[data-folder="UI 규칙/웹"]').evaluate(n=>n.open=true);
 await page.locator('details[data-folder="UI 규칙/웹/CSS"]>summary').hover();
 assert.equal(await page.getByRole('button',{name:'UI 규칙/웹/CSS 하위 폴더 추가',exact:true}).isDisabled(),true);
 await page.selectOption('#rulebook-folder','UI 규칙/웹/CSS');
 await page.locator('details[data-folder="UI 규칙"]>summary').hover();
 page.once('dialog',dialog=>dialog.accept('인덱스'));await page.getByRole('button',{name:'UI 규칙 폴더 이름 변경',exact:true}).click();
 assert.equal(await page.locator('#rulebook-folder').inputValue(),'인덱스/웹/CSS');
 await page.getByRole('button',{name:'룰북 저장',exact:true}).click();
 await page.getByText('저장했습니다. 다음 요청부터 적용됩니다.',{exact:true}).waitFor();
 assert.deepEqual(rulebooks.two.folders,['인덱스','인덱스/웹','인덱스/웹/CSS']);
 assert.equal(rulebooks.two.books[1].folder,'인덱스/웹/CSS');
 await page.locator('#rulebook-tree details').evaluateAll(nodes=>nodes.forEach(n=>n.open=true));
 await page.locator('details[data-folder="인덱스/웹/CSS"] .rulebook-select').dragTo(page.locator('.rulebook-root-drop'));
 assert.equal(await page.locator('#rulebook-folder').inputValue(),'');
 await page.locator('.rulebook-select').filter({hasText:'접근성'}).dragTo(page.locator('details[data-folder="인덱스/웹"]>summary'));
 assert.equal(await page.locator('#rulebook-folder').inputValue(),'인덱스/웹');
 await page.locator('details[data-folder="인덱스/웹"]>summary').dragTo(page.locator('.rulebook-root-drop'));
 assert.equal(await page.locator('#rulebook-folder').inputValue(),'웹');
 assert.equal(await page.locator('details[data-folder="웹/CSS"]').count(),1);
 await page.locator('#rulebook-tree details').evaluateAll(nodes=>nodes.forEach(n=>n.open=true));
 await page.locator('details[data-folder="웹"]>summary').dragTo(page.locator('details[data-folder="웹/CSS"]>summary'));
 assert.equal(await page.locator('details[data-folder="웹"]').count(),1);
 await page.getByRole('button',{name:'룰북 저장',exact:true}).click();
 await page.getByText('저장했습니다. 다음 요청부터 적용됩니다.',{exact:true}).waitFor();
 assert.equal(rulebooks.two.books[1].folder,'웹');
 assert.equal(await page.locator('#rulebook-files').count(),0);
 await page.locator('#rulebook-import-files').setInputFiles({name:'RULES.md',mimeType:'text/markdown',buffer:Buffer.from('직접 추가한 규정')});
 await page.getByText('파일 내용을 추가했습니다. 적용할 룰북을 체크하고 저장하세요. 원본 파일은 변경하지 않습니다.',{exact:true}).waitFor();
 assert.equal(await page.locator('#rulebook-content').inputValue(),'직접 추가한 규정');
 await page.locator('#rulebook-tree details').evaluateAll(nodes=>nodes.forEach(n=>n.open=true));
 assert.equal(await page.getByRole('checkbox',{name:'RULES.md 적용',exact:true}).isChecked(),false);
 await page.getByRole('checkbox',{name:'RULES.md 적용',exact:true}).check();
 await page.getByRole('button',{name:'룰북 저장',exact:true}).click();
 await page.getByText('저장했습니다. 다음 요청부터 적용됩니다.',{exact:true}).waitFor();
 assert.equal(rulebooks.two.books.at(-1).content,'직접 추가한 규정');
 assert.equal(rulebooks.two.include_project_rules,false);
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'선택한 룰북 삭제',exact:true}).click();
 await page.getByRole('button',{name:'룰북 저장',exact:true}).click();await page.getByText('저장했습니다. 다음 요청부터 적용됩니다.',{exact:true}).waitFor();
 assert.equal(rulebooks.two.books.at(-1).trashed,true);
 await page.getByRole('button',{name:'작업 룰북 닫기',exact:true}).click();
 await page.getByRole('button',{name:'작업 룰북',exact:true}).click();await page.getByText('변경 후 저장 버튼을 누르세요.',{exact:true}).waitFor();
 await page.locator('#rulebook-trash>summary').click();
 await page.getByRole('button',{name:'RULES.md 룰북 복원',exact:true}).click();
 assert.equal(await page.locator('#rulebook-content').inputValue(),'직접 추가한 규정');
 assert.equal(await page.getByRole('checkbox',{name:'RULES.md 적용',exact:true}).isChecked(),false);
 await page.getByRole('button',{name:'룰북 저장',exact:true}).click();await page.getByText('저장했습니다. 다음 요청부터 적용됩니다.',{exact:true}).waitFor();
 assert.equal(rulebooks.two.books.at(-1).trashed,false);





 await page.screenshot({path:'work/rulebook-edit.png',fullPage:true});
 await page.setViewportSize({width:600,height:900});
 assert.equal(await page.locator('#rules-panel-dialog').evaluate(n=>n.scrollWidth<=n.clientWidth),true);
 await page.screenshot({path:'work/rulebook-library-narrow.png',fullPage:true});
 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:'작업 룰북 닫기',exact:true}).click();
 for(const [label,id] of [['작업 룰북','rules-panel'],['시작 도움말','setup-guide']]){
  await page.getByRole('button',{name:label,exact:true}).click();
  const dialog=page.getByRole('dialog',{name:label,exact:true});assert.equal(await dialog.isVisible(),true);
  assert.equal(await page.locator('dialog[open]').count(),1);
  for(const other of ['settings-panel','history-panel','rules-panel','setup-guide','project-tools'])if(other!==id)assert.equal(await page.locator('#'+other).isVisible(),false);
  if(id==='setup-guide'){
   assert.equal(await dialog.locator('#setup-steps li').count(),4);
   assert.equal(await dialog.locator('#setup-steps').isVisible(),true);
   await page.screenshot({path:'work/start-help.png',fullPage:true});
  }
  await page.keyboard.press('Escape');assert.equal(await dialog.isVisible(),false);
 }
 assert.deepEqual(await page.locator('.workspace-menu>button').allTextContents(),['시작 도움말','작업 룰북','설정']);
 await page.fill('#text','settings navigation draft');
 const savedScroll=await page.locator('#messages').evaluate(n=>{const block=document.createElement('div');block.style.height='1800px';n.append(block);n.scrollTop=240;return n.scrollTop;});

 await page.getByRole('button',{name:'설정',exact:true}).click();
 await page.locator('#settings-page').waitFor({state:'visible'});
 for(const [label,id] of [['실행 설정','settings-panel'],['에이전트 연결','clients-panel'],['프로젝트 관리','project-tools'],['실행 기록','history-panel'],['사용량',null]]){
   await page.getByRole('link',{name:label,exact:true}).click();
   await page.getByRole('heading',{name:label,exact:true}).waitFor();
   if(id)assert.equal(await page.locator('#'+id).isVisible(),true);
   assert.equal(await page.locator('dialog[open]').count(),0);
 }
 await page.screenshot({path:'work/settings-page-wide.png',fullPage:true});
 await page.goBack();await page.getByRole('heading',{name:'실행 기록',exact:true}).waitFor();
 await page.setViewportSize({width:600,height:900});
 assert.equal(await page.locator('#settings-page').evaluate(n=>n.scrollWidth<=n.clientWidth),true);
 await page.screenshot({path:'work/settings-page-narrow.png',fullPage:true});
 await page.getByRole('button',{name:'← 작업실',exact:true}).click();
 await page.locator('#settings-page').waitFor({state:'hidden'});
 assert.equal(await page.locator('#text').inputValue(),'settings navigation draft');
 assert.equal(await page.locator('#messages').evaluate(n=>n.scrollTop),savedScroll);
 await page.setViewportSize({width:1440,height:1000});
 await page.fill('#text','stable identity draft');
 const originalId=chats.two.find(row=>row.task==='renamed').id;
 chats.two.find(row=>row.id===originalId).task='external rename';
 chats.two.push({id:'f'.repeat(32),task:'renamed',count:0,status:'active',pinned:0,archived:0});
 await page.reload();await page.locator('#startup-loading').waitFor({state:'hidden'});
 assert.equal(await page.locator('#chat-title').textContent(),'external rename');
 assert.equal(await page.locator('#text').inputValue(),'stable identity draft');
 assert.equal(await page.evaluate(()=>window.chatState.identity('two','external rename')),originalId);
 await chatRow('renamed').locator('button.task').click();await page.waitForFunction(()=>document.querySelector('#send').disabled===false);
 assert.equal(await page.locator('#text').inputValue(),'');
 notificationRows.push({seq:1,run_id:'completed-between-polls',project:'two',task:'renamed',status:'completed'});
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 await page.waitForFunction(()=>document.querySelector('#session-notifications').textContent==='알림 1');
 await page.reload();await page.locator('#startup-loading').waitFor({state:'hidden'});
 await page.waitForFunction(()=>document.querySelector('#session-notifications').textContent==='알림 1');
 await page.locator('#session-notifications').click();assert.equal(await page.locator('#session-notifications').textContent(),'알림 0');
 assert.equal(await page.locator('#session-alerts button').count(),1);
 notificationOffline=true;notificationRows.push({seq:2,run_id:'offline-failure',project:'two',task:'renamed',status:'failed'});
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 await page.waitForFunction(()=>document.querySelector('#session-notifications').title.includes('조회 실패'));
 assert.equal(await page.locator('#session-notifications').textContent(),'알림 0');
 notificationOffline=false;await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 await page.waitForFunction(()=>document.querySelector('#session-notifications').textContent==='알림 1');
 assert.equal(await page.locator('#session-alerts button').count(),2);
 questionMessage={id:'question-fixture',run_id:'question-fixture',task:'renamed',status:'completed',adapter:'codex',created_at:new Date().toISOString(),text:'ask',output:'question protocol',metadata:{question:{question:'파일 형식을 선택해 주세요.',choices:['CSV','JSON']}}};
 await page.reload();await page.locator('#startup-loading').waitFor({state:'hidden'});
 await page.getByRole('heading',{name:'사용자 답변 대기',exact:true}).waitFor();
 await page.locator('.question-choices').getByRole('button',{name:'CSV',exact:true}).click();
 await page.reload();await page.locator('#startup-loading').waitFor({state:'hidden'});
 assert.equal(await page.getByRole('textbox',{name:'질문에 대한 답변',exact:true}).inputValue(),'CSV');
 await page.getByRole('button',{name:'답변하고 계속',exact:true}).click();
 await page.getByText('temporary reply failure',{exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'질문에 대한 답변',exact:true}).inputValue(),'CSV');
 await page.getByRole('button',{name:'답변하고 계속',exact:true}).click();
 await page.getByRole('heading',{name:'답변 접수됨',exact:true}).waitFor();
 assert.equal(replyAttempts.length,2);assert.equal(replyAttempts[0].request_id,replyAttempts[1].request_id);assert.equal(replyAttempts[1].answer,'CSV');
 assert.deepEqual(errors,[]);console.log('PASS: pending account does not block workspace; failure retains data; retry recovers; pending environment does not block input or project switching; stale response ignored; narrow viewport has no horizontal overflow; no JS errors.');
 await browser.close();
})().catch(error=>{console.error(error);process.exit(1);});
