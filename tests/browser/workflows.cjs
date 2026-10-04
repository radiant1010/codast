const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
 const origin=process.env.WORKFLOW_TEST_URL||'http://127.0.0.1:8772',project='workflow-'+Date.now();
 async function api(path,method='GET',data){const r=await fetch(origin+'/api'+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;}
 await api('/projects','POST',{name:project});await api('/onboarding','PUT',{deferred:true});
 const settings=await api('/projects/'+project+'/document-vault');

 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.locator('#startup-loading').waitFor({state:'hidden'});await page.selectOption('#project',project);
 await page.getByRole('button',{name:'워크플로 관리',exact:true}).click();
 assert.equal(await page.locator('#workflow-vault-path').inputValue(),settings.suggested_base_path);
 assert.equal((await api('/projects/'+project+'/document-vault')).binding,null);
 await page.getByRole('button',{name:'산출물 저장 위치 연결',exact:true}).click();
 await page.getByRole('button',{name:'새 워크플로',exact:true}).click();
 assert.ok((await api('/projects/'+project+'/document-vault')).binding);
 await page.fill('#wf-title','로그인 요구사항 검토');
 await page.getByLabel('요구사항 파일',{exact:true}).setInputFiles({name:'sample.md',mimeType:'text/markdown',buffer:Buffer.from('REQ-001: 로그인은 필수 입력을 검사한다.')});
 await page.getByRole('button',{name:'전달 내용 확인',exact:true}).waitFor();
 fs.mkdirSync('work/workflow-browser',{recursive:true});await page.screenshot({path:'work/workflow-browser/setup.png',fullPage:true});
 await page.getByRole('button',{name:'워크플로 저장',exact:true}).click();
 await page.getByRole('button',{name:'현재 단계 실행',exact:true}).waitFor();
 await page.locator('#workflow-dialog').getByLabel('실행 권한',{exact:true}).selectOption('workspace-write');
 await page.getByRole('button',{name:'현재 단계 실행',exact:true}).click();
 await page.getByRole('button',{name:'현재 결과 승인',exact:true}).waitFor();
 assert.equal(await page.locator('#workflow-dialog script').count(),0);
 await page.getByLabel('수정 대상과 의견',{exact:true}).fill('TC-001에 공백 입력 사례를 추가해주세요.');
 await page.getByLabel('담당 AI',{exact:true}).selectOption('claude');
 await page.getByRole('button',{name:'의견을 반영해 다시 실행',exact:true}).click();
 await page.getByRole('button',{name:'현재 결과 승인',exact:true}).click();
 await page.getByRole('button',{name:'현재 단계 실행',exact:true}).waitFor();
 assert.equal(await page.locator('#workflow-dialog').getByLabel('실행 권한',{exact:true}).inputValue(),'read-only');
 assert.match(await page.locator('#workflow-dialog').innerText(),/승인 v2/);
 await page.getByRole('button',{name:'현재 단계 실행',exact:true}).waitFor();
 // Closing/reopening preserves pending next step without automatic dispatch.
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'워크플로 관리',exact:true}).click();
 await page.getByRole('button',{name:'로그인 요구사항 검토 — 실행 준비',exact:true}).click();
 await page.getByRole('button',{name:'현재 단계 실행',exact:true}).click();
 await page.getByRole('button',{name:'현재 결과 승인',exact:true}).waitFor();
 await page.screenshot({path:'work/workflow-browser/review.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.locator('#workflow-dialog').evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);
 await page.screenshot({path:'work/workflow-browser/narrow.png',fullPage:true});
 await page.getByRole('button',{name:'현재 결과 승인',exact:true}).click();
 await page.locator('#workflow-dialog p').filter({hasText:'모든 단계 승인 완료'}).waitFor();
 assert.match(await page.locator('#workflow-dialog').innerText(),/모든 단계 승인 완료/);
 const downloadPromise=page.waitForEvent('download');
 await page.getByRole('button',{name:'승인 산출물과 이력 내려받기',exact:true}).click();
 const download=await downloadPromise;
 assert.match(download.suggestedFilename(),/^CDS-WF-.*\.zip$/);
 assert.equal(await download.failure(),null);
 assert.deepEqual(errors,[]);console.log('PASS: workflow upload, setup, dispatch, revision, approval, handoff, reopen, narrow layout, safe output');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
