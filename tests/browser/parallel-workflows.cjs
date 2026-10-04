const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
 const origin=process.env.WORKFLOW_TEST_URL||'http://127.0.0.1:8773',project='parallel-'+Date.now();
 async function api(path,method='GET',data){const r=await fetch(origin+'/api'+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;}
 await api('/projects','POST',{name:project});await api('/onboarding','PUT',{deferred:true});
 let settings=await api('/projects/'+project+'/document-vault');
 settings=await api('/projects/'+project+'/document-vault','PUT',{path:settings.suggested_base_path,layout:'project',mode:'create'});
 const cid=settings.binding.connection_id,db='/projects/'+project+'/document-vault/documents';
 let doc=await api(db,'POST',{connection_id:cid,title:'가상 요구사항',content:'REQ-001: 이름은 필수다. API는 미확정이다.'});
 doc=await api(db+'/'+doc.id+'/reviews','POST',{connection_id:cid,expected_revision:doc.revision,reason:'가상 검토'});
 await api(db+'/'+doc.id+'/reviews/1/decision','POST',{connection_id:cid,expected_revision:doc.revision,decision:'approved',comment:'가상 승인'});
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.locator('#startup-loading').waitFor({state:'hidden'});await page.selectOption('#project',project);
 await page.getByRole('button',{name:'워크플로 관리',exact:true}).click();
 await page.getByRole('button',{name:'새 병렬 설계와 테스트 정의',exact:true}).click();
 await page.getByLabel('작업 이름',{exact:true}).fill('병렬 검토');
 assert.match(await page.getByLabel('공통 승인 입력',{exact:true}).textContent(),/승인 v1/);
 await page.getByRole('button',{name:'병렬 작업 저장',exact:true}).click();
 await page.getByRole('button',{name:'두 Codex 작업 동시 실행',exact:true}).click();
 await page.getByText('저장 형식은?',{exact:true}).waitFor();
 const answer=page.getByLabel('설계 작성 답변 또는 수정 의견',{exact:true});await answer.fill('텍스트');
 await page.getByRole('button',{name:'테스트케이스 정의 결과 승인',exact:true}).waitFor();
 assert.equal(await answer.inputValue(),'텍스트');
 assert.equal(await page.locator('#workflow-dialog script').count(),0);
 await page.getByRole('button',{name:'설계 작성만 다시 실행',exact:true}).click();
 await page.getByRole('button',{name:'설계 작성 결과 승인',exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});
 const dimensions=await page.locator('#workflow-dialog').evaluate(n=>({width:n.clientWidth,scroll:n.scrollWidth,wide:[...n.querySelectorAll('*')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>({tag:e.tagName,cls:e.className,width:e.clientWidth,scroll:e.scrollWidth,text:e.textContent.slice(0,70)}))}));if(dimensions.scroll>dimensions.width+1)console.log(dimensions);
 assert.equal(dimensions.scroll<=dimensions.width+1,true);
 fs.mkdirSync('work/parallel-browser-captures',{recursive:true});await page.screenshot({path:'work/parallel-browser-captures/narrow.png',fullPage:true});
 await page.keyboard.press('Escape');await page.reload();await page.locator('#startup-loading').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'워크플로 관리',exact:true}).click();await page.getByRole('button',{name:'병렬 검토 — 결과 검토',exact:true}).click();
 await page.getByRole('button',{name:'설계 작성 결과 승인',exact:true}).click();
 await page.getByRole('button',{name:'테스트케이스 정의 결과 승인',exact:true}).click();
 await page.getByRole('button',{name:'승인 산출물과 이력 내려받기',exact:true}).waitFor();
 const rows=await api('/projects/'+project+'/workflows?connection_id='+cid),state=await api('/projects/'+project+'/workflows/'+rows[0].id+'?connection_id='+cid);
 assert.equal(state.steps[0].attempts.length,2);assert.equal(state.steps[1].attempts.length,1);assert.equal(state.status,'done');
 const pending=page.waitForEvent('download');await page.getByRole('button',{name:'승인 산출물과 이력 내려받기',exact:true}).click();assert.equal(await (await pending).failure(),null);
 assert.deepEqual(errors,[]);console.log('PASS parallel UI: approved source, simultaneous launch, question, peer result, answer preservation, one-role retry, reload, approval, ZIP, 390px, safe output');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
