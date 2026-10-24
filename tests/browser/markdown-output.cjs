const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const markdown=[
 '# 작업 결과',
 '입력 화면을 정리했습니다. **필수 항목**을 먼저 확인하고 `uv run start.py`로 실행하세요.',
 '## 변경 사항',
 '- 한글 이름과 긴 설명을 읽기 편하게 표시합니다.\n- 작업 결과와 다음 행동을 구분합니다.',
 '| 항목 | 이전 | 변경 후 |\n| --- | --- | --- |\n| 안내 | 계속 표시 | 4초 후 닫힘 |\n| 이름 | 영문만 허용 | 한글도 허용 |',
 '> 작성 중인 내용은 이 브라우저에 보관됩니다.',
 '## 실행 예시',
 '```python\ndef greet(name):\n    return f"안녕하세요, {name}"\n\nprint(greet("사용자"))\n```',
 '1. 프로젝트를 선택합니다.\n2. 결과를 확인합니다.',
 '- [x] 화면 확인\n- [ ] 실제 작업에서 확인',
 '[설명 문서](https://example.com/docs)에서 더 확인할 수 있습니다.',
].join('\n\n');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'msedge'});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[],external=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(!request.url().startsWith('http://harness.test/'))external.push(request.url());});
  await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedCode=text;}}}));
  await page.route('http://harness.test/**',route=>{
   const path=new URL(route.request().url()).pathname;
   if(path==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync('app/web/templates/index.html','utf8')});
   if(path.startsWith('/static/'))return route.fulfill({contentType:path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':path.endsWith('.woff2')?'font/woff2':'application/javascript',body:fs.readFileSync('app/web'+path)});
   const replies={
    '/api/onboarding':{status:'deferred',project:'sample'},'/api/projects':{projects:['sample']},
    '/api/clients':{clients:[]},'/api/clients/codex/status':{state:'available',models:[],limits:[]},
    '/api/notifications':{events:[],cursor:0,has_more:false},'/api/session-overview':{sessions:[],running:[],usage:[]},
    '/api/projects/sample/settings':{client:'codex',mode:'read-only',cwd:'.',context_paths:[]},
    '/api/projects/sample/workspace':{path:'C:/fixture/sample'},
    '/api/projects/sample/tasks':{tasks:[{task:'마크다운 표시 확인',id:'a'.repeat(32),status:'active',count:1}]},
    '/api/projects/sample/messages':{messages:[{id:1,task:'마크다운 표시 확인',text:'화면 개선 결과를 정리해 주세요.',created_at:'2026-10-24T08:00:00Z',run_id:'fixture-markdown',status:'completed',adapter:'codex',output:markdown,metadata:{}}]},
    '/api/projects/sample/environment':{git:{state:'available',branch:'main'},ports:{values:[]},docker:{state:'available',containers:[]}},
    '/api/projects/sample/runs':{runs:[]},'/api/projects/sample/questions':{messages:[]},
    '/api/projects/sample/rules':{rules:[]},'/api/projects/sample/materials':{materials:[]},
    '/api/projects/sample/guard':{level:'strong',privacy_mode:'replace',fields:[]},
   };
   return route.fulfill({json:replies[path]||{}});
  });
  await page.goto('http://harness.test/');await page.locator('#startup-loading').waitFor({state:'hidden'});
  await page.locator('#task-list .task').first().click();await page.waitForFunction(()=>!chatLoading&&!!filter);
  const answer=page.locator('.answer>.console-output');
  assert.equal(await answer.locator('h1').count(),1,'Markdown headings must render as headings');
  assert.equal(await answer.locator('h2').count(),2);
  assert.equal(await answer.locator('table tbody tr').count(),2);
  assert.equal(await answer.locator('blockquote').count(),1);
  assert.equal(await answer.locator('strong').innerText(),'필수 항목');
  assert.equal(await answer.evaluate(node=>node.consoleSource),markdown);
  await answer.getByRole('button',{name:'코드 복사',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.copiedCode),'def greet(name):\n    return f"안녕하세요, {name}"\n\nprint(greet("사용자"))\n');
  const link=answer.getByRole('link',{name:'설명 문서'});
  assert.equal(await link.getAttribute('target'),'_blank');assert.match(await link.getAttribute('rel'),/noreferrer/);
  fs.mkdirSync('docs/internal/screenshots',{recursive:true});
  await page.locator('#workspace-status > summary').click();
  for(const width of [1440,1200,640,480]){
   await page.setViewportSize({width,height:900});
   await page.locator('#messages').evaluate(node=>node.scrollTop=0);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight),false);
   assert.ok(await answer.evaluate(node=>parseFloat(getComputedStyle(node).fontSize)>=16));
   if(width===1200||width===640)await page.screenshot({path:`docs/internal/screenshots/markdown-${width}.png`});
  }
  await page.setViewportSize({width:640,height:900});
  await answer.locator('.markdown-code').scrollIntoViewIfNeeded();
  await answer.locator('.markdown-code').screenshot({path:'docs/internal/screenshots/markdown-code.png'});
  const safety=await page.evaluate(()=>{
   const raw='<script>window.markdownAttack=true</script>\n\n<img src="https://example.invalid/track" onerror="window.markdownAttack=true">\n\n[실행](javascript:alert(1)) [파일](file:///C:/private.txt) ![외부 이미지](https://example.invalid/image)\n\n```html\n<img src=x onerror=alert(1)>\n이름: [이름]\n아이디: qwe***\n```';
   const node=consoleOutput(raw);document.querySelector('#messages').append(node);
   return {source:node.consoleSource===raw,unsafe:node.querySelectorAll('script,img,iframe,svg,object,embed,[onerror],[onclick]').length,hrefs:[...node.querySelectorAll('a[href]')].map(a=>a.href),code:node.querySelector('pre code').textContent,executed:window.markdownAttack===true};
  });
  assert.equal(safety.source,true);assert.equal(safety.unsafe,0);assert.equal(safety.executed,false);
  assert.deepEqual(safety.hrefs,['https://example.invalid/image']);
  assert.match(safety.code,/<img src=x onerror=alert\(1\)>\n이름: \[이름\]\n아이디: qwe\*\*\*/);
  const streamed=await page.evaluate(()=>{
   let handlers;const previous=window.EventSource;
   window.EventSource=class{constructor(){handlers={};}addEventListener(name,fn){handlers[name]=fn;}close(){}};
   const node=document.createElement('div');document.querySelector('#messages').append(node);
   streamRun('fixture-stream',base(),node,false);
   const emit=(seq,text)=>handlers.run_event({data:JSON.stringify({seq,kind:'assistant',text})});
   emit(1,'## 진행 결과\n\n```python\nvalue = "qwe***"');
   const partial=node.querySelector('pre code')?.textContent;
   emit(2,'\n```\n\n**완료**');emit(2,'중복');
   const result={partial,heading:node.querySelector('h2')?.textContent,bold:node.querySelector('strong')?.textContent,source:node.firstElementChild.consoleSource};
   window.EventSource=previous;return result;
  });
  assert.equal(streamed.heading,'진행 결과');assert.match(streamed.partial,/qwe\*\*\*/);assert.equal(streamed.bold,'완료');assert.doesNotMatch(streamed.source,/중복/);
  await page.evaluate(()=>{
   const node=consoleOutput('| 열 | 긴 값 |\n| --- | --- |\n| 한글 | '+('긴값'.repeat(150))+' |\n\n```text\n'+('long_token_'.repeat(100))+'\n```');
   document.querySelector('#messages').replaceChildren(node);
  });
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||document.querySelector('#messages').scrollWidth>document.querySelector('#messages').clientWidth),false);
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  console.log('PASS: Markdown headings, lists, tables, code copy, raw source, streaming, safe links and HTML, no external images, narrow layout');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
