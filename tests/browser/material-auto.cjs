const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {execFileSync}=require('node:child_process');
(async()=>{
 const origin=process.env.WORKFLOW_TEST_URL||'http://127.0.0.1:8776',project='auto-'+Date.now(),base='/projects/'+project;
 fs.mkdirSync('work/material-auto-browser',{recursive:true});
 execFileSync(process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python',['-c',"from pathlib import Path; from tests.test_pdf_materials import pdf_bytes,TABLE; root=Path('work/material-auto-browser'); (root/'mixed.pdf').write_bytes(pdf_bytes([TABLE,b''])); (root/'scan.pdf').write_bytes(pdf_bytes([b'']))"]);
 async function api(path,method='GET',data){const r=await fetch(origin+'/api'+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;}
 await api('/projects','POST',{name:project});await api('/onboarding','PUT',{deferred:true});
 await api(base+'/guard','PUT',{privacy_mode:'replace'});
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
 await page.goto(origin);await page.locator('#startup-loading').waitFor({state:'hidden'});await page.selectOption('#project',project);await page.waitForFunction(()=>projectReady&&!chatLoading);
 await page.getByRole('button',{name:'＋ 새 채팅',exact:true}).click();await page.fill('#new-chat-name','자동 첨부');await page.getByRole('button',{name:'새 채팅 만들기',exact:true}).click();await page.locator('#text').waitFor({state:'visible'});
 await page.locator('#attachment-picker').setInputFiles({name:'list.csv',mimeType:'text/csv',buffer:Buffer.from('고객명,요청사항\n테스트인물가,배송 확인')});
 await page.waitForFunction(()=>window.materialGuard.selected().length===1);
 assert.equal(await page.locator('#material-review-dialog').count(),0);
 let reports=(await api(base+'/materials')).materials,stored=await api(base+'/materials/'+reports[0].id);
 assert.doesNotMatch(stored.content,/테스트인물가/);assert.match(stored.content,/배송 확인/);
 await page.locator('#attachment-picker').setInputFiles('work/material-auto-browser/mixed.pdf');
 await page.waitForFunction(()=>window.materialGuard.selected().length===2);
 reports=(await api(base+'/materials')).materials;stored=await api(base+'/materials/'+reports[0].id);
 assert.equal(await page.locator('#material-review-dialog').count(),0);assert.doesNotMatch(stored.content,/Sample Person/);assert.match(stored.content,/Consultation/);
 assert.ok(reports[0].omissions.some(item=>item.includes('2페이지')));
 await page.locator('#attachment-picker').setInputFiles('work/material-auto-browser/scan.pdf');
 await page.waitForFunction(()=>!window.materialGuard.isUploading());
 await page.getByText(/PDF에서 읽을 수 있는 텍스트가 없습니다/).waitFor();
 assert.equal((await api(base+'/materials')).materials.length,2);assert.equal((await page.evaluate(()=>window.materialGuard.selected())).length,2);
 // Workflow uploads also attach without a review gate.
 await page.getByRole('button',{name:'워크플로 관리',exact:true}).click();
 await page.getByRole('button',{name:'산출물 저장 위치 연결',exact:true}).click();
 await page.getByRole('button',{name:'새 워크플로',exact:true}).click();await page.fill('#wf-title','자동 필터 PDF');
 await page.getByLabel('요구사항 파일',{exact:true}).setInputFiles('work/material-auto-browser/mixed.pdf');
 await page.getByRole('button',{name:'전달 내용 확인',exact:true}).waitFor();assert.equal(await page.locator('#material-review-dialog').count(),0);
 reports=(await api(base+'/materials')).materials;assert.equal(reports.length,3);
 stored=await api(base+'/materials/'+reports[0].id);assert.doesNotMatch(stored.content,/Sample Person/);assert.match(stored.content,/Delivery request/);
 await page.getByRole('button',{name:'워크플로 저장',exact:true}).click();await page.getByRole('button',{name:'현재 단계 실행',exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);console.log('PASS: automatic CSV and PDF attachment, filtering, partial PDF report, unreadable PDF failure without lost attachments, automatic workflow PDF upload, narrow layout');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
