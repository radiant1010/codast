const {chromium}=require('playwright');
const assert=require('node:assert/strict');
// CODAST-UI-04: project root cards and the per-project summary with the login notice.
(async()=>{
 const origin=process.env.WORK_ITEM_TEST_URL||'http://127.0.0.1:8778',stamp=Date.now(),first='root-a-'+stamp,second='root-b-'+stamp;
 async function api(path,method='GET',data){const r=await fetch(origin+'/api'+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;}
 await api('/onboarding','PUT',{deferred:true});
 for(const name of [first,second])await api('/projects','POST',{name});
 for(const task of ['요약 채팅 1','요약 채팅 2','요약 채팅 3'])await api('/projects/'+first+'/tasks','POST',{task});
 const done=(await api('/projects/'+first+'/tasks')).tasks.find(c=>c.task==='요약 채팅 3');
 await api('/projects/'+first+'/commands','POST',{text:'가상 작업',task:'요약 채팅 3',chat_id:done.id,client:'codex'});
 await api('/projects/'+first+'/tasks','PATCH',{task:'요약 채팅 3',status:'done'});
 await api('/projects/'+first+'/work-items','POST',{chat_id:done.id,title:'요약 채팅 3',goal:'요약 화면 목표',done_criteria:'요약 확인'});
 const projects=(await api('/projects')).projects;
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
 try{
  page.on('pageerror',error=>errors.push(error.message));
  // CLI state is the only fake: Codex ready, Claude needs a login.
  await page.route('**/api/clients',route=>route.fulfill({json:{clients:[
   {client:'codex',state:'installed',auth:'ready',path:'codex.exe',login:{state:'idle'}},
   {client:'claude',state:'installed',auth:'check_required',path:'claude.exe',login:{state:'idle'}}]}}));
  await page.goto(origin+'/#projects');await page.locator('#startup-loading').waitFor({state:'hidden'});
  const root=page.getByRole('main');
  // Path shows the hierarchy only: no leftover project on the root or settings screens.
  const crumbs=page.getByRole('banner').getByRole('navigation',{name:'경로'});
  const path=async()=>(await crumbs.innerText()).split('/').map(part=>part.trim()).filter(Boolean);
  await root.getByRole('heading',{level:1,name:'프로젝트',exact:true}).waitFor();
  assert.deepEqual(await path(),['CODAST'],'root path');
  const cards=root.getByRole('list',{name:'프로젝트 목록'}).getByRole('listitem');
  await page.waitForFunction(count=>document.querySelectorAll('[aria-label="프로젝트 목록"] li').length===count,projects.length);
  const card=cards.filter({hasText:first});assert.match(await card.innerText(),/세션 3/);
  assert.match(await cards.filter({hasText:second}).innerText(),/세션 0/);
  await card.getByRole('link',{name:first,exact:true}).click();
  await page.waitForURL('**/#dashboard');assert.equal(await page.locator('#project').inputValue(),first);
  const filters=page.getByRole('group',{name:'상태별 보기'});await filters.waitFor();
  assert.deepEqual(await path(),['CODAST',first],'session list path');
  const filterCount=async label=>Number((await filters.getByRole('button',{name:new RegExp('^'+label+' \\d+$')}).textContent()).match(/\d+/)[0]);
  await page.getByRole('link',{name:first+' 프로젝트 요약 보기',exact:true}).click();
  await page.waitForURL('**/#dashboard/summary');
  const summary=page.getByRole('main');
  await summary.getByRole('heading',{level:1,name:first+' 프로젝트 요약',exact:true}).waitFor();
  const region=name=>summary.getByRole('region',{name});
  for(const name of ['세션 상태','AI 한도','실행환경','목표 작업'])await region(name).waitFor();
  assert.deepEqual(await path(),['CODAST',first,'프로젝트 요약'],'summary path');
  const stat=async label=>Number((await region('세션 상태').locator('dt',{hasText:new RegExp('^'+label+'$')}).locator('xpath=following-sibling::dd[1]').textContent()).trim());
  await page.evaluate(()=>{location.hash='#dashboard';});await filters.waitFor();
  const listCounts={running:await filterCount('진행 중'),attention:await filterCount('확인 필요'),done:await filterCount('완료')};
  await page.evaluate(()=>{location.hash='#dashboard/summary';});await region('세션 상태').waitFor();
  assert.deepEqual({running:await stat('진행 중'),attention:await stat('확인 필요'),done:await stat('완료')},listCounts,'summary numbers match list filters');
  assert.match(await region('실행환경').innerText(),/Git[\s\S]*Docker[\s\S]*포트/);
  assert.match(await region('목표 작업').innerText(),/요약 채팅 3/);
  await region('AI 한도').getByRole('button',{name:'Claude 로그인',exact:true}).waitFor();
  const alerts=page.getByRole('banner').getByRole('button',{name:/^시스템 알림/});await alerts.click();
  await page.locator('#alert-menu').getByRole('button',{name:'Claude 로그인',exact:true}).waitFor();await page.keyboard.press('Escape');
  await page.evaluate(id=>{location.hash='#chat/'+id;},done.id);await page.locator('#text').waitFor({state:'visible'});
  assert.deepEqual(await path(),['CODAST',first,'요약 채팅 3'],'chat path');
  await page.getByRole('banner').getByRole('button',{name:'설정',exact:true}).click();await page.waitForFunction(()=>location.hash.startsWith('#settings'));
  assert.deepEqual(await path(),['CODAST','설정'],'settings path has no project');
  await page.evaluate(()=>{location.hash='#projects';});await root.getByRole('heading',{level:1,name:'프로젝트',exact:true}).waitFor();
  assert.deepEqual(await path(),['CODAST'],'returning to the root clears the project from the path');
  assert.equal(await crumbs.locator('[aria-current="page"]').innerText(),'CODAST','root is the current location');
  for(const old of ['#dashboard/accounts','#dashboard/environment']){
   await page.evaluate(hash=>{location.hash=hash;},old);await page.waitForFunction(()=>location.hash==='#dashboard/summary');
  }
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{location.hash='#projects';});await root.getByRole('heading',{level:1,name:'프로젝트'}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'390px overflow on project root');
  assert.deepEqual(errors,[]);console.log('PASS UI-04 project root cards, project switch, summary regions matching list counts, login notice in summary and alerts, old routes');
 }finally{if(errors.length)console.error('Page errors:',errors);await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
