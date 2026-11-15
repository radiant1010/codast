// Real Edge UI with synthetic API fixtures. No live model/account or private document.
const fs=require('node:fs'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
let materials=[],uploads=[],tokens=new Map(),hold=false,held=null,serial=0;
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://fixture'),path=url.pathname;
  const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(path==='/'){res.setHeader('content-type','text/html');return res.end(fs.readFileSync('app/web/templates/index.html'));}
  if(path.startsWith('/static/')){const file='app/web'+path;if(!fs.existsSync(file)){res.writeHead(404);return res.end();}res.setHeader('content-type',path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':path.endsWith('.woff2')?'font/woff2':'application/javascript');return res.end(fs.readFileSync(file));}
  if(path.endsWith('/material-preparations')&&req.method==='POST'){
   const data=[];for await(const chunk of req)data.push(chunk);
   const mode=url.searchParams.get('mode'),id=(++serial).toString(16).padStart(32,'0');uploads.push(mode);
   const report={id,label:'자료 '+serial+'.txt',mode,status:'ready',stale:false,bytes:Buffer.concat(data).length,level:'strong',rule_version:'fixture',findings:[],omissions:[]};
   tokens.set(id,report);if(hold){held=()=>json({token:id},201);return;}return json({token:id},201);
  }
  if(/\/material-preparations\/[^/]+\/commit$/.test(path)){const id=path.split('/').at(-2),report=tokens.get(id);tokens.delete(id);materials.push(report);return json(report,201);}
  if(/\/material-preparations\/[^/]+$/.test(path)&&req.method==='DELETE'){tokens.delete(path.split('/').at(-1));return json({cancelled:true});}
  if(path.endsWith('/materials'))return json({materials});
  if(/\/materials\/[^/]+\/original$/.test(path)){res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="synthetic.txt"'});return res.end('synthetic original');}
  if(/\/materials\/[^/]+$/.test(path)){const id=path.split('/').at(-1),report=materials.find(r=>r.id===id);if(req.method==='DELETE'){materials=materials.filter(r=>r.id!==id);return json({deleted:true});}return json({mode:report?.mode,content:report?.mode==='text'?'protected text':''});}
  const replies={
   '/api/onboarding':{status:'deferred',project:'sample'},'/api/projects':{projects:['sample']},'/api/clients':{clients:[]},
   '/api/clients/codex/status':{state:'available',models:[],limits:[]},'/api/notifications':{events:[],cursor:0,has_more:false},
   '/api/session-overview':{sessions:[],running:[],usage:[]},'/api/projects/sample/workspace':{path:'C:/fixture/sample'},
   '/api/projects/sample/settings':{client:'codex',mode:'read-only',cwd:'.',context_paths:[],timeout_seconds:600},
   '/api/projects/sample/tasks':{tasks:[]},'/api/projects/sample/runs':{runs:[]},'/api/projects/sample/questions':{messages:[]},
   '/api/projects/sample/messages':{messages:[]},'/api/projects/sample/rules':{rules:[]},
   '/api/projects/sample/guard':{level:'strong',privacy_mode:'replace',fields:[]},'/api/projects/sample/work-items':{items:[]},
   '/api/projects/sample/plan':{items:[]},'/api/projects/sample/environment':{git:{state:'available',branch:'main'},ports:{values:[]},docker:{state:'available',containers:[]}},
   '/api/projects/sample/document-vault':{binding:{connection_id:'fixture'}},'/api/projects/sample/workflows':[],
  };
  return json(replies[path]||{});
 }catch(error){res.writeHead(500);res.end(error.message);}
});
async function main(){
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.locator('#startup-loading').waitFor({state:'hidden'});
  const picker=page.locator('#attachment-picker'),modes=page.locator('#attachment-mode-dialog select');
  const file=name=>({name,mimeType:'text/plain',buffer:Buffer.from('synthetic original')});
  await picker.setInputFiles([file('original.txt'),file('converted.txt')]);
  await page.locator('#attachment-mode-dialog[open]').waitFor();
  assert.deepEqual(await modes.evaluateAll(nodes=>nodes.map(n=>n.value)),['original','original']);
  await modes.nth(1).selectOption('text');
  await page.locator('#attachment-mode-confirm').click();
  await page.waitForFunction(()=>document.querySelectorAll('#attachment-chips .attachment-chip').length===2);
  assert.deepEqual(uploads,['original','text']);assert.equal(materials.length,2);
  assert.match(await page.locator('#attachment-chips').innerText(),/원본 파일/);
  assert.match(await page.locator('#attachment-chips').innerText(),/텍스트 변환/);
  assert.match(await page.locator('.attachment-notice').innerText(),/가리지 않/);
  await picker.setInputFiles(file('cancel-choice.txt'));await page.locator('#attachment-mode-dialog[open]').waitFor();
  await page.locator('#attachment-mode-dialog').getByRole('button',{name:'취소',exact:true}).click();
  await page.waitForFunction(()=>!window.materialGuard.isUploading());assert.equal(uploads.length,2);
  await page.locator('#attachment-chips .attachment-chip').first().getByRole('button',{name:/첨부 제거/}).click();
  assert.equal(materials.length,2);
  await page.getByRole('button',{name:'보관된 첨부 관리',exact:true}).click();
  const downloaded=page.waitForEvent('download');await page.locator('#attachment-dialog').getByRole('button',{name:'원본 내려받기',exact:true}).click();
  assert.equal((await downloaded).suggestedFilename(),'synthetic.txt');
  page.once('dialog',dialog=>dialog.accept());await page.locator('#attachment-dialog').getByRole('button',{name:'자료 1.txt 보관 파일 삭제',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('#guard-materials article').length===1);assert.equal(materials.length,1);
  await page.getByRole('button',{name:'첨부 자료 닫기',exact:true}).click();
  await page.getByRole('button',{name:'워크플로 설정 및 진행',exact:true}).click();
  await page.getByRole('button',{name:'새 워크플로',exact:true}).click();
  await page.getByLabel('요구사항 파일',{exact:true}).setInputFiles([file('workflow-original.txt'),file('workflow-text.txt')]);
  await page.locator('#attachment-mode-dialog[open]').waitFor();await modes.nth(1).selectOption('text');
  await page.locator('#attachment-mode-confirm').click();
  await page.waitForFunction(()=>document.querySelector('#workflow-dialog')?.textContent.includes('자료 4.txt (텍스트 변환)'));
  assert.deepEqual(uploads,['original','text','original','text']);
  assert.match(await page.locator('#workflow-dialog').innerText(),/원본 파일/);
  await page.getByRole('button',{name:'워크플로 닫기',exact:true}).click();
  hold=true;await picker.setInputFiles(file('cancel-upload.txt'));await page.locator('#attachment-mode-dialog[open]').waitFor();await page.locator('#attachment-mode-confirm').click();
  await page.waitForFunction(()=>document.querySelector('#attachment-progress')?.textContent.includes('전달'));
  await page.getByRole('button',{name:'첨부 처리 취소',exact:true}).click();
  await page.waitForFunction(()=>!window.materialGuard.isUploading());
  held?.();assert.equal(materials.length,3);assert.deepEqual(errors,[]);
  console.log('PASS original/text chat and workflow choices, cancel, detach, download, delete');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);server.close();process.exitCode=1;});
