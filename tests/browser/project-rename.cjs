const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require('playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,channel:'msedge'});
  const page=await browser.newPage({viewport:{width:1200,height:900}});
  const names={one:'처음이름',two:'다른프로젝트'},chatId='a'.repeat(32),errors=[],requests=[];
  let deleted=false;
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://harness.test/**',async route=>{
    const path=new URL(route.request().url()).pathname,method=route.request().method();
    if(path==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync('app/web/templates/index.html','utf8')});
    if(path.startsWith('/static/'))return route.fulfill({contentType:path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':'application/javascript',body:fs.readFileSync('app/web'+path)});
    if(path==='/api/projects')return route.fulfill({json:{projects:deleted?['two']:['one','two'],names}});
    if(path==='/api/deleted-projects')return route.fulfill({json:{projects:deleted?['one']:[],names}});
    if(path==='/api/projects/one'&&method==='PATCH'){
      const body=route.request().postDataJSON();requests.push(body);
      if(body.name===names.two)return route.fulfill({status:409,json:{detail:'이미 사용 중인 프로젝트 이름입니다.'}});
      names.one=body.name;return route.fulfill({json:{name:'one',display_name:names.one}});
    }
    if(path==='/api/projects/one'&&method==='DELETE'){deleted=true;return route.fulfill({json:{deleted:true,recoverable:true}});}
    if(path==='/api/deleted-projects/one/restore'){deleted=false;return route.fulfill({json:{restored:true,name:'one'}});}
    const project=path.match(/^\/api\/projects\/(one|two)\/(.*)$/);
    if(project){
      const [,name,resource]=project;
      const data={workspace:{path:'C:/fixture/'+name},settings:{client:'codex',mode:'read-only',cwd:'.',context_paths:[]},tasks:{tasks:[{id:chatId,task:'saved-chat',count:0,status:'active'}]},messages:{messages:[]},runs:{runs:[]},rules:{rules:[]},environment:{git:{state:'not_repository'},docker:{state:'not_installed'},ports:{values:[]}}};
      return route.fulfill({json:data[resource]||{}});
    }
    const replies={'/api/onboarding':{status:'deferred'},'/api/session-overview':{sessions:[],running:[],usage:[]},'/api/notifications':{events:[{seq:1,run_id:'saved-run',project:'one',task:'saved-chat',chat_id:chatId,status:'completed'}],cursor:1,has_more:false},'/api/clients':{clients:[]}};
    return route.fulfill({json:replies[path]||{}});
  });
  try{
    await page.goto('http://harness.test/');await page.locator('#startup-loading').waitFor({state:'hidden'});
    assert.equal(await page.locator('#rename-project').isDisabled(),true);
    await page.selectOption('#project','one');await page.waitForFunction(()=>projectReady&&!chatLoading);
    await page.locator('#task-list button.task').click();await page.waitForFunction(()=>!chatLoading&&filter==='saved-chat');
    await page.locator('#text').fill('작성 중인 초안 유지');
    const before=await page.evaluate(()=>({key:window.chatState.identity('one',filter),epoch,path:document.querySelector('#workspace-root').value}));
    await page.locator('#rename-project').click();assert.equal(await page.locator('#rename-project-name').inputValue(),'처음이름');
    await page.locator('#rename-project-name').fill('가상/잘못된이름');await page.locator('#save-project-name').click();
    assert.equal(requests.length,0);assert.match(await page.locator('#rename-project-status').innerText(),/프로젝트 이름 형식 오류/);
    await page.locator('#rename-project-name').fill('다른프로젝트');await page.locator('#save-project-name').click();
    await page.locator('#rename-project-status').filter({hasText:'이미 사용 중'}).waitFor();
    assert.equal(await page.locator('#rename-project-name').inputValue(),'다른프로젝트');
    await page.locator('#rename-project-name').fill('수정한프로젝트');await page.locator('#save-project-name').click();
    await page.locator('#rename-project-dialog').waitFor({state:'hidden'});
    assert.equal(await page.locator('#project option:checked').innerText(),'수정한프로젝트');
    assert.equal(await page.locator('#project').inputValue(),'one');assert.equal(await page.locator('#text').inputValue(),'작성 중인 초안 유지');
    assert.deepEqual(await page.evaluate(()=>({key:window.chatState.identity('one',filter),epoch,path:document.querySelector('#workspace-root').value})),before);
    await page.locator('#workspace-status > summary').click();
    await page.locator('.environment-project').filter({hasText:'수정한프로젝트'}).waitFor();
    assert.match(await page.locator('#session-alerts').textContent(),/수정한프로젝트/);
    await page.reload();await page.waitForFunction(()=>projectReady&&!chatLoading);
    assert.equal(await page.locator('#project option:checked').innerText(),'수정한프로젝트');assert.equal(await page.locator('#text').inputValue(),'작성 중인 초안 유지');
    await page.locator('#open-settings').click();await page.locator('a[href="#settings/projects"]').click();
    assert.match(await page.locator('.settings-context').innerText(),/수정한프로젝트/);
    await page.locator('#project-management > summary').click();
    await page.locator('#manage-project-name').click();assert.equal(await page.locator('#rename-project-name').inputValue(),'수정한프로젝트');
    fs.mkdirSync('docs/internal/screenshots',{recursive:true});await page.screenshot({path:'docs/internal/screenshots/project-rename.png'});
    await page.locator('#cancel-project-name').click();
    page.once('dialog',dialog=>{assert.match(dialog.message(),/수정한프로젝트/);dialog.accept();});
    await page.locator('#delete-project').click();await page.waitForFunction(()=>document.querySelector('#project').value==='');
    await page.locator('#trash-panel summary').click();await page.locator('#deleted-projects').filter({hasText:'수정한프로젝트'}).waitFor();
    await page.locator('#deleted-projects button').click();await page.waitForFunction(()=>projectReady&&!chatLoading);
    assert.equal(await page.locator('#project option:checked').innerText(),'수정한프로젝트');
    assert.deepEqual(errors,[]);console.log('PASS: rename, validation, duplicate retry, draft and chat identity, reload, labels, trash and restore.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
