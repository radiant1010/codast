const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require('playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,channel:'msedge'});
  const page=await browser.newPage({viewport:{width:1100,height:900}});
  const registrations=[],errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://harness.test/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync('app/web/templates/index.html','utf8')});
    if(path.startsWith('/static/'))return route.fulfill({contentType:path.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync('app/web'+path)});
    if(path==='/api/workspace-folder')return route.fulfill({json:{path:'C:/가상프로젝트'}});
    if(path==='/api/workspaces'){
      registrations.push(route.request().postDataJSON());
      return route.fulfill({status:422,json:{detail:[{type:'string_pattern_mismatch',loc:['body','name'],msg:'String should match pattern',input:'private-input',ctx:{pattern:'internal-regex'}}]}});
    }
    const replies={'/api/projects':{projects:[]},'/api/onboarding':{status:'deferred'},'/api/notifications':{events:[],cursor:0,has_more:false},'/api/session-overview':{sessions:[],running:[],usage:[]}};
    return route.fulfill({json:replies[path]||{}});
  });
  try{
    await page.goto('http://harness.test/');
    await page.locator('#add-workspace').click();
    await page.locator('#workspace-path').fill('C:/가상프로젝트');
    await page.locator('#workspace-name').fill('가상/프로젝트');
    await page.locator('#register-folder').click();
    assert.equal(registrations.length,0,'Invalid names must be stopped before sending a request');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'workspace-name');
    assert.match(await page.locator('#folder-status').innerText(),/프로젝트 이름 형식 오류/);
    assert.match(await page.locator('#folder-status').innerText(),/한글.*영문.*숫자/);
    fs.mkdirSync('docs/internal/screenshots',{recursive:true});
    await page.screenshot({path:'docs/internal/screenshots/workspace-name-validation.png'});
    await page.locator('#workspace-name').fill('가상프로젝트');
    assert.equal(await page.locator('#workspace-name').evaluate(input=>input.checkValidity()),true);
    await page.locator('#workspace-name').fill('가상/프로젝트');
    await page.locator('#register-folder').click();
    await page.locator('#cancel-workspace').click();
    await page.locator('#add-workspace').click();
    await page.locator('#pick-folder').click();
    await page.waitForFunction(()=>document.querySelector('#workspace-name').value==='가상프로젝트');
    assert.equal(await page.locator('#workspace-name').evaluate(input=>input.checkValidity()),true,'Reopening with a suggested name must clear any previous error');
    await page.locator('#register-folder').click();
    await page.waitForFunction(()=>document.querySelector('#folder-status').textContent.includes('프로젝트 이름 형식 오류'));
    assert.equal(registrations.length,1);
    assert.equal(registrations[0].name,'가상프로젝트');
    assert.doesNotMatch(await page.locator('#folder-status').innerText(),/string_pattern_mismatch|private-input|internal-regex/);
    assert.equal(await page.locator('#workspace-name').inputValue(),'가상프로젝트');
    assert.equal(await page.locator('#register-folder').isEnabled(),true);
    assert.deepEqual(errors,[]);
    console.log('PASS: invalid names blocked, Korean field guidance shown, server details hidden, input preserved for retry.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
