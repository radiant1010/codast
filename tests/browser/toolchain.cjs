const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require('playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,channel:'msedge'});
  const page=await browser.newPage({viewport:{width:1360,height:1000}});
  const errors=[],mutations=[];let installed=false;
  page.on('pageerror',error=>errors.push(error.message));
  const catalog=JSON.parse(fs.readFileSync('app/defaults/tool-catalog.json','utf8'));
  const report=()=>({catalog_version:1,clients:{codex:{state:'installed',auth:'ready'},claude:{state:'installed',auth:'check_required'}},
    tools:catalog.tools.map(item=>({...item,clients:Object.fromEntries(['codex','claude'].map(client=>[client,{state:item.kind==='mcp'?'configured':item.default&&(installed||client==='codex')?'installed':'missing',versions:item.kind==='plugin'?['1.0']:[],connection:item.account||item.kind==='mcp'?'not_verified':'not_required',guide:item.guide||item.clients[client].guide}]))})),errors:[]});
  await page.route('http://harness.test/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync('app/web/templates/index.html','utf8')});
    if(path.startsWith('/static/'))return route.fulfill({contentType:path.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync('app/web'+path)});
    if(route.request().method()!=='GET')mutations.push(path);
    if(path==='/api/toolchain/install'){installed=true;return route.fulfill({json:report()});}
    if(path==='/api/toolchain')return route.fulfill({json:report()});
    const replies={'/api/projects':{projects:[]},'/api/onboarding':{status:'deferred'},'/api/notifications':{events:[],cursor:0,has_more:false},'/api/session-overview':{sessions:[],running:[],usage:[]}};
    return route.fulfill({json:replies[path]||{}});
  });
  try{
    await page.goto('http://harness.test/#settings/tools');
    await page.locator('#tool-card-superpowers').waitFor();
    await page.locator('#tool-refresh').waitFor({state:'visible'});
    assert.match(await page.locator('.tool-accounts').innerText(),/로그인 필요/);
    assert.equal(await page.locator('#tool-card-github').isVisible(),false);
    assert.deepEqual(mutations,[]);
    await page.locator('#tool-filter').selectOption('all');
    await page.locator('#tool-guide-github-codex').click();
    assert.match(await page.locator('#tool-help').innerText(),/GitHub/);
    await page.locator('#tool-guide-notion-claude').click();
    assert.match(await page.locator('#tool-help').innerText(),/Notion/);
    assert.doesNotMatch(await page.locator('#tool-help').innerText(),/GitHub/);
    assert.equal(page.context().pages().length,1);
    await page.locator('#tool-help button').click();
    assert.equal(await page.evaluate(()=>document.activeElement.id),'tool-guide-notion-claude');
    await page.locator('#tool-install').click();
    await page.waitForFunction(()=>document.querySelector('.tool-summary').textContent.includes('8 / 8'));
    assert.deepEqual(mutations,['/api/toolchain/install']);
    await page.locator('#tool-filter').selectOption('default');
    fs.mkdirSync('docs/internal/screenshots',{recursive:true});
    await page.screenshot({path:'docs/internal/screenshots/toolchain-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:'docs/internal/screenshots/toolchain-mobile.png',fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
    assert.deepEqual(errors,[]);
    console.log('PASS: tool setup, explicit install, grouped status, selected guide, mobile layout; no login popup.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
