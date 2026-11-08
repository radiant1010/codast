// #15 CV-2 acceptance: file references in answers open the read-only code viewer panel.
// Run: NODE_PATH="$APPDATA/npm/node_modules" node tests/browser/code-viewer.cjs
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');

const lines=count=>Array.from({length:count},(_,i)=>`line ${i+1}`).join('\n')+'\n';
const markdown=[
 '변경한 곳은 `app/llm/cli.py:18`입니다.',
 '자세한 위치는 [cli.py:5](app/llm/cli.py:5)와 `app/llm/cli.py:20-22`, `app/llm/cli.py:99`를 보세요.',
 '같은 이름 파일은 `ExampleService.java:3`, 큰 파일은 `data/big.json:1`입니다.',
 '파일이 아닌 코드: `os.path`, `uv run start.py`.',
 '```text\napp/llm/cli.py:18\n```',
 '[설명 문서](https://example.com/docs)',
].join('\n\n');
const MAIN='src/main/java/com/example/ExampleService.java',TEST='src/test/java/com/example/ExampleService.java';
const projects={
 sample:{files:{'app/llm/cli.py':lines(40),[MAIN]:lines(10),[TEST]:lines(10),'README.md':'# readme\n','data/big.json':null},
  resolve:{'app/llm/cli.py':{path:'app/llm/cli.py'},'ExampleService.java':{candidates:[MAIN,TEST],truncated:false},'data/big.json':{path:'data/big.json'},'README.md':{path:'README.md'}}},
 other:{files:{'other-root.md':'# other\n'},resolve:{}},
};
const BIG='파일이 커서 앱에서 볼 수 없습니다. IDE에서 열기를 사용하세요.';
function entries(files,folder){
 const prefix=folder?folder+'/':'',seen=new Map();
 for(const file of Object.keys(files)){
  if(!file.startsWith(prefix))continue;
  const rest=file.slice(prefix.length).split('/');seen.set(rest[0],rest.length>1?'dir':'file');
 }
 return [...seen].map(([name,type])=>({name,type})).sort((a,b)=>(a.type===b.type?0:a.type==='dir'?-1:1)||a.name.localeCompare(b.name,undefined,{sensitivity:'base'}));
}

(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],external=[],requests=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(!request.url().startsWith('http://harness.test/'))external.push(request.url());});
  await page.route('http://harness.test/**',route=>{
   const url=new URL(route.request().url()),path=url.pathname;
   if(path==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync('app/web/templates/index.html','utf8')});
   if(path.startsWith('/static/'))return route.fulfill({contentType:path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':path.endsWith('.woff2')?'font/woff2':'application/javascript',body:fs.readFileSync('app/web'+path)});
   const code=path.match(/^\/api\/projects\/(sample|other)\/code\/(tree|resolve|file|refresh)$/);
   if(code){
    const [,name,kind]=code,project=projects[name];requests.push(`${name} ${kind} ${url.searchParams.get('path')??url.searchParams.get('ref')??''}`);
    if(kind==='tree')return route.fulfill({json:{path:url.searchParams.get('path')||'',entries:entries(project.files,url.searchParams.get('path')||''),truncated:false}});
    if(kind==='refresh')return route.fulfill({json:{started:true}});
    if(kind==='resolve'){const reply=project.resolve[url.searchParams.get('ref')];return reply?route.fulfill({json:reply}):route.fulfill({status:404,json:{detail:'파일을 찾을 수 없습니다.'}});}
    const file=url.searchParams.get('path'),content=project.files[file];
    if(content===null)return route.fulfill({status:400,json:{detail:BIG}});
    if(content===undefined)return route.fulfill({status:404,json:{detail:'파일을 찾을 수 없습니다.'}});
    return route.fulfill({json:{path:file,content,encoding:'utf-8',size:Buffer.byteLength(content)}});
   }
   const chat={task:'코드 참조 확인',id:'a'.repeat(32),status:'active',count:1};
   const replies={
    '/api/onboarding':{status:'deferred',project:'sample'},'/api/projects':{projects:['sample','other']},
    '/api/clients':{clients:[]},'/api/clients/codex/status':{state:'available',models:[],limits:[]},
    '/api/notifications':{events:[],cursor:0,has_more:false},'/api/session-overview':{sessions:[],running:[],usage:[]},
    '/api/projects/sample/settings':{client:'codex',mode:'read-only',cwd:'.',context_paths:[]},
    '/api/projects/other/settings':{client:'codex',mode:'read-only',cwd:'.',context_paths:[]},
    '/api/projects/sample/workspace':{path:'C:/fixture/sample'},'/api/projects/other/workspace':{path:'C:/fixture/other'},
    '/api/projects/sample/tasks':{tasks:[chat]},'/api/projects/other/tasks':{tasks:[]},
    '/api/projects/sample/messages':{messages:[{id:1,task:chat.task,text:'코드 위치를 알려 주세요.',created_at:'2026-11-08T08:00:00Z',run_id:'fixture-code-ref',status:'completed',adapter:'codex',output:markdown,metadata:{}}]},
    '/api/projects/other/messages':{messages:[]},'/api/clients/claude/status':{state:'available',models:[],limits:[]},
   };
   for(const name of Object.keys(projects))Object.assign(replies,{
    [`/api/projects/${name}/runs`]:{runs:[]},[`/api/projects/${name}/questions`]:{messages:[]},
    [`/api/projects/${name}/rules`]:{rules:[]},[`/api/projects/${name}/materials`]:{materials:[]},
    [`/api/projects/${name}/guard`]:{level:'strong',privacy_mode:'replace',fields:[]},[`/api/projects/${name}/work-items`]:{items:[]},
    [`/api/projects/${name}/environment`]:{git:{state:'available',branch:'main'},ports:{values:[]},docker:{state:'available',containers:[]}},
   });
   return route.fulfill({json:replies[path]||{}});
  });

  await page.goto('http://harness.test/');await page.locator('#startup-loading').waitFor({state:'hidden'});
  await page.evaluate(id=>{location.hash='#chat/'+id;},'a'.repeat(32));
  await page.locator('.answer>.console-output').first().waitFor();await page.waitForFunction(()=>!chatLoading&&!!filter);
  const answer=page.locator('.answer>.console-output'),refs=answer.locator('button.code-ref');
  const panel=page.locator('aside#code-viewer'),status=panel.locator('[role="status"]');
  const tree=panel.getByRole('navigation',{name:'프로젝트 폴더'}),title=panel.locator('h2');
  const target=n=>panel.locator(`.code-line[data-line="${n}"].is-target`);
  const fileReads=()=>requests.filter(item=>item==='sample file app/llm/cli.py').length;

  // Recognition: inline code and file links become buttons; other code and web links do not.
  assert.deepEqual(await refs.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label'))),[
   '코드 보기 app/llm/cli.py:18','코드 보기 cli.py:5','코드 보기 app/llm/cli.py:20-22','코드 보기 app/llm/cli.py:99',
   '코드 보기 ExampleService.java:3','코드 보기 data/big.json:1']);
  assert.equal(await refs.first().innerText(),'app/llm/cli.py:18');
  assert.deepEqual(await answer.evaluate(node=>[...node.querySelectorAll('code')].filter(code=>/os\.path|uv run|cli\.py:18/.test(code.textContent)&&!code.closest('button')).map(code=>code.textContent)),
   ['os.path','uv run start.py','app/llm/cli.py:18\n'],'non-file inline code and code blocks must stay plain');
  assert.equal(await answer.getByRole('link',{name:'설명 문서'}).getAttribute('href'),'https://example.com/docs');
  assert.equal(await panel.isVisible(),false,'panel starts closed');

  // Open a reference: panel, title, highlighted line in view, tree expanded to the file.
  await refs.nth(0).click();await target(18).waitFor();
  assert.equal(await panel.getAttribute('aria-label'),'코드 보기');
  assert.equal((await title.innerText()).trim(),'app/llm/cli.py');
  assert.equal(await panel.locator('.code-line').count(),40);
  assert.equal(await panel.locator('.code-line.is-target').count(),1);
  const box=await target(18).boundingBox(),view=page.viewportSize();
  assert.ok(box&&box.y>=0&&box.y+box.height<=view.height,'target line must be scrolled into view');
  assert.equal(await tree.getByRole('button',{name:'cli.py',exact:true}).getAttribute('aria-current'),'true');
  for(const folder of ['app','llm'])assert.equal(await tree.getByRole('button',{name:folder,exact:true}).getAttribute('aria-expanded'),'true',folder);
  assert.equal(fileReads(),1);

  // Every click reads the file again; ranges highlight every line.
  await refs.nth(1).click();await target(5).waitFor();
  assert.equal(fileReads(),2,'each reference click re-reads the file');
  await refs.nth(2).click();await target(22).waitFor();
  assert.deepEqual(await panel.locator('.code-line.is-target').evaluateAll(nodes=>nodes.map(node=>node.dataset.line)),['20','21','22']);

  // Hand the location back to the composer.
  await page.locator('#text').fill('');
  await panel.getByRole('button',{name:'참조를 입력창에 넣기',exact:true}).click();
  assert.match(await page.locator('#text').inputValue(),/app\/llm\/cli\.py:20-22/);
  await panel.locator('.code-line[data-line="7"] .line-number').click();
  assert.match(await page.locator('#text').inputValue(),/app\/llm\/cli\.py:7/);

  // A line past the end still opens the file and says so.
  await refs.nth(3).click();await page.waitForFunction(()=>/99/.test(document.querySelector('#code-viewer [role="status"]')?.textContent||''));
  assert.match(await status.innerText(),/40/);
  assert.equal(await panel.locator('.code-line.is-target').count(),0);
  assert.equal(await panel.locator('.code-line').count(),40);

  // Duplicate names: choose from candidates.
  await refs.nth(4).click();
  const candidates=panel.getByRole('list',{name:'같은 이름의 파일'});await candidates.waitFor();
  assert.deepEqual(await candidates.getByRole('button').allInnerTexts(),[MAIN,TEST]);
  await candidates.getByRole('button',{name:TEST,exact:true}).click();await target(3).waitFor();
  assert.equal((await title.innerText()).trim(),TEST);

  // Server refusal is shown in the panel.
  await refs.nth(5).click();await page.waitForFunction(text=>(document.querySelector('#code-viewer [role="status"]')?.textContent||'').includes(text),BIG);

  // Folder tree: collapse, expand, open a file from the tree.
  await panel.getByRole('button',{name:'폴더 트리 접기',exact:true}).click();
  assert.equal(await tree.isVisible(),false);
  await panel.getByRole('button',{name:'폴더 트리 펼치기',exact:true}).click();
  assert.equal(await tree.isVisible(),true);
  await tree.getByRole('button',{name:'README.md',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#code-viewer h2')?.textContent.trim()==='README.md'&&document.querySelectorAll('#code-viewer .code-line').length===1);

  // Widen over the chat and back.
  await panel.getByRole('button',{name:'넓히기',exact:true}).click();
  assert.match(await panel.getAttribute('class'),/\bis-expanded\b/);
  assert.equal(await page.locator('#console').isVisible(),false);
  await panel.getByRole('button',{name:'원래 크기',exact:true}).click();
  assert.doesNotMatch(await panel.getAttribute('class')||'',/\bis-expanded\b/);
  assert.equal(await page.locator('#console').isVisible(),true);

  // Esc closes and returns focus to the reference that opened the panel.
  await refs.nth(0).click();await target(18).waitFor();
  await panel.getByRole('button',{name:'새로고침',exact:true}).focus();await page.keyboard.press('Escape');
  assert.equal(await panel.isVisible(),false);
  assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('.answer button.code-ref')),true);

  // Narrow screen: full-screen panel, no horizontal scroll, no widen button.
  await page.setViewportSize({width:390,height:844});
  await refs.nth(0).click();await target(18).waitFor();
  const narrow=await panel.boundingBox();
  assert.ok(narrow&&narrow.x<=1&&narrow.width>=388,'panel fills a narrow screen');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await panel.getByRole('button',{name:'넓히기',exact:true}).isVisible(),false);
  await panel.getByRole('button',{name:'코드 보기 닫기',exact:true}).click();
  assert.equal(await panel.isVisible(),false);
  await page.setViewportSize({width:1280,height:900});

  // Switching project keeps the panel and moves the tree to the new project.
  await refs.nth(0).click();await target(18).waitFor();
  await page.evaluate(()=>{const select=document.getElementById('project');select.value='other';select.dispatchEvent(new Event('change'));});
  await tree.getByRole('button',{name:'other-root.md',exact:true}).waitFor();
  assert.equal(await panel.isVisible(),true);
  assert.equal(await panel.locator('.code-line').count(),0,'code from the previous project must be cleared');
  assert.ok(requests.includes('other tree '),'tree must load the new project root');

  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  console.log('PASS: code references, viewer panel, highlight, candidates, errors, tree, widen, Esc focus, narrow layout, project switch');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
