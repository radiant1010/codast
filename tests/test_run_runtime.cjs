const {test}=require('node:test');
const assert=require('node:assert/strict');
const runtime=require('../app/web/static/run-runtime.js');
const start='2026-01-01T00:00:00Z';
const snapshot={run_id:'one',status:'running',started_at:start,finished_at:null,
  last_progress_at:null,timeout_seconds:null,server_time:'2026-01-01T00:02:10Z'};

test('timeout settings accept positive whole seconds or explicit unlimited',()=>{
  assert.equal(runtime.parseTimeout('600',false),600);
  assert.equal(runtime.parseTimeout('',true),null);
  for(const value of ['', '0','-1','1.5','Infinity','9007199254740992'])
    assert.throws(()=>runtime.parseTimeout(value,false));
});

test('elapsed time uses the original run start and silence is only advisory',()=>{
  const value=runtime.describe(snapshot,Date.parse(snapshot.server_time),'connected');
  assert.match(value,/2분 10초/);
  assert.match(value,/제한 없음/);
  assert.match(value,/진행 이벤트 아직 없음/);
  assert.match(value,/추론이나 도구 실행 중일 수 있습니다/);
  assert.doesNotMatch(value,/실패|자동.*종료/);
});

test('last progress is preserved across reconnect and completion stops elapsed time',()=>{
  const row={...snapshot,last_progress_at:'2026-01-01T00:02:00Z',timeout_seconds:600};
  const live=runtime.describe(row,Date.parse(snapshot.server_time),'connected');
  assert.match(live,/마지막 진행/);assert.match(live,/10초 전/);assert.match(live,/600초/);
  const done=runtime.describe({...row,status:'completed',finished_at:'2026-01-01T00:02:15Z'},
    Date.parse('2026-01-01T05:00:00Z'),'connected');
  assert.match(done,/완료/);assert.match(done,/2분 15초/);assert.doesNotMatch(done,/도구 실행 중/);
});

test('connection loss and detached execution are distinct from terminal failures',()=>{
  assert.match(runtime.describe(snapshot,Date.parse(snapshot.server_time),'disconnected'),/연결 끊김/);
  assert.match(runtime.describe(snapshot,Date.parse(snapshot.server_time),'detached'),/종료 확인 필요/);
  assert.match(runtime.describe({...snapshot,status:'failed',termination_reason:'timeout'},Date.now(),'connected'),/시간 초과/);
  assert.match(runtime.describe({...snapshot,status:'interrupted'},Date.now(),'connected'),/취소 또는 중단/);
});

test('runtime view ignores another run and stops timers when the stream closes',()=>{
 const fs=require('node:fs'),vm=require('node:vm');let callback,cleared=0;
 const node={textContent:'',style:{}},context={module:{exports:{}},Date,Number,String,Math,
   document:{createElement:()=>node},setInterval:fn=>{callback=fn;return 1;},clearInterval:()=>cleared++};
 vm.createContext(context);vm.runInContext(fs.readFileSync('app/web/static/run-runtime.js','utf8'),context);
 const view=context.module.exports.create('one');
 view.update({...snapshot,run_id:'other'});assert.equal(node.textContent,'실행 시간 확인 중');
 view.update(snapshot);assert.match(node.textContent,/2분 10초/);assert.equal(typeof callback,'function');
 view.connection('disconnected');assert.match(node.textContent,/연결 끊김/);
 view.update({...snapshot,server_time:'2026-01-01T00:03:00Z'});assert.match(node.textContent,/3분 0초/);assert.doesNotMatch(node.textContent,/연결 끊김/);
 view.stop();assert.equal(cleared,1);
});
