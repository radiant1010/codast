const {chromium}=require('playwright');
const assert=require('node:assert/strict');
// CODAST-UI-03: opening a session collapses the list into a 264px side list next to a one-row chat header.
(async()=>{
 const origin=process.env.WORK_ITEM_TEST_URL||'http://127.0.0.1:8778',stamp=Date.now(),project='collapse-'+stamp,other='collapse-other-'+stamp;
 async function api(path,method='GET',data){const r=await fetch(origin+'/api'+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;}
 await api('/onboarding','PUT',{deferred:true});
 for(const name of [project,other])await api('/projects','POST',{name});
 const b='/projects/'+project;
 const goalChat=await api(b+'/tasks','POST',{task:'목표 채팅'}),plainChat=await api(b+'/tasks','POST',{task:'일반 채팅'});
 await api(b+'/work-items','POST',{chat_id:goalChat.id,title:'목표 채팅',goal:'접힌 목록을 검증한다.',done_criteria:'검사 통과'});
 for(let i=1;i<=22;i++)await api(b+'/messages','POST',{text:'기록 메모 '+i,task:'일반 채팅'});
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
 try{
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/#dashboard');await page.locator('#startup-loading').waitFor({state:'hidden'});await page.selectOption('#project',project);
  const sidebar=page.locator('#sidebar'),width=async()=>(await sidebar.boundingBox())?.width||0;
  await page.getByRole('button',{name:'목표 채팅 채팅 열기',exact:true}).waitFor();
  assert.ok(await width()<2,'no side list on the session list screen');
  await page.getByRole('button',{name:'일반 채팅 채팅 열기',exact:true}).click();
  await page.waitForURL('**/#chat/'+plainChat.id);await page.waitForTimeout(700);
  const collapsed=await width();assert.ok(collapsed>=256&&collapsed<=272,'side list width '+collapsed);
  const switcher=sidebar.getByRole('button',{name:new RegExp('프로젝트.*'+project)});
  assert.equal(await switcher.getAttribute('aria-expanded'),'false');
  await sidebar.getByRole('link',{name:'프로젝트 요약',exact:true}).waitFor();
  await sidebar.getByRole('button',{name:'새 작업',exact:true}).waitFor();
  const list=sidebar.locator('#task-list'),row=name=>list.locator('.chat-list-row',{hasText:name});
  assert.match(await row('목표 채팅').innerText(),/시작 전|대기 중|준비/);
  assert.notEqual(await row('일반 채팅').locator('[aria-current]').getAttribute('aria-current'),'false');
  for(const label of ['채팅 고정','채팅 이름 변경','채팅 보관'])assert.equal(await row('목표 채팅').getByRole('button',{name:label}).count(),1,label+' kept');
  // One-row chat header: everything between the app bar and the conversation stays within 56px.
  const bar=await page.getByRole('banner').boundingBox(),tabs=await page.getByRole('tablist',{name:'채팅 세션 내용'}).boundingBox();
  assert.ok(tabs.y+tabs.height-(bar.y+bar.height)<=56,'chat header height '+(tabs.y+tabs.height-(bar.y+bar.height)));
  assert.equal(await page.locator('#console>header #messages-prev').isVisible(),false,'paging moved out of the header');
  const messages=page.locator('#messages .message');const before=await messages.count();
  await page.getByRole('button',{name:'이전 대화 더 보기',exact:true}).click();
  await page.waitForFunction(count=>document.querySelectorAll('#messages .message').length!==count,before);
  await page.getByText('기록 메모 1',{exact:true}).waitFor();
  // Drafts stay per chat while switching from the side list.
  await page.locator('#text').fill('일반 채팅 초안');
  await row('목표 채팅').getByRole('button',{name:'목표 채팅',exact:true}).click();await page.waitForURL('**/#chat/'+goalChat.id);
  assert.equal(await page.locator('#text').inputValue(),'');
  const goal=page.getByRole('button',{name:/^목표: 접힌 목록을 검증한다/});await goal.click();
  await page.waitForURL('**/#chat/'+goalChat.id+'/info');
  await row('일반 채팅').getByRole('button',{name:'일반 채팅',exact:true}).click();await page.waitForURL('**/#chat/'+plainChat.id);
  await page.locator('#text').waitFor({state:'visible'});assert.equal(await page.locator('#text').inputValue(),'일반 채팅 초안');
  // Project switcher at the top of the side list.
  await switcher.click();assert.equal(await switcher.getAttribute('aria-expanded'),'true');
  await sidebar.getByRole('button',{name:'전체 프로젝트 보기',exact:true}).waitFor();
  await sidebar.getByRole('button',{name:other,exact:true}).click();
  await page.waitForURL('**/#dashboard');assert.equal(await page.locator('#project').inputValue(),other);
  await page.waitForTimeout(700);assert.ok(await width()<2,'side list closes back into the full list');
  // Narrow screens: chat only, the app bar toggle opens the list as a drawer.
  await page.selectOption('#project',project);await page.setViewportSize({width:390,height:844});
  await page.evaluate(id=>{location.hash='#chat/'+id;},plainChat.id);await page.locator('#text').waitFor({state:'visible'});
  assert.equal(await sidebar.isVisible(),false,'chat only at 390px');
  await page.locator('#toggle-sidebar').click();await sidebar.waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'390px overflow');
  assert.deepEqual(errors,[]);console.log('PASS UI-03 collapsed 264px list, switcher, kept chat actions, one-row header, older messages, per-chat drafts, narrow drawer');
 }finally{if(errors.length)console.error('Page errors:',errors);await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
