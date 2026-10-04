const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const preparedRows=new Map();
  let options={level:'strong',fields:[]},rows=[],savedMessages=[],missingPreview=false,sent,serial=0,holdAfter=0,hold=false,release,fail=false,failChat=false,block=false;
  await page.route('http://localhost/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname;
   if(path==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync('app/web/templates/index.html','utf8')});
   if(path.startsWith('/static/'))return route.fulfill({contentType:path.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync('app/web'+path)});
   const resource=path.replace('/api/projects/one/','');
   if(resource==='guard'){if(req.method()==='PUT'){options=req.postDataJSON();rows=rows.map(r=>({...r,stale:true}));}return route.fulfill({json:options});}
   if(resource==='materials')return route.fulfill({json:{materials:rows}});
   if(resource.startsWith('material-preparations/')){const token=resource.split('/')[1];if(req.method()==='DELETE'){preparedRows.delete(token);return route.fulfill({json:{cancelled:true}});}const row=preparedRows.get(token);preparedRows.delete(token);rows.unshift(row);return route.fulfill({status:201,json:row});}
   if(resource==='material-preparations'){
    if(req.method()==='POST'){if(holdAfter&&--holdAfter===0)hold=true;if(hold){hold=false;await new Promise(done=>release=done);}if(fail){fail=false;return route.fulfill({status:400,json:{detail:'지원하지 않는 파일입니다.'}});}const row={id:(++serial).toString(16).padStart(32,'0'),label:'자료 '+serial+'.csv',level:options.level,privacy_mode:options.privacy_mode,rule_version:'fixture',status:block?'blocked':'ready',findings:[{location:'R2C1',kind:'name',action:'masked',count:1}],omissions:[],test_data:true};block=false;preparedRows.set(row.id,row);return route.fulfill({status:201,json:{token:row.id}});}
    return route.fulfill({json:{materials:rows}});
   }
   if(resource.startsWith('materials/'))return missingPreview?route.fulfill({status:404,json:{detail:'자료를 찾을 수 없습니다.'}}):route.fulfill({json:{content:'홍*동,010-****-2324'}});
   if(resource==='messages')return route.fulfill({json:{messages:new URL(req.url()).searchParams.get('chat_id')==='a'.repeat(32)?savedMessages:[]}});
   if(resource==='chat'){if(failChat){failChat=false;return route.fulfill({status:503,json:{detail:'전송 실패 테스트'}});}sent=req.postDataJSON();savedMessages.unshift({task:'A',created_at:'2026-09-20T00:00:00Z',text:sent.text,run_id:'run',adapter:'codex',status:'completed',output:'테스트 완료',metadata:{guard:{state:'dispatch_attempted',materials:rows.filter(row=>sent.material_ids.includes(row.id))}}});return route.fulfill({json:{run_id:'run',action:'run',routing:{task:'A',kind:'explicit'}}});}
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
  await page.getByText('엑셀에서 보낼 시트와 열 선택',{exact:true}).click();
  await page.getByRole('button',{name:'엑셀 시트 선택 추가',exact:true}).click();
  await page.getByLabel('시트 번호',{exact:true}).fill('1');
  await page.getByLabel('보낼 열',{exact:true}).fill('A:C');
  await page.getByRole('button',{name:'파일 보호 설정 저장',exact:true}).click();
  await page.locator('#guard-save-status').filter({hasText:'열은 A, C, D처럼 쉼표로 구분하세요'}).waitFor();
  assert.equal(options.excel_sheets,undefined);
  await page.getByLabel('보낼 열',{exact:true}).fill('C, a, A');
  await page.locator('#guard-test-data').check();await page.selectOption('#guard-privacy-mode','partial');await page.getByRole('button',{name:'파일 보호 설정 저장',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('파일 보호 설정을 저장'));
  assert.deepEqual(options.excel_sheets,[{sheet:1,columns:[1,3]}]);assert.equal(options.privacy_mode,'partial');assert.equal(options.level,'strong');assert.equal(options.test_data,true);
  assert.equal(await page.getByLabel('보낼 열',{exact:true}).inputValue(),'A, C');assert.equal(await page.locator('#guard-test-data').isChecked(),true);
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
  failChat=true;await page.fill('#text','자료 요약');await page.locator('#send').click();await page.getByText('전송 실패 테스트',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.materialGuard.selected()),[id(1)]);
  await page.waitForFunction(()=>!document.getElementById('send').disabled);
  await page.fill('#text','자료 요약');await Promise.all([page.waitForRequest(r=>r.url().endsWith('/chat')),page.locator('#send').click()]);
  assert.deepEqual(sent.material_ids,[id(1)]);assert.equal(sent.action,'run');assert.equal(sent.auto_route,false);
  await page.waitForFunction(()=>!document.getElementById('send').disabled);
  assert.deepEqual(await page.evaluate(()=>window.materialGuard.selected()),[]);
  await page.reload();await page.locator('#startup-loading').waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(()=>window.materialGuard.selected()),[]);
  await page.locator('#messages .sent-attachments .attachment-title').click();
  await page.locator('#sent-attachment-dialog pre').filter({hasText:'홍*동,010-****-2324'}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.materialGuard.selected()),[]);
  await page.keyboard.press('Escape');missingPreview=true;
  await page.locator('#messages .sent-attachments .attachment-title').click();
  await page.locator('#sent-attachment-dialog').getByText(/첨부 내용을 불러오지 못했습니다/).waitFor();
  await page.keyboard.press('Escape');missingPreview=false;
  await page.locator('#task-list button.task',{hasText:/^B$/}).click();assert.equal(await page.locator('#messages .sent-attachments .attachment-title').count(),0);
  await page.locator('#task-list button.task',{hasText:/^A$/}).click();await page.locator('#messages .sent-attachments .attachment-title').waitFor();assert.equal(await page.locator('#messages .sent-attachments .attachment-title').count(),1);
  await page.fill('#text','후속 질문');await Promise.all([page.waitForRequest(r=>r.url().endsWith('/chat')),page.locator('#send').click()]);
  assert.deepEqual(sent.material_ids,[]);
  await page.waitForFunction(()=>!document.getElementById('send').disabled);
  // Restore a fixture selection for the independent upload failure/race cases below.
  await page.evaluate(value=>window.materialGuard.restore('one',[value]),id(1));
  await page.waitForResponse(r=>r.url().includes('/materials'));
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
  // Cancelling an in-flight preparation never reaches the commit route.
  const storedBeforeCancel=rows.length;
  hold=true;await drop();
  await page.locator('#attachment-progress').filter({hasText:'1 / 1 파일 전달 및 검사 중'}).waitFor();
  await page.getByRole('button',{name:'첨부 처리 취소',exact:true}).click();
  await page.waitForFunction(()=>!window.materialGuard.isUploading());
  release();
  await page.getByText(/첨부 처리를 취소했습니다/).waitFor();
  assert.equal(rows.length,storedBeforeCancel);
  assert.deepEqual(await page.evaluate(()=>window.materialGuard.selected()),[id(1)]);
  // A late upload must not attach to the newly selected chat; sending waits for scanning.
  hold=true;await drop();await page.fill('#text','대기 중 요청');await page.locator('#send').click();
  await page.getByText('첨부 자료 검사 완료 후 보내세요.',{exact:true}).waitFor();
  await page.locator('#task-list button.task',{hasText:/^B$/}).click();assert.equal(typeof release,'function');release();
  await page.waitForFunction(()=>!window.materialGuard.isUploading());assert.deepEqual(await page.evaluate(()=>window.materialGuard.selected()),[]);
  await page.locator('#task-list button.task',{hasText:/^A$/}).click();
  assert.deepEqual(await page.evaluate(()=>window.materialGuard.selected()),[id(1)]);
  await page.evaluate(()=>window.settingsPage.open('materials'));
  assert.equal(await page.getByLabel('보낼 열',{exact:true}).inputValue(),'A, C');
  await page.locator('#guard-excel-sheets').evaluate(n=>n.closest('details').open=true);
  await page.getByRole('button',{name:'엑셀 시트 선택 추가',exact:true}).click();
  await page.getByLabel('시트 번호',{exact:true}).nth(1).fill('1');
  await page.getByRole('button',{name:'파일 보호 설정 저장',exact:true}).click();
  await page.locator('#guard-save-status').filter({hasText:'시트 번호는 1부터 1000까지 중복 없이 입력하세요.'}).waitFor();
  assert.equal(options.excel_sheets.length,1);
  await page.getByRole('button',{name:'엑셀 시트 선택 삭제',exact:true}).nth(1).click();
  await page.selectOption('#guard-level','allow');await page.getByRole('button',{name:'파일 보호 설정 저장',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#attachment-chips').textContent.includes('다시 첨부해 주세요'));
  await page.evaluate(()=>window.settingsPage.close());
  assert.match(await page.locator('#composer').innerText(),/키: 원본/);
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
  assert.deepEqual(await page.locator('#guard-privacy-mode option').allTextContents(),['완전 변경','일부 마스킹 (qwe***)','원본 그대로']);
  await page.selectOption('#guard-privacy-mode','raw');await page.getByRole('button',{name:'파일 보호 설정 저장',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#attachment-chips').parentElement.textContent.includes('개인정보: 원본 그대로'));
  assert.equal(options.level,'strong');assert.equal(options.privacy_mode,'raw');
  await page.screenshot({path:'work/guard-browser/protection-wording.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.locator('#guard-excel-sheets').evaluate(n=>n.closest('details').open=true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.getByLabel('보낼 열',{exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:'work/guard-browser/excel-selection-narrow.png',fullPage:true});
  await page.evaluate(()=>{
   window.settingsPage.close();
   window.testStreams=[];window.EventSource=class{constructor(){this.handlers={};window.testStreams.push(this);}addEventListener(name,fn){this.handlers[name]=fn;}close(){}};
   document.getElementById('messages').replaceChildren(messageCard({task:'콘솔 표시 확인',created_at:'2026-09-20T00:00:00Z',text:'첨부 자료 확인',run_id:'console-test',adapter:'codex',status:'completed',metadata:{elapsed_seconds:12,history_count:2,resumed:true,usage:{input_tokens:120,output_tokens:30}},output:'```text\n이름: [이름]\n아이디: qwe***\n  들여쓰기 유지\n<img src=x onerror=alert(1)>\n```'},'/projects/one'));
  });
  const output=page.locator('.answer>pre.console-output');
  assert.equal(await output.textContent(),'이름: [이름]\n아이디: qwe***\n  들여쓰기 유지\n<img src=x onerror=alert(1)>');
  assert.equal(await output.locator('img').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:'work/guard-browser/console-narrow.png',fullPage:true});
  await page.setViewportSize({width:1280,height:900});
  await page.screenshot({path:'work/guard-browser/console-desktop.png',fullPage:true});
  const bubble=page.locator('.message>pre.user');
  assert.equal(await bubble.evaluate(n=>getComputedStyle(n,'::before').content),'none');
  assert.ok(await bubble.evaluate(n=>Math.abs(n.getBoundingClientRect().right-n.parentElement.getBoundingClientRect().right)<2));
  const originalRequest=await bubble.textContent();
  const longRequest='첫 번째 줄\n두 번째 줄 <script>그대로 표시</script>\n'+'긴메시지'.repeat(100);
  await bubble.evaluate((n,text)=>n.textContent=text,longRequest);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await bubble.textContent(),longRequest);
  assert.equal(await bubble.locator('script').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await bubble.scrollIntoViewIfNeeded();
  await page.screenshot({path:'work/guard-browser/user-bubble-narrow.png',fullPage:true});
  await bubble.evaluate((n,text)=>n.textContent=text,originalRequest);
  await page.setViewportSize({width:1280,height:900});

  const details=page.locator('.answer>.run-details');
  assert.equal(await details.locator('summary').textContent(),'Codex, 완료, 12초, 토큰 사용량 150개');
  assert.equal(await page.locator('.message>h3,.answer>h3').count(),0);
  assert.doesNotMatch(await page.locator('.answer').textContent(),/참고한 대화는|초가 걸렸습니다/);
  assert.equal(await details.evaluate(n=>n.open),false);
  assert.equal(await page.evaluate(()=>window.testStreams.length),0);
  assert.equal(await details.evaluate(n=>n.getBoundingClientRect().bottom<=n.nextElementSibling.getBoundingClientRect().top),true);
  await details.locator('summary').focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.testStreams.length===1);
  assert.equal(await details.locator('.run-usage').isVisible(),true);
  await page.evaluate(()=>window.testStreams[0].handlers.run_event({data:JSON.stringify({seq:1,kind:'assistant',text:'기록 확인\n'.repeat(100)})}));
  assert.ok(await details.locator('.run-details-body').evaluate(n=>n.getBoundingClientRect().height<=240));
  await details.locator('summary').click();await details.locator('summary').click();
  assert.equal(await page.evaluate(()=>window.testStreams.length),1);
  await page.screenshot({path:'work/guard-browser/run-details-expanded.png',fullPage:true});
  await details.locator('summary').click();

  // Keep the first completed file when the second file in a batch is cancelled.
  const beforeBatch=rows.length;
  holdAfter=2;
  await page.locator('#attachment-picker').setInputFiles([
   {name:'one.txt',mimeType:'text/plain',buffer:Buffer.from('first')},
   {name:'two.txt',mimeType:'text/plain',buffer:Buffer.from('second')}
  ]);
  await page.locator('#attachment-progress').filter({hasText:'2 / 2 파일 전달 및 검사 중'}).waitFor();
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:'work/guard-browser/upload-progress-narrow.png',fullPage:true});
  await page.getByRole('button',{name:'첨부 처리 취소',exact:true}).click();
  await page.waitForFunction(()=>!window.materialGuard.isUploading());release();
  await page.getByText(/이미 완료한 1개 파일은 유지합니다/).waitFor();
  assert.equal(rows.length,beforeBatch+1);
  assert.equal((await page.evaluate(()=>window.materialGuard.selected())).length,1);
  assert.deepEqual(errors,[]);console.log('PASS: plus picker, drag/drop, automatic attachment, preview/remove, per-chat restore, forced execution, failure/block, upload race, allow indicator and narrow layout.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
