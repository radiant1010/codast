// #15 IDE-2 acceptance: "open in IDE" from the code viewer, IDE choice dialog and the IDE settings page.
// Run: NODE_PATH="$APPDATA/npm/node_modules" node tests/browser/code-viewer-ide.cjs
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');

const lines=count=>Array.from({length:count},(_,i)=>`line ${i+1}`).join('\n')+'\n';
const markdown='수정 위치는 `app/llm/cli.py:18`와 `app/llm/cli.py:12:5`, `app/llm/cli.py:20-22`입니다.';
const VSCODE='C:\\Users\\fixture\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';
const IDEA='C:\\Program Files\\JetBrains\\IntelliJ IDEA 2025.3.2\\bin\\idea64.exe';
const FAIL='IDE 실행에 실패했습니다(종료 코드 3). 앱에서 코드를 확인하세요.';

(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],external=[],calls=[];
  const state={projectIde:null,ides:{vscode:{path:VSCODE,state:'detected'},intellij:{path:null,state:'missing'}},failNextOpen:false};
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(!request.url().startsWith('http://harness.test/'))external.push(request.url());});
  await page.route('http://harness.test/**',route=>{
   const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
   if(path==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync('app/web/templates/index.html','utf8')});
   if(path.startsWith('/static/'))return route.fulfill({contentType:path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':path.endsWith('.woff2')?'font/woff2':'application/javascript',body:fs.readFileSync('app/web'+path)});
   const body=request.postData()?JSON.parse(request.postData()):undefined;
   if(path.startsWith('/api/ides')||path.startsWith('/api/projects/sample/ide'))calls.push({method,path,body});
   if(path==='/api/ides')return route.fulfill({json:{ides:[
    {ide:'vscode',label:'VS Code',path:state.ides.vscode.path,state:state.ides.vscode.state,candidates:state.ides.vscode.path?[state.ides.vscode.path]:[]},
    {ide:'intellij',label:'IntelliJ IDEA',path:state.ides.intellij.path,state:state.ides.intellij.state,candidates:state.ides.intellij.path?[state.ides.intellij.path]:[]}]}});
   if(path==='/api/ides/intellij/executable-picker')return route.fulfill({json:{path:IDEA}});
   const ideRoute=path.match(/^\/api\/ides\/(vscode|intellij)$/);
   if(ideRoute&&method==='PUT'){state.ides[ideRoute[1]]={path:body.path||null,state:body.path?'configured':'missing'};return route.fulfill({json:{ide:ideRoute[1],path:body.path}});}
   if(path==='/api/projects/sample/ide'){if(method==='PUT')state.projectIde=body.ide;return route.fulfill({json:{ide:state.projectIde}});}
   if(path==='/api/projects/sample/ide/open'){
    if(state.failNextOpen){state.failNextOpen=false;return route.fulfill({status:400,json:{detail:FAIL}});}
    return route.fulfill({json:{state:'requested'}});
   }
   if(path==='/api/projects/sample/code/tree')return route.fulfill({json:{path:url.searchParams.get('path')||'',entries:url.searchParams.get('path')==='app'?[{name:'llm',type:'dir'}]:url.searchParams.get('path')==='app/llm'?[{name:'cli.py',type:'file'}]:[{name:'app',type:'dir'}],truncated:false}});
   if(path==='/api/projects/sample/code/resolve')return route.fulfill({json:{path:'app/llm/cli.py'}});
   if(path==='/api/projects/sample/code/file')return route.fulfill({json:{path:'app/llm/cli.py',content:lines(40),encoding:'utf-8',size:400}});
   const chat={task:'IDE 열기 확인',id:'b'.repeat(32),status:'active',count:1};
   const replies={
    '/api/onboarding':{status:'deferred',project:'sample'},'/api/projects':{projects:['sample']},
    '/api/clients':{clients:[]},'/api/clients/codex/status':{state:'available',models:[],limits:[]},'/api/clients/claude/status':{state:'available',models:[],limits:[]},
    '/api/notifications':{events:[],cursor:0,has_more:false},'/api/session-overview':{sessions:[],running:[],usage:[]},
    '/api/projects/sample/settings':{client:'codex',mode:'read-only',cwd:'.',context_paths:[]},'/api/projects/sample/workspace':{path:'C:/fixture/sample'},
    '/api/projects/sample/tasks':{tasks:[chat]},
    '/api/projects/sample/messages':{messages:[{id:1,task:chat.task,text:'IDE로 열어 주세요.',created_at:'2026-11-08T08:00:00Z',run_id:'fixture-ide',status:'completed',adapter:'claude',output:markdown,metadata:{}}]},
    '/api/projects/sample/runs':{runs:[]},'/api/projects/sample/questions':{messages:[]},'/api/projects/sample/rules':{rules:[]},
    '/api/projects/sample/materials':{materials:[]},'/api/projects/sample/guard':{level:'strong',privacy_mode:'replace',fields:[]},
    '/api/projects/sample/work-items':{items:[]},
    '/api/projects/sample/environment':{git:{state:'available',branch:'main'},ports:{values:[]},docker:{state:'available',containers:[]}},
   };
   return route.fulfill({json:replies[path]||{}});
  });

  await page.goto('http://harness.test/');await page.locator('#startup-loading').waitFor({state:'hidden'});
  await page.evaluate(id=>{location.hash='#chat/'+id;},'b'.repeat(32));
  await page.locator('.answer>.console-output').first().waitFor();await page.waitForFunction(()=>!chatLoading&&!!filter);
  const refs=page.locator('.answer button.code-ref'),panel=page.locator('aside#code-viewer'),status=panel.locator('[role="status"]');
  const opens=()=>calls.filter(call=>call.path==='/api/projects/sample/ide/open').map(call=>call.body);
  const until=async(check,message)=>{for(let i=0;i<60&&!(await check());i++)await page.waitForTimeout(50);assert.ok(await check(),message);};
  const dialog=page.getByRole('dialog',{name:'IDE 선택'});

  // No IDE chosen yet: the button is generic and asks which IDE to use, then opens right away.
  assert.equal(await refs.count(),3,'CV-2 reference buttons are required before the IDE steps');
  await refs.nth(0).click();await panel.locator('.code-line[data-line="18"].is-target').waitFor();
  const generic=panel.getByRole('button',{name:'IDE에서 열기',exact:true});
  await generic.click();await dialog.waitFor();
  const vscodeOption=dialog.getByRole('button',{name:/^VS Code(?! 경로 지정)/}),ideaOption=dialog.getByRole('button',{name:/^IntelliJ IDEA(?! 경로 지정)/});
  await until(async()=>/Microsoft VS Code\\Code\.exe/.test(await dialog.innerText()),'detected VS Code path is shown');
  const spills=()=>dialog.locator('button').evaluateAll(buttons=>buttons.filter(button=>{
   const box=button.getBoundingClientRect();
   return button.scrollHeight>button.clientHeight+1||[...button.querySelectorAll('*')].some(child=>{const inner=child.getBoundingClientRect();return inner.bottom>box.bottom+1||inner.right>box.right+1;});
  }).map(button=>button.textContent.trim().slice(0,40)));
  assert.deepEqual(await spills(),[],'a long wrapped IDE path stays inside its option button');
  assert.equal(await ideaOption.isDisabled(),true,'a missing IDE cannot be chosen');
  assert.ok(await dialog.getByRole('button',{name:'IntelliJ IDEA 경로 지정',exact:true}).isVisible());
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(),false);
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')||document.activeElement?.textContent.trim()),'IDE에서 열기','Esc returns focus to the IDE button');
  assert.deepEqual(opens(),[],'closing the dialog must not open anything');
  await generic.click();await dialog.waitFor();await vscodeOption.click();
  await page.waitForFunction(()=>(document.querySelector('#code-viewer [role="status"]')?.textContent||'').includes('요청을 보냈습니다'));
  assert.deepEqual(calls.find(call=>call.method==='PUT'&&call.path==='/api/projects/sample/ide').body,{ide:'vscode'});
  assert.deepEqual(opens(),[{path:'app/llm/cli.py',line:18,column:null}]);
  assert.match(await status.innerText(),/IDE 창을 확인/);

  // Chosen IDE: the button names it and opens without asking; column and range start are sent.
  const vscodeButton=panel.getByRole('button',{name:'VS Code에서 열기',exact:true});
  await refs.nth(1).click();await panel.locator('.code-line[data-line="12"].is-target').waitFor();
  await vscodeButton.click();await until(()=>opens().length===2,'second open request');
  assert.deepEqual(opens().at(-1),{path:'app/llm/cli.py',line:12,column:5});
  assert.equal(await dialog.isVisible(),false);
  await refs.nth(2).click();await panel.locator('.code-line[data-line="22"].is-target').waitFor();
  await vscodeButton.click();await until(()=>opens().length===3,'third open request');
  assert.deepEqual(opens().at(-1),{path:'app/llm/cli.py',line:20,column:null});

  // Launch failure: the message is shown and the code stays in the panel.
  state.failNextOpen=true;await vscodeButton.click();
  await page.waitForFunction(text=>(document.querySelector('#code-viewer [role="status"]')?.textContent||'').includes(text),FAIL);
  assert.equal(await panel.locator('.code-line').count(),40);

  // Switch to IntelliJ: set its path through the picker, choose it, and the button follows (saving only, no open).
  await panel.getByRole('button',{name:'다른 IDE 선택',exact:true}).click();await dialog.waitFor();
  await dialog.getByRole('button',{name:'IntelliJ IDEA 경로 지정',exact:true}).click();
  await until(async()=>!(await ideaOption.isDisabled()),'IntelliJ becomes selectable after its path is set');
  assert.equal(await dialog.isVisible(),true,'the dialog stays open after setting a path');
  assert.deepEqual(await spills(),[],'both long IDE paths stay inside their option buttons');
  assert.ok(calls.some(call=>call.method==='POST'&&call.path==='/api/ides/intellij/executable-picker'));
  assert.deepEqual(calls.find(call=>call.method==='PUT'&&call.path==='/api/ides/intellij').body,{path:IDEA});
  await ideaOption.click();
  await panel.getByRole('button',{name:'IntelliJ IDEA에서 열기',exact:true}).waitFor();
  assert.equal(state.projectIde,'intellij');
  assert.equal(opens().length,4,'changing the IDE from the menu saves the choice without opening');

  // Settings page lists both IDEs, their paths and the same-PC note.
  await page.evaluate(()=>{location.hash='#settings/ides';});
  const settings=page.locator('#settings-page');await settings.getByRole('heading',{name:'IDE 연결'}).waitFor();
  const expectedSettings=['VS Code','IntelliJ IDEA',VSCODE,IDEA,'CODAST 서버와 같은 PC'];
  await until(async()=>{const text=await settings.innerText();return expectedSettings.every(expected=>text.includes(expected));},'settings page lists both IDEs, their paths and the same-PC note');

  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  console.log('PASS: IDE choice dialog, open requests with line and column, failure message, IDE switch with picker, settings page');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
