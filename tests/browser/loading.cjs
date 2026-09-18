const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:"msedge"});const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let fail=false,hold=true,releaseEnvironment;const waiting=[];
 const account={state:'available',limits:[{bucket:'codex',windowDurationMins:300,usedPercent:25,resetsAt:1790000000},{bucket:'codex',windowDurationMins:10080,usedPercent:63,resetsAt:1790100000}],models:[],source:'fixture',checked_at:new Date().toISOString()};
 await page.route('http://harness.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync('app/web/templates/index.html','utf8')});
  if(path.startsWith('/static/'))return route.fulfill({contentType:path.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync('app/web'+path)});
  if(path==='/api/clients/codex/status'){
   if(hold)await new Promise(done=>waiting.push(done));
   return route.fulfill({status:fail?503:200,json:fail?{detail:'offline'}:account});
  }
  const project=path.match(/^\/api\/projects\/(one|two)\/(.*)$/);
  if(project){
   const [,name,resource]=project;
   if(resource==='environment'){
    if(name==='one')await new Promise(done=>releaseEnvironment=done);
    return route.fulfill({json:{git:{state:'available',branch:name,changed_entries:0},docker:{state:'available',containers:[]},ports:{values:[]}}});
   }
   const data={settings:{client:'codex',mode:'read-only',cwd:'.',context_paths:[]},workspace:{path:'C:/fixture/'+name},tasks:{tasks:[]},messages:{messages:[]},runs:{runs:[]},rules:{rules:[]},files:{files:[]}};
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
 await page.screenshot({path:'work/loading-ui-wide.png',fullPage:true});
 await page.setViewportSize({width:600,height:900});
 await page.screenshot({path:'work/loading-ui-narrow.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.equal(await page.locator('.compact-session-panel .dashboard-body').evaluate(n=>n.scrollWidth<=n.clientWidth),true);
 assert.deepEqual(errors,[]);console.log('PASS: pending account does not block workspace; failure retains data; retry recovers; pending environment does not block input or project switching; stale response ignored; narrow viewport has no horizontal overflow; no JS errors.');
 await browser.close();
})().catch(error=>{console.error(error);process.exit(1);});
