const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let options={level:'strong',fields:[]},rows=[],sent,serial=0,hold=false,release,fail=false,block=false;
  await page.route('http://localhost/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname;
   if(path==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync('app/web/templates/index.html','utf8')});
   if(path.startsWith('/static/'))return route.fulfill({contentType:path.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync('app/web'+path)});
   const resource=path.replace('/api/projects/one/','');
   if(resource==='guard'){if(req.method()==='PUT'){options=req.postDataJSON();rows=rows.map(r=>({...r,stale:true}));}return route.fulfill({json:options});}
   if(resource==='materials'){
    if(req.method()==='POST'){if(hold){hold=false;await new Promise(done=>release=done);}if(fail){fail=false;return route.fulfill({status:400,json:{detail:'지원하지 않는 파일입니다.'}});}const row={id:(++serial).toString(16).padStart(32,'0'),label:'자료 '+serial+'.csv',level:options.level,rule_version:'fixture',status:block?'blocked':'ready',findings:[{location:'R2C1',kind:'name',action:'masked',count:1}],omissions:[],test_data:true};block=false;rows.unshift(row);return route.fulfill({status:201,json:row});}
    return route.fulfill({json:{materials:rows}});
   }
   if(resource.startsWith('materials/'))return route.fulfill({json:{content:'홍*동,010-****-2324'}});
   if(resource==='chat'){sent=req.postDataJSON();return route.fulfill({json:{run_id:'run',action:'run',routing:{task:'A',kind:'explicit'}}});}
   const data={'/api/projects':{projects:['one']},'/api/onboarding':{status:'deferred'},'/api/notifications':{events:[],cursor:0,has_more:false},'/api/clients/codex/status':{models:[],limits:[]},'/api/session-overview':{sessions:[],running:[],usage:[]},settings:{client:'codex',mode:'read-only',cwd:'.'},workspace:{path:'fixture/one'},tasks:{tasks:[{id:'a'.repeat(32),task:'A',count:0},{id:'b'.repeat(32),task:'B',count:0}]},messages:{messages:[]},questions:{messages:[]},runs:{runs:[]},rules:{rules:[]},environment:{git:{state:'unavailable'},docker:{state:'unavailable'},ports:{values:[]}}};
   return route.fulfill({json:data[resource]||data[path]||{}});
  });
  await page.goto('http://localhost/');await page.locator('#startup-loading').waitFor({state:'hidden'});
  await page.selectOption('#project','one');await page.locator('#task-list button.task',{hasText:/^A$/}).click();
  const height=()=>page.locator('#text').evaluate(n=>n.getBoundingClientRect().height);
  await page.fill('#text','짧은 입력');await page.waitForTimeout(50);const shortHeight=await height();
  await page.fill('#text',Array(30).fill('긴 입력').join('\n'));
  await page.waitForFunction(()=>document.getElementById('text').scrollHeight>document.getElementById('text').clientHeight);
  await page.waitForTimeout(50);assert.ok(await height()>shortHeight);assert.ok(await height()<=200);
  assert.equal(await page.locator('#text').evaluate(n=>getComputedStyle(n).resize),'none');
  await page.locator('#task-list button.task',{hasText:/^B$/}).click();await page.waitForTimeout(50);assert.equal(await height(),shortHeight);
  await page.locator('#task-list button.task',{hasText:/^A$/}).click();await page.waitForTimeout(50);assert.ok(await height()>shortHeight);
  await page.fill('#text','');await page.waitForTimeout(50);assert.equal(await height(),shortHeight);
  assert.equal(await page.getByText('메시지 옵션',{exact:true}).count(),0);
  assert.equal(await page.locator('#action').isVisible(),false);
  assert.doesNotMatch(await page.locator('#composer').innerText(),/선택 0개/);
  await page.evaluate(()=>window.settingsPage.open('materials'));
  assert.equal(await page.locator('#settings-page input[type=file]').count(),0);
  await page.selectOption('#guard-level','medium');await page.getByRole('button',{name:'파일 보호 설정 저장',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('파일 보호 설정을 저장'));
  await page.evaluate(()=>window.settingsPage.close());
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'파일 첨부',exact:true}).click();
  await (await chooser).setFiles({name:'dummy.csv',mimeType:'text/csv',buffer:Buffer.from('이름,휴대폰\n홍길동,010-1234-2324')});
  const id=n=>n.toString(16).padStart(32,'0');
  await page.waitForFunction(()=>window.materialGuard.selected().length===1);
  await page.locator('#attachment-chips .attachment-title').click();
  await page.getByRole('button',{name:'전송할 내용 보기',exact:true}).click();await page.getByText('홍*동,010-****-2324',{exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#task-list button.task',{hasText:/^B$/}).click();assert.deepEqual(await page.evaluate(()=>window.materialGuard.selected()),[]);
  await page.locator('#task-list button.task',{hasText:/^A$/}).click();assert.deepEqual(await page.evaluate(()=>window.materialGuard.selected()),[id(1)]);
  assert.equal(await page.getByRole('button',{name:'보관된 첨부 자료',exact:true}).count(),0);
  await page.reload();await page.locator('#startup-loading').waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(()=>window.materialGuard.selected()),[id(1)]);
  await page.fill('#text','자료 요약');await Promise.all([page.waitForRequest(r=>r.url().endsWith('/chat')),page.locator('#send').click()]);
  assert.deepEqual(sent.material_ids,[id(1)]);assert.equal(sent.action,'run');assert.equal(sent.auto_route,false);
  await page.waitForFunction(()=>!document.getElementById('send').disabled);
  const drop=async()=>{
    const data=await page.evaluateHandle(()=>{const data=new DataTransfer();data.items.add(new File(['dummy'],'drop.txt',{type:'text/plain'}));return data;});
    await page.locator('#text').dispatchEvent('dragenter',{dataTransfer:data});
    assert.equal(await page.locator('#composer').evaluate(n=>n.classList.contains('attachment-dragover')),true);
    await page.locator('#text').dispatchEvent('drop',{dataTransfer:data});await data.dispose();
  };
  await drop();await page.waitForFunction(()=>window.materialGuard.selected().length===2);
  await page.getByRole('button',{name:'자료 2.csv 첨부 제거',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.materialGuard.selected()),[id(1)]);
  await page.locator('#attachment-chips .attachment-title').click();
  assert.equal(await page.locator('#guard-materials article').count(),1);
  assert.equal(await page.locator('#guard-materials input[type=checkbox]').count(),0);
  assert.equal(await page.getByRole('button',{name:'자료 삭제',exact:true}).count(),0);
  await page.keyboard.press('Escape');
  // Failure and blocked uploads never attach a raw fallback.
  fail=true;await drop();await page.getByText('지원하지 않는 파일입니다.',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.materialGuard.selected()),[id(1)]);
  block=true;await drop();await page.getByText(/개인키가 포함된 자료를 차단/).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.materialGuard.selected()),[id(1)]);
  // A late upload must not attach to the newly selected chat; sending waits for scanning.
  hold=true;await drop();await page.fill('#text','대기 중 요청');await page.locator('#send').click();
  await page.getByText('첨부 자료 검사 완료 후 보내세요.',{exact:true}).waitFor();
  await page.locator('#task-list button.task',{hasText:/^B$/}).click();assert.equal(typeof release,'function');release();
  await page.waitForFunction(()=>!window.materialGuard.isUploading());assert.deepEqual(await page.evaluate(()=>window.materialGuard.selected()),[]);
  await page.locator('#task-list button.task',{hasText:/^A$/}).click();
  assert.deepEqual(await page.evaluate(()=>window.materialGuard.selected()),[id(1)]);
  await page.evaluate(()=>window.settingsPage.open('materials'));
  await page.selectOption('#guard-level','allow');await page.getByRole('button',{name:'파일 보호 설정 저장',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#attachment-chips').textContent.includes('다시 첨부해 주세요'));
  await page.evaluate(()=>window.settingsPage.close());
  assert.match(await page.locator('#composer').innerText(),/보호 꺼짐/);
  await page.getByRole('button',{name:'자료 1.csv 첨부 제거',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.materialGuard.selected()),[]);
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>document.getElementById('workspace').classList.add('collapsed'));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  fs.mkdirSync('work/guard-browser',{recursive:true});await page.screenshot({path:'work/guard-browser/composer.png',fullPage:true});
  await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>window.settingsPage.open('materials'));
  await page.getByRole('heading',{name:'첨부 파일 보호',exact:true}).waitFor();
  await page.selectOption('#guard-level','strong');
  assert.doesNotMatch(await page.locator('#settings-page').innerText(),/·|전체 치환/);
  await page.screenshot({path:'work/guard-browser/protection-wording.png',fullPage:true});
  assert.deepEqual(errors,[]);console.log('PASS: plus picker, drag/drop, automatic attachment, preview/remove, per-chat restore, forced execution, failure/block, upload race, allow indicator and narrow layout.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
