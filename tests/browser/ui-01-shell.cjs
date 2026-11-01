const {chromium}=require('playwright');
const assert=require('node:assert/strict');
// CODAST-UI-01: one app bar on every screen, system-wide alerts and running shortcuts live there.
(async()=>{
 const origin=process.env.WORK_ITEM_TEST_URL||'http://127.0.0.1:8778',stamp=Date.now(),project='shell-'+stamp,other='shell-other-'+stamp;
 async function api(path,method='GET',data){const r=await fetch(origin+'/api'+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;}
 await api('/onboarding','PUT',{deferred:true});
 for(const name of [project,other])await api('/projects','POST',{name});
 const chat=await api('/projects/'+project+'/tasks','POST',{task:'상단바 채팅'});
 const otherChat=await api('/projects/'+other+'/tasks','POST',{task:'다른 프로젝트 실행'});
 await api('/projects/'+other+'/commands','POST',{text:'가상 작업',task:'다른 프로젝트 실행',chat_id:otherChat.id,client:'codex'});
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
 try{
  page.on('pageerror',error=>errors.push(error.message));
  // A run still going in another project; everything else comes from the real fixture API.
  await page.route('**/api/session-overview',async route=>{const response=await route.fetch(),data=await response.json();
   data.running.push({id:'virtual-run',project:other,adapter:'codex',status:'running',cancellable:true,started_at:new Date().toISOString(),command:{task:'다른 프로젝트 실행',chat_id:otherChat.id,client:'codex'},metadata:{}});
   await route.fulfill({response,json:data});});
  await page.goto(origin+'/#dashboard');await page.locator('#startup-loading').waitFor({state:'hidden'});
  await page.selectOption('#project',project);
  const status=page.locator('#status-toast');await page.waitForTimeout(800);
  assert.equal((await status.textContent()).includes('복원했습니다'),false,'restore toast must not appear on load');
  const bar=page.getByRole('banner');const toggle=bar.locator('#toggle-sidebar');
  await toggle.waitFor();assert.equal(await page.locator('#toggle-sidebar').count(),1,'one sidebar toggle');
  const crumbs=bar.getByRole('navigation',{name:'경로'});
  assert.equal(await crumbs.getByRole('link',{name:'CODAST',exact:true}).getAttribute('href'),'#projects');
  assert.equal(await crumbs.getByRole('link',{name:project,exact:true}).getAttribute('href'),'#dashboard');
  const atDashboard=await toggle.boundingBox();
  await page.evaluate(id=>{location.hash='#chat/'+id;},chat.id);await page.locator('#text').waitFor({state:'visible'});
  const atChat=await toggle.boundingBox();
  for(const key of ['x','y','width','height'])assert.ok(Math.abs(atDashboard[key]-atChat[key])<=2,'toggle '+key+' moved between screens');
  assert.equal(await crumbs.getByText('상단바 채팅',{exact:true}).count(),1,'chat name in path');
  assert.equal(await page.getByRole('link',{name:'작업 대시보드로'}).count(),0,'path replaces the back link');
  // Running shortcut reaches a session in another project.
  const running=bar.getByRole('button',{name:/^실행 중 \d+$/});
  await page.waitForFunction(()=>/실행 중 [1-9]/.test(document.querySelector('[role=banner]')?.textContent||''),null,{timeout:12000});
  await running.click();assert.equal(await running.getAttribute('aria-expanded'),'true');
  const runningMenu=page.locator('#running-menu');await runningMenu.getByText(other).first().waitFor();
  await runningMenu.getByRole('button',{name:/다른 프로젝트 실행/}).click();
  await page.waitForURL('**/#chat/'+otherChat.id);assert.equal(await page.locator('#project').inputValue(),other);
  // System alerts list every project and open the chat.
  const alerts=bar.getByRole('button',{name:/^시스템 알림/});await alerts.click();assert.equal(await alerts.getAttribute('aria-expanded'),'true');
  const alertMenu=page.locator('#alert-menu');const item=alertMenu.getByRole('button',{name:new RegExp(other+'.*다른 프로젝트 실행')});await item.waitFor();
  await page.keyboard.press('Escape');assert.equal(await alerts.getAttribute('aria-expanded'),'false','Esc closes the alert menu');
  assert.equal(await page.locator('.compact-session-panel').getByRole('button',{name:/^알림 \d+$/}).count(),0,'old in-panel alert button removed');
  await bar.getByRole('button',{name:'설정',exact:true}).click();await page.waitForFunction(()=>location.hash.startsWith('#settings'));
  const atSettings=await toggle.boundingBox();assert.ok(Math.abs(atSettings.x-atDashboard.x)<=2&&Math.abs(atSettings.y-atDashboard.y)<=2,'toggle stays put on settings');
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{location.hash='#dashboard';});await page.waitForTimeout(400);
  assert.equal(await bar.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true,'app bar overflow at 390px');
  assert.deepEqual(errors,[]);console.log('PASS UI-01 app bar, path links, fixed toggle, running shortcut across projects, system alerts, no restore toast');
 }finally{if(errors.length)console.error('Page errors:',errors);await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
