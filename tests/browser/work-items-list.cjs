const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');

(async()=>{
  const origin=process.env.WORK_ITEM_TEST_URL||'http://127.0.0.1:8777',project='list-'+Date.now();
  async function api(path,method='GET',data){
    const r=await fetch(origin+'/api'+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
    const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;
  }
  const base='/projects/'+project+'/work-items';
  await api('/projects','POST',{name:project});await api('/onboarding','PUT',{deferred:true});
  async function create(title){return api(base,'POST',{title,goal:'가상 자료의 입력 조건을 확인한다.',done_criteria:'정상 입력과 빈 입력을 비교해 확인한다.'});}
  async function run(item,text,client='codex'){
    await api(base+'/'+item.id+'/runs','POST',{expected_revision:item.revision,request_id:crypto.randomUUID(),text,client,mode:'read-only'});
    for(let i=0;i<150;i++){
      const current=await api(base+'/'+item.id);if(current.status!=='running')return current;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('Synthetic execution did not finish');
  }
  const ready=await create('새 자료 검사');
  let paused=await create('승인 후 작업 시작');
  paused=await api(base+'/'+paused.id+'/control','POST',{expected_revision:paused.revision,action:'pause',reason:'승인 보류, 원문 대조 필요'});
  await run(await create('자료 연결 오류 확인'),'실패 사례');
  await run(await create('검사 대상 확인'),'질문 사례','claude');
  const review=await run(await create('검사 결과 검토'),'입력 검사');
  let done=await run(await create('완료한 입력 검사'),'입력 검사');
  done=await api(base+'/'+done.id+'/verifications','POST',{expected_revision:done.revision,run_id:done.latest_run_id,verdict:'passed',criteria_met:true,note:'정상 입력과 빈 입력을 확인했습니다.'});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];
  const captures='.local/work-items-captures';fs.mkdirSync(captures,{recursive:true});
  try{
    page.on('pageerror',error=>errors.push(error.message));
    await page.clock.install();
    await page.goto(origin);await page.locator('#startup-loading').waitFor({state:'hidden'});
    await page.selectOption('#project',project);await page.evaluate(()=>{location.hash='#work-items';});
    const screen=page.locator('#work-items-page');
    const row=title=>screen.getByRole('row').filter({has:page.getByRole('link',{name:title,exact:true})});
    await row('승인 후 작업 시작').waitFor();
    assert.deepEqual(await screen.getByRole('columnheader').allTextContents(),['작업 제목','현재 상태','작업 단계','AI','실행 방식']);
    assert.match(await row('새 자료 검사').innerText(),/준비[\s\S]*첫 지시 필요[\s\S]*미시작/);
    assert.match(await row('승인 후 작업 시작').innerText(),/보류[\s\S]*승인 보류, 원문 대조 필요/);
    assert.match(await row('자료 연결 오류 확인').innerText(),/막힘[\s\S]*실행 오류/);
    assert.match(await row('검사 대상 확인').innerText(),/확인 필요[\s\S]*답변 대기[\s\S]*최근 Claude/);
    assert.match(await row('검사 결과 검토').innerText(),/확인 필요[\s\S]*결과 확인/);
    assert.match(await row('완료한 입력 검사').innerText(),/완료[\s\S]*완료 조건 충족/);
    assert.equal(await row('승인 후 작업 시작').locator('time').count(),1);
    await page.screenshot({path:captures+'/list-badges.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await screen.evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);
    assert.equal(await screen.getByRole('row').count(),7);
    await page.screenshot({path:captures+'/list-badges-narrow.png',fullPage:true});
    await row('승인 후 작업 시작').getByRole('button',{name:'재개',exact:true}).click();
    await row('승인 후 작업 시작').getByText('준비',{exact:true}).waitFor();
    assert.equal((await api('/projects/'+project+'/runs')).runs.length,4,'resume does not launch AI');
    await page.setViewportSize({width:1440,height:1050});
    await row('검사 결과 검토').getByRole('link',{name:'결과 확인',exact:true}).click();
    await screen.getByRole('heading',{name:'완료 조건 확인',exact:true}).waitFor();
    await screen.getByText('작업 보류 또는 취소',{exact:true}).click();
    await screen.getByLabel('보류 또는 취소 사유').fill('추가 자료 대조 후 승인');
    await screen.getByRole('button',{name:'작업 상태 저장',exact:true}).click();
    await screen.locator('[data-state="paused"]').waitFor();
    assert.equal(await screen.getByRole('button',{name:'확인 결과 저장',exact:true}).count(),0);
    assert.equal(await screen.getByRole('button',{name:'AI 실행',exact:true}).count(),0);
    await page.reload();await screen.locator('[data-state="paused"]').waitFor();
    await page.clock.fastForward(65000);
    await screen.locator('time').filter({hasText:'1분째'}).waitFor({timeout:5000});
    await screen.getByRole('button',{name:'재개',exact:true}).click();
    await screen.getByRole('heading',{name:'완료 조건 확인',exact:true}).waitFor();
    await screen.getByText('작업 보류 또는 취소',{exact:true}).click();
    await screen.getByLabel('작업 처리').selectOption('cancel');
    await screen.getByLabel('보류 또는 취소 사유').fill('이번 목표 종료');
    await screen.getByRole('button',{name:'작업 상태 저장',exact:true}).click();
    await screen.locator('[data-state="cancelled"]').waitFor();
    await screen.getByRole('button',{name:'목록으로',exact:true}).click();
    await row('검사 결과 검토').getByText('취소',{exact:true}).waitFor();
    await row('검사 결과 검토').getByRole('button',{name:'다시 열기',exact:true}).click();
    await row('검사 결과 검토').getByText('확인 필요',{exact:true}).waitFor();
    await row('검사 대상 확인').getByRole('link',{name:'답변하기',exact:true}).click();
    await screen.getByRole('heading',{name:'AI의 질문',exact:true}).waitFor();
    assert.equal((await api(base+'/'+review.id)).status,'review');
    assert.equal((await api(base+'/'+ready.id)).status,'ready');
    assert.deepEqual(errors,[]);
    console.log('PASS list badges: five columns, status reasons, AI labels, elapsed time, 390px, pause/reload/resume, cancel/reopen, correct next actions, no automatic AI run');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
