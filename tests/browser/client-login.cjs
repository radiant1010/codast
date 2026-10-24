const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  let rows=['codex','claude'].map(client=>({client,state:'installed',auth:client==='codex'?'ready':'check_required',path:'C:/fixture/'+client+'.exe',login:{state:'idle',message:''}}));
  let posts=0,usageRequests=0,offline=false,hold=false,release;
  await page.route('http://harness.test/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync('app/web/templates/index.html','utf8')});
   if(path.startsWith('/static/'))return route.fulfill({contentType:path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':path.endsWith('.woff2')?'font/woff2':'application/javascript',body:fs.readFileSync('app/web'+path)});
   if(path==='/api/clients'){
    const snapshot=structuredClone(rows);
    if(hold){hold=false;await new Promise(resolve=>release=resolve);}
    return route.fulfill({status:offline?503:200,json:offline?{detail:'fixture offline'}:{clients:snapshot}});
   }
   if(path.match(/^\/api\/clients\/(codex|claude)\/login$/)){
    assert.equal(route.request().method(),'POST');posts++;
    const row=rows.find(row=>path.includes('/'+row.client+'/'));
    row.login={state:'waiting',message:'로그인 창과 브라우저에서 인증을 완료하세요.'};
    return route.fulfill({json:row.login});
   }
   if(path.match(/^\/api\/clients\/(codex|claude)\/status$/)){
    usageRequests++;return route.fulfill({json:{state:'available',limits:[],models:[]}});
   }
   if(path==='/api/onboarding/check')return route.fulfill({json:{status:rows[1].auth==='ready'?'completed':'in_progress',step:rows[1].auth==='ready'?'project':'authentication',connection:rows[1]}});
   const replies={
    '/api/onboarding':{status:'deferred',project:'sample',client:'claude'},
    '/api/projects':{projects:['sample']},'/api/session-overview':{sessions:[],running:[],usage:[]},
    '/api/notifications':{events:[],cursor:0,has_more:false},'/api/clients/claude/options':{models:[]},
    '/api/clients/claude/login-instructions':{argv:['C:/fixture/claude.exe','auth','login']},
    '/api/projects/sample/settings':{client:'codex',mode:'read-only',cwd:'.',context_paths:[]},
    '/api/projects/sample/workspace':{path:'C:/fixture/sample'},
    '/api/projects/sample/tasks':{tasks:[{task:'fixture',id:'a'.repeat(32),count:0,status:'active'}]},
    '/api/projects/sample/environment':{git:{state:'available',branch:'test'},ports:{values:[]},docker:{state:'available',containers:[]}},
    '/api/projects/sample/messages':{messages:[]},'/api/projects/sample/runs':{runs:[]},'/api/projects/sample/questions':{messages:[]},
    '/api/projects/sample/rules':{rules:[]},'/api/projects/sample/materials':{materials:[]},
    '/api/projects/sample/guard':{level:'strong',privacy_mode:'replace',fields:[]},
   };
   return route.fulfill({json:replies[path]||{}});
  });
  await page.goto('http://harness.test/');
  await page.locator('#startup-loading').waitFor({state:'hidden'});
  const notice=page.locator('#client-auth-notice'),refresh=page.getByRole('button',{name:'로그인 상태 다시 확인',exact:true});
  await page.getByRole('button',{name:'Claude 로그인',exact:true}).waitFor();
  assert.equal(posts,0);assert.equal(await page.locator('#login-codex').count(),0);
  assert.equal(await page.locator('#onboarding-dialog').isVisible(),false);
  await page.locator('#login-claude').focus();
  await page.evaluate(()=>window.clientAuth.check());
  assert.equal(await page.evaluate(()=>document.activeElement.id),'login-claude');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'로그인 상태 다시 확인');
  await page.locator('#task-list .task').first().click();
  await page.locator('#text').fill('인증 중에도 유지할 초안');
  fs.mkdirSync('docs/internal/screenshots',{recursive:true});
  for(const width of [1200,640]){
   await page.setViewportSize({width,height:900});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight),false);
   await notice.screenshot({path:`docs/internal/screenshots/client-login-${width}.png`});
  }
  // An older check finishing after POST must not postpone the new login status.
  hold=true;await refresh.click();await page.waitForFunction(()=>document.querySelector('#client-auth-notice button[aria-label="로그인 상태 다시 확인"]').disabled);
  await page.getByRole('button',{name:'Claude 로그인',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#login-claude').disabled);
  assert.equal(posts,1);release();
  await page.waitForFunction(()=>document.querySelector('#client-auth-notice').textContent.includes('인증을 완료하세요'));
  assert.equal(await page.locator('#login-claude').isDisabled(),true);
  const beforeUsage=usageRequests;
  rows[1].auth='ready';rows[1].login={state:'ready',message:'로그인을 확인했습니다.'};
  await notice.waitFor({state:'hidden',timeout:10000});
  assert.ok(usageRequests>beforeUsage);
  assert.equal(await page.locator('#text').inputValue(),'인증 중에도 유지할 초안');
  // Returning to the app rechecks both agents, including an external logout.
  rows[0].auth='check_required';rows[1].auth='check_required';
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await page.locator('#login-codex').waitFor();
  assert.doesNotMatch(await notice.innerText(),/로그인을 확인했습니다/);
  for(const state of ['failed','timed_out']){
   rows[1].login={state,message:state==='failed'?'로그인을 완료하지 못했습니다. 다시 시도하세요.':'로그인 대기 시간이 지났습니다. 로그인 버튼으로 다시 시작할 수 있습니다.'};
   await refresh.click();
   await page.waitForFunction(message=>document.querySelector('#client-auth-notice').textContent.includes(message),rows[1].login.message);
   assert.equal(await page.locator('#login-claude').isEnabled(),true);
  }
  offline=true;await refresh.click();
  await page.waitForFunction(()=>document.querySelector('#client-auth-notice').textContent.includes('서버에 다시 연결되면'));
  offline=false;
  // Accelerate just the next scheduled check to exercise restart recovery.
  await page.clock.install();
  await refresh.click();
  await page.waitForFunction(()=>!document.querySelector('#client-auth-notice button[aria-label="로그인 상태 다시 확인"]').disabled);
  offline=true;await page.clock.runFor(30001);
  await page.waitForFunction(()=>document.querySelector('#client-auth-notice').textContent.includes('서버에 다시 연결되면'));
  offline=false;rows[0].auth='ready';rows[1].auth='unknown';rows[1].login={state:'idle',message:''};
  await page.clock.runFor(30001);
  await notice.getByRole('button',{name:'연결 설정',exact:true}).waitFor();
  assert.equal(await page.locator('#login-claude').count(),0);
  await notice.getByRole('button',{name:'연결 설정',exact:true}).click();
  await page.getByRole('dialog',{name:'최초 연결 설정'}).waitFor();
  const dialog=page.locator('#onboarding-dialog');
  assert.equal(await dialog.getByRole('button',{name:'로그인',exact:true}).isVisible(),false);
  rows[1].auth='check_required';
  await dialog.getByRole('button',{name:'경로 저장 및 연결 확인',exact:true}).click();
  await dialog.getByRole('button',{name:'로그인',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#onboarding-dialog [role=status]').textContent.includes('인증을 완료하세요'));
  assert.equal(posts,2);
  rows[1].auth='ready';rows[1].login={state:'ready',message:'로그인을 확인했습니다.'};
  await page.clock.runFor(2001);
  await dialog.getByRole('heading',{name:'프로젝트 선택'}).waitFor();
  assert.equal(await dialog.getByRole('button',{name:'로그인',exact:true}).isVisible(),false);
  assert.deepEqual(errors,[]);
  console.log('Client login browser checks passed: startup, duplicate prevention, completion, retry, restart recovery, connection dialog, draft preservation, narrow layout');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
