const {test}=require('node:test');
const assert=require('node:assert/strict');
const {workItemView,workItemElapsed}=require('../app/web/static/work-items.js');

test('finished execution requires a separate review and never implies a completed goal',()=>{
  const view=workItemView({status:'review',phase:'verify',runs:[{status:'completed',output:'result',metadata:{}}]});
  assert.equal(view.canVerify,true);
  assert.equal(view.completed,false);
  assert.equal(workItemView({status:'done',runs:[]}).completed,true);
});

test('questions, failed executions and detached runs cannot be approved',()=>{
  for(const run of [
    {status:'completed',output:'question',metadata:{question:{question:'input?'}}},
    {status:'failed',output:'partial',metadata:{}},
    {status:'completed',output:'  ',metadata:{}},
  ])assert.equal(workItemView({status:'blocked',runs:[run]}).canVerify,false);
  const detached=workItemView({status:'running',recovery_required:true,runs:[]});
  assert.equal(detached.canRun,false);
  assert.equal(detached.canVerify,false);
  assert.equal(detached.needsRecovery,true);
});

test('an inconclusive review stays open and missing measurements do not become zero',()=>{
  const view=workItemView({status:'review',runs:[{status:'completed',output:'evidence',metadata:{elapsed_seconds:0}}]});
  assert.equal(view.elapsed,0);
  assert.equal(workItemView({status:'ready',runs:[]}).elapsed,null);
  assert.equal(view.canRun,true);
});

test('the active result uses its own verification, never a previous run approval',()=>{
  const old={id:'old',status:'completed',output:'old result',metadata:{}};
  const current={id:'current',adapter:'claude',status:'completed',output:'new result',metadata:{}};
  const view=workItemView({status:'review',latest_run_id:'current',runs:[old,current],verifications:[{run_id:'old',verdict:'passed',note:'old approval'}]});
  assert.equal(view.latest,current);
  assert.deepEqual(view.verifications,[]);
  assert.equal(view.step,'verify');
  assert.match(view.nextAction,/결과.*확인/);
});

test('questions, errors and orphaned runs explain the next action without implying progress',()=>{
  const question=workItemView({status:'blocked',runs:[{status:'completed',output:'질문',metadata:{question:{question:'대상 파일은?'}}}]});
  assert.equal(question.step,'execute');
  assert.match(question.nextAction,/답변/);
  assert.match(workItemView({status:'blocked',runs:[{status:'failed',error:'연결 실패'}]}).nextAction,/오류/);
  const orphan=workItemView({status:'running',phase:'resolve',recovery_required:true,runs:[]});
  assert.equal(orphan.step,'execute');
  assert.match(orphan.nextAction,/종료/);
  assert.match(workItemView({status:'ready',runs:[]}).nextAction,/첫 작업/);
});

test('a rejected result returns to correction and only explicit completion reaches resolution',()=>{
  const run={id:'r',status:'completed',output:'result',metadata:{}};
  const verification={run_id:'r',verdict:'failed',note:'more cases'};
  const view=workItemView({status:'blocked',runs:[run],verifications:[verification]});
  assert.equal(view.step,'execute');
  assert.deepEqual(view.verifications,[verification]);
  assert.match(view.nextAction,/보완/);
  assert.equal(workItemView({status:'done',runs:[run]}).step,'resolve');
  assert.equal(workItemView({status:'running',phase:'resolve',runs:[run]}).completed,false);
});

test('answered questions are distinguished from questions still waiting for a reply',()=>{
  for(const [extra,label] of [[{},'답변 대기'],[{reply_run_id:'answer'},'답변 접수됨'],[{superseded_by:'next'},'이후 실행으로 이어짐']]){
    const view=workItemView({status:'blocked',runs:[{id:'question',status:'completed',metadata:{question:{question:'대상은?'},...extra}}]});
    assert.equal(view.runStatus,label);
  }
});

test('list summaries distinguish human attention, execution errors and lost runtime state',()=>{
  const run={id:'r',adapter:'codex',status:'completed',has_output:true,metadata:{question:{question:'어떤 파일?'}}};
  const waiting=workItemView({status:'blocked',latest_run:run,active_runs:[]});
  assert.equal(waiting.status,'확인 필요');assert.equal(waiting.reason,'답변 대기');assert.equal(waiting.actionLabel,'답변하기');
  const review=workItemView({status:'review',latest_run:{...run,metadata:{}},active_runs:[]});
  assert.equal(review.reason,'결과 확인');assert.equal(review.canVerify,true);
  assert.equal(review.ai,'최근 Codex');assert.equal(review.executionMode,'—');
  const failed=workItemView({status:'blocked',latest_run:{...run,status:'failed',metadata:{}},active_runs:[]});
  assert.equal(failed.status,'막힘');assert.equal(failed.reason,'실행 오류');
  const unknown=workItemView({status:'running',recovery_required:true,latest_run:run,active_runs:[]});
  assert.equal(unknown.status,'상태 미확인');assert.equal(unknown.executionMode,'확인 필요');
});

test('parallel means concurrent executions even when the AI provider is the same',()=>{
  const active=[{id:'one',client:'codex'},{id:'two',client:'codex'}];
  const item={status:'running',active_runs:active};
  assert.equal(workItemView(item).executionMode,'병렬 2');
  assert.equal(workItemView(item).ai,'Codex');
  assert.equal(workItemView({...item,active_runs:active.slice(0,1)}).executionMode,'단일');
  assert.equal(workItemView({status:'review',active_runs:[],runs:[{adapter:'claude'},{adapter:'codex'}]}).executionMode,'—');
});

test('held goals disable run and verification and preserve their waiting reason',()=>{
  for(const [status,label] of [['paused','재개'],['cancelled','다시 열기']]){
    const view=workItemView({status,resume_status:'review',hold_reason:'승인 보류',latest_run:{id:'r',status:'completed',has_output:true,metadata:{}}});
    assert.equal(view.canRun,false);assert.equal(view.canVerify,false);
    assert.equal(view.reason,'승인 보류');assert.equal(view.actionLabel,label);
    assert.equal(view.step,'verify');
  }
});

test('elapsed labels do not invent time when timestamps are unavailable',()=>{
  const now=Date.parse('2026-10-30T00:30:00Z');
  assert.equal(typeof workItemElapsed,'function');
  assert.equal(workItemElapsed('2026-10-30T00:05:00Z',now),'25분째');
  assert.equal(workItemElapsed('2026-10-30T01:05:00Z',now),'방금');
  assert.equal(workItemElapsed('invalid',now),'');
});
