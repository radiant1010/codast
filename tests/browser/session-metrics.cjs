const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const metrics={execution_model:'recorded-model',context_usage:{used_tokens:25000,window_tokens:100000,observed_at:'2026-01-02T00:00:00Z'}};
  const overview={sessions:[{project:'sample',task:'linked',client:'codex',session_id:'session-a',metrics}],running:[],usage:[]};
  await page.route('http://harness.test/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync('app/web/templates/index.html','utf8')});
   if(path.startsWith('/static/'))return route.fulfill({contentType:path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':path.endsWith('.woff2')?'font/woff2':'application/javascript',body:fs.readFileSync('app/web'+path)});
   const replies={
    '/api/onboarding':{status:'deferred'},'/api/projects':{projects:['sample']},'/api/session-overview':overview,
    '/api/notifications':{events:[],cursor:0,has_more:false},
    '/api/clients/codex/status':{default_model:'configured-model',limits:[],models:[{
     model:'configured-model',effectiveReasoningEffort:'xhigh',
     supportedReasoningEfforts:['low','medium','high','xhigh','max','ultra'].map(reasoningEffort=>({reasoningEffort}))}]},
    '/api/clients/claude/options':{models:[]},
    '/api/projects/sample/settings':{client:'codex',mode:'read-only',cwd:'.',context_paths:[]},
    '/api/projects/sample/workspace':{path:'C:/fixture/sample'},
    '/api/projects/sample/tasks':{tasks:[{task:'linked',id:'a'.repeat(32),count:0,status:'active'}]},
    '/api/projects/sample/environment':{git:{state:'available',branch:'test'},ports:{values:[]},docker:{state:'available',containers:[]}},
    '/api/projects/sample/messages':{messages:[]},'/api/projects/sample/runs':{runs:[]},'/api/projects/sample/questions':{messages:[]},
    '/api/projects/sample/rules':{rules:[]},'/api/projects/sample/materials':{materials:[]},
    '/api/projects/sample/guard':{level:'strong',privacy_mode:'replace',fields:[]},
   };
   return route.fulfill({json:replies[path]||{}});
  });
  await page.goto('http://harness.test/');
  await page.locator('#startup-loading').waitFor({state:'hidden'});
  await page.selectOption('#project','sample');
  await page.locator('#task-list .task').first().click();
  await page.waitForFunction(()=>document.querySelector('#execution-summary').textContent==='Codex / configured-model (기본)');
  assert.equal(await page.locator('#execution-model').inputValue(),'');
  assert.equal(await page.locator('#reasoning-effort option:checked').innerText(),'추론: 매우 높음 (기본)');
  assert.equal(await page.locator('#reasoning-effort option[value=none]').isDisabled(),true);
  await page.locator('#reasoning-effort').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#reasoning-effort').inputValue(),'low');
  assert.equal(await page.locator('#reasoning-effort option:checked').innerText(),'추론: 낮음');
  await page.selectOption('#reasoning-effort','');
  fs.mkdirSync('docs/internal/screenshots',{recursive:true});
  await page.locator('#composer').screenshot({path:'docs/internal/screenshots/effort-grade-default.png'});
  const table=page.locator('.compact-session-table');
  await page.waitForFunction(()=>document.querySelector('.compact-session-table').textContent.includes('recorded-model'));
  assert.equal(await page.locator('#native-session').isVisible(),true);
  assert.match(await page.locator('#native-session').innerText(),/session-a/);
  assert.match(await table.innerText(),/25.0%/);
  assert.match(await table.locator('tbody td').nth(2).getAttribute('title'),/25,000 \/ 100,000/);
  await page.locator('#execution-summary').click();
  await page.selectOption('#client','claude');
  await page.waitForFunction(()=>document.querySelector('#execution-summary').textContent==='Claude / 모델 확인 필요');
  assert.equal(await page.locator('#reasoning-effort option:checked').innerText(),'추론: 자동 (미확인)');
  assert.equal(await page.locator('#reasoning-effort option[value=ultra]').count(),0);
  assert.equal(await page.locator('#reasoning-effort option[value=max]').isDisabled(),true);
  overview.running=[{project:'sample',command:{client:'claude',task:'linked'},metadata:{session_id:'b'},cancellable:true,
    metrics:{execution_model:'live-model',context_usage:{used_tokens:0,window_tokens:1000}}}];
  await page.getByRole('button',{name:'세션 현황 다시 조회',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.compact-session-table').textContent.includes('live-model'));
  assert.match(await table.innerText(),/0.0%/);
  assert.match(await table.innerText(),/실행 중/);
  assert.doesNotMatch(await table.innerText(),/미수집/);
  await page.waitForFunction(()=>document.querySelector('#execution-summary').textContent==='Claude / live-model (최근 실행)');
  assert.equal(await page.locator('#execution-model').inputValue(),'');
  for(const width of [1280,640]){
   await page.setViewportSize({width,height:900});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight),false);
   fs.mkdirSync('docs/internal/screenshots',{recursive:true});
   await page.screenshot({path:`docs/internal/screenshots/model-name-${width}.png`});
  }
  assert.deepEqual(errors,[]);
  console.log('Session metrics browser checks passed');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
