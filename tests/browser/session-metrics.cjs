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
   if(path.startsWith('/static/'))return route.fulfill({contentType:path.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync('app/web'+path)});
   const replies={
    '/api/onboarding':{status:'deferred'},'/api/projects':{projects:['sample']},'/api/session-overview':overview,
    '/api/notifications':{events:[],cursor:0,has_more:false},
    '/api/projects/sample/settings':{client:'codex',mode:'read-only',cwd:'.',context_paths:[]},
    '/api/projects/sample/workspace':{path:'C:/fixture/sample'},
    '/api/projects/sample/tasks':{tasks:[{task:'linked',id:'a'.repeat(32),count:0,status:'active'}]},
    '/api/projects/sample/environment':{git:{state:'available',branch:'test'},ports:{values:[]},docker:{state:'available',containers:[]}},
    '/api/projects/sample/messages':{messages:[]},'/api/projects/sample/runs':{runs:[]},'/api/projects/sample/questions':{messages:[]},
   };
   return route.fulfill({json:replies[path]||{}});
  });
  await page.goto('http://harness.test/');
  await page.locator('#startup-loading').waitFor({state:'hidden'});
  await page.locator('#workspace-status > summary').click();
  await page.selectOption('#project','sample');
  const table=page.locator('.compact-session-table');
  await page.waitForFunction(()=>document.querySelector('.compact-session-table').textContent.includes('recorded-model'));
  assert.match(await table.innerText(),/25.0%/);
  assert.match(await table.locator('tbody td').nth(2).getAttribute('title'),/25,000 \/ 100,000/);
  overview.running=[{project:'sample',command:{client:'claude',task:'live'},metadata:{session_id:'b'},cancellable:true,
    metrics:{execution_model:'live-model',context_usage:{used_tokens:0,window_tokens:1000}}}];
  await page.getByRole('button',{name:'세션 현황 다시 조회',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.compact-session-table').textContent.includes('live-model'));
  assert.match(await table.innerText(),/0.0%/);
  assert.match(await table.innerText(),/실행 중/);
  assert.doesNotMatch(await table.innerText(),/미수집/);
  assert.deepEqual(errors,[]);
  console.log('Session metrics browser checks passed');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
