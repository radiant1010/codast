const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');

(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const keys=Array.from({length:32},(_,i)=>'sample-'+i);
 const names=Object.fromEntries(keys.map((key,i)=>[key,'한글프로젝트이름'.repeat(5).slice(0,39)+String.fromCodePoint(0xac00+i)]));
 const tasks=Array.from({length:35},(_,i)=>({id:String(i+1).padStart(32,'0'),task:'주문 관리 화면의 긴 한글 작업 이름 확인 '+(i+1),count:8,status:'active'}));
 const materials=Array.from({length:10},(_,i)=>({id:String(i+1).padStart(32,'0'),label:'검증용 첨부 자료 '+(i+1)+'.csv',status:'ready',level:'strong'}));
 let failMessages=false;
 await page.route('http://harness.test/**',async route=>{
  const p=new URL(route.request().url()).pathname;
  if(p==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync('app/web/templates/index.html','utf8')});
  if(p.startsWith('/static/'))return route.fulfill({contentType:p.endsWith('.css')?'text/css':p.endsWith('.svg')?'image/svg+xml':p.endsWith('.woff2')?'font/woff2':'application/javascript',body:fs.readFileSync('app/web'+p)});
  if(p==='/api/projects')return route.fulfill({json:{projects:keys,names}});
  const match=p.match(/^\/api\/projects\/sample-\d+\/(.*)$/);
  if(match){
   if(match[1]==='messages'&&failMessages)return route.fulfill({status:503,json:{detail:'가상 대화 조회 오류'}});
   const messages=Array.from({length:8},(_,i)=>({id:i+1,task:tasks[0].task,text:'입력 조건과 오류 안내를 확인해 주세요.',created_at:'2026-10-24T08:00:00Z',run_id:'fixture-'+i,status:'completed',adapter:'codex',output:'좁은 창에서도 대화 내용과 전송 버튼을 읽을 수 있어야 합니다. '.repeat(30),metadata:{elapsed_seconds:4}}));
   const data={workspace:{path:'C:/fixture/작업폴더'},settings:{client:'codex',model:'fixture-model',reasoning_effort:'ultra',mode:'read-only',cwd:'.',context_paths:[]},tasks:{tasks},messages:{messages},runs:{runs:[]},rules:{rules:[]},questions:{messages:[]},environment:{git:{state:'not_repository'},docker:{state:'not_installed'},ports:{values:[]}}};
   if(match[1]==='materials')return route.fulfill({json:{materials}});
   if(match[1]==='guard')return route.fulfill({json:{level:'strong',privacy_mode:'replace',fields:[]}});
   return route.fulfill({json:data[match[1]]||{}});
  }
  const models=[{model:'fixture-model',displayName:'검증용 모델',supportedReasoningEfforts:[{reasoningEffort:'high'}]}];
  const replies={'/api/onboarding':{status:'deferred'},'/api/session-overview':{sessions:[],running:[],usage:[]},'/api/notifications':{events:[],cursor:0,has_more:false},'/api/clients':{clients:[]},'/api/clients/codex/status':{state:'available',models,limits:[]}};
  return route.fulfill({json:replies[p]||{}});
 });
 try{
  await page.goto('http://harness.test/');await page.locator('#startup-loading').waitFor({state:'hidden'});
  assert.equal(await page.locator('#workspace-status').count(),1,'Folded status control must exist');
  assert.equal(await page.locator('#workspace-status').getAttribute('open'),null);
  await page.selectOption('#project',keys[0]);await page.waitForFunction(()=>projectReady&&!chatLoading);
  await page.locator('#task-list .task').first().click();await page.waitForFunction(()=>!chatLoading&&!!filter);
  await page.fill('#text','작성 중인 초안 유지');
  assert.equal(await page.locator('#reasoning-effort option[value=ultra]').isDisabled(),true);
  const check=async()=>{
   const m=await page.evaluate(()=>{
    const q=s=>document.querySelector(s),send=q('#send').getBoundingClientRect();
    return {overflowX:document.documentElement.scrollWidth>innerWidth,overflowY:document.documentElement.scrollHeight>innerHeight,sendVisible:send.bottom<=innerHeight&&send.right<=innerWidth,messages:q('#messages').clientHeight,footerOverflow:q('.workspace-menu').scrollHeight>q('.workspace-menu').clientHeight,heights:Object.fromEntries(['#console>header','#workspace-status','#status','#composer','#text','#attachment-chips','.composer-toolbar','.attachment-notice'].map(s=>[s,q(s).getBoundingClientRect().height]))};
   });
   assert.equal(m.overflowX,false);assert.equal(m.overflowY,false);assert.equal(m.sendVisible,true);assert.ok(m.messages>=90,JSON.stringify({viewport:page.viewportSize(),...m}));assert.equal(m.footerOverflow,false);
  };
  for(const [width,height] of [[480,700],[640,700],[768,700],[900,700],[901,700],[960,700],[1200,900],[1440,900]]){
   await page.setViewportSize({width,height});await page.locator('#sidebar').waitFor({state:width>900?'visible':'hidden'});
   await check();await page.locator('#workspace-status > summary').click();await check();await page.keyboard.press('Escape');
   assert.equal(await page.locator('#workspace-status').getAttribute('open'),null);
   assert.equal(await page.locator('#text').inputValue(),'작성 중인 초안 유지');
   if(width===640||width===1200){fs.mkdirSync('docs/internal/screenshots',{recursive:true});await page.screenshot({path:`docs/internal/screenshots/workspace-fold-${width}.png`});}
  }
  await page.setViewportSize({width:640,height:700});
  await page.locator('#toggle-sidebar').press('Enter');await page.locator('#sidebar').waitFor({state:'visible'});
  assert.equal(await page.locator('#project option').count(),33);
  await page.keyboard.press('Escape');await page.locator('#sidebar').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>document.activeElement.id),'toggle-sidebar');
  await page.locator('#toggle-sidebar').click();await page.locator('#rename-project').click();await page.locator('#rename-project-dialog').waitFor({state:'visible'});
  await page.locator('#cancel-project-name').click();
  await page.waitForFunction(()=>document.activeElement.id==='toggle-sidebar');
  await page.locator('#toggle-sidebar').click();await page.locator('#open-session-search').click();await page.locator('#session-search').waitFor({state:'visible'});
  await page.keyboard.press('Escape');await page.waitForFunction(()=>document.activeElement.id==='toggle-sidebar');
  await page.locator('#toggle-sidebar').click();await page.locator('#open-settings').click();await page.locator('#settings-page').waitFor({state:'visible'});
  await page.getByRole('button',{name:'← 작업실',exact:true}).click();await page.locator('#settings-page').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>document.activeElement.id),'toggle-sidebar');
  await page.fill('#text','긴 초안입니다.\n'.repeat(60));await check();
  await page.locator('#workspace-status > summary').click();await check();await page.keyboard.press('Escape');
  await page.evaluate(({key,ids})=>window.materialGuard.restore(key,ids),{key:keys[0],ids:materials.map(row=>row.id)});
  await page.locator('#attachment-chips .attachment-chip').nth(9).waitFor();
  for(const [width,height] of [[480,700],[640,700],[480,500],[640,500]]){
   await page.setViewportSize({width,height});await page.locator('#workspace-status > summary').click();await check();
   assert.ok(await page.locator('.attachment-notice').evaluate(n=>n.getBoundingClientRect().bottom<=innerHeight));
   await page.keyboard.press('Escape');
  }
  await page.setViewportSize({width:640,height:700});
  failMessages=true;await page.locator('#toggle-sidebar').click();await page.locator('#task-list .task').nth(1).click();
  await page.locator('#status.error').waitFor({state:'visible'});assert.match(await page.locator('#status').innerText(),/대화.*조회 실패/);await check();
  assert.deepEqual(errors,[]);
  fs.mkdirSync('docs/internal/screenshots',{recursive:true});await page.screenshot({path:'docs/internal/screenshots/workspace-layout-error.png'});
  console.log('PASS: folded status, one-screen layout, internal scrolling, native options, responsive navigation, draft and error visibility.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
