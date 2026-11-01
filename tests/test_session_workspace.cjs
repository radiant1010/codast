const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=path.join(__dirname,'../app/web/static/session-workspace.js');
const {workItemView}=require('../app/web/static/work-items.js');
test('the workspace exposes a session list built from existing chat identities',()=>{
 assert.equal(fs.existsSync(source),true,'session-workspace.js must exist');
 const {sessionWorkspaceRows}=require(source);
 const chats=[{id:'a',task:'처음 만든 대화',status:'active'},{id:'b',task:'두 AI 대화',status:'active'},{id:'c',task:'보관 대화',archived:true}];
 const metrics=[{task:'두 AI 대화',client:'codex',execution_model:'model-a'},{task:'두 AI 대화',client:'claude',execution_model:'model-b'}];
 const rows=sessionWorkspaceRows(chats,[],metrics,[],workItemView);
 assert.deepEqual(rows.map(r=>r.chat.id).sort(),['a','b']);
 assert.equal(rows.find(r=>r.chat.id==='a').status,'시작 전');
 assert.equal(rows.find(r=>r.chat.id==='b').metrics.length,2);
});
test('live run state and goal state are never inferred from successful CLI exit',()=>{
 assert.equal(fs.existsSync(source),true,'session-workspace.js must exist');
 const {sessionWorkspaceRows}=require(source);
 const chats=[{id:'a',task:'일반 대화'},{id:'b',task:'목표 대화'}];
 const goal={id:'goal',chat_id:'b',title:'목표',status:'paused',resume_status:'review',phase:'verify',hold_reason:'자료 대기'};
 const runs=[{id:'r1',cancellable:true,command:{chat_id:'a',client:'codex'}},{id:'r2',cancellable:true,command:{chat_id:'a',client:'claude'}}];
 let rows=sessionWorkspaceRows(chats,[goal],[],runs,workItemView);
 assert.equal(rows.find(r=>r.chat.id==='a').mode,'병렬 2');
 assert.equal(rows.find(r=>r.chat.id==='b').status,'보류');
 rows=sessionWorkspaceRows(chats,[goal],[],[{...runs[0],cancellable:false}],workItemView);
 assert.equal(rows.find(r=>r.chat.id==='a').status,'상태 미확인');
 assert.equal(rows.find(r=>r.chat.id==='a').mode,'확인 필요');
});
test('saved runs, not usage reports, separate a new chat from an idle one',()=>{
 const {sessionWorkspaceRows}=require(source);
 const chats=[{id:'new',task:'새 채팅',runs:0},{id:'idle',task:'실행한 채팅',runs:2},{id:'live',task:'실행 중 채팅',runs:1},{id:'held',task:'보류 채팅',runs:1,status:'paused'},{id:'done',task:'완료 채팅',runs:1,status:'done'},{id:'goal',task:'목표 채팅',runs:1}];
 const goal={id:'g',chat_id:'goal',title:'목표',status:'ready',phase:'inspect'};
 const rows=sessionWorkspaceRows(chats,[goal],[],[{id:'r',cancellable:true,command:{chat_id:'live',client:'codex'}}],workItemView);
 const row=id=>rows.find(r=>r.chat.id===id);
 assert.deepEqual(['new','idle','live','held','done','goal'].map(id=>[row(id).status,row(id).tone]),[['시작 전','neutral'],['대기 중','neutral'],['진행 중','running'],['보류','paused'],['완료','done'],['대기 중','neutral']]);
 assert.equal(row('idle').phase,'—');assert.equal(row('new').phase,'—');
 assert.notEqual(row('goal').phase,'—');
});
test('a finished goal run is not treated as completion',()=>{
 const {sessionWorkspaceRows}=require(source);
 const goal={id:'g',chat_id:'a',title:'목표',status:'review',phase:'verify',latest_run_id:'r',runs:[{id:'r',status:'completed',adapter:'codex',output:'끝'}]};
 const [row]=sessionWorkspaceRows([{id:'a',task:'목표 대화',runs:1,status:'done'}],[goal],[],[],workItemView);
 assert.equal(row.status,'확인 필요');
});
test('polled run counts update idle state without token or context reports',()=>{
 const {sessionWorkspaceRows}=require(source);
 const chats=[{id:'a',task:'외부 실행 채팅',runs:0},{id:'b',task:'새 채팅',runs:0}];
 const metric={task:'외부 실행 채팅',client:'codex',runs:0,input_tokens:null,output_tokens:null,input_reports:0,output_reports:0,context_usage:null};
 let rows=sessionWorkspaceRows(chats,[],[metric],[],workItemView);
 assert.equal(rows.find(row=>row.chat.id==='a').status,'시작 전');
 rows=sessionWorkspaceRows(chats,[],[metric,{...metric,client:'claude',runs:1}],[],workItemView);
 assert.equal(rows.find(row=>row.chat.id==='a').status,'대기 중');
 assert.equal(rows.find(row=>row.chat.id==='a').reason,'다음 지시 대기');
 assert.equal(rows.find(row=>row.chat.id==='b').status,'시작 전');
});

test('linked native sessions and another chat run do not start a new chat',()=>{
 const {sessionWorkspaceRows}=require(source);
 const chats=[{id:'a',task:'연결한 채팅',runs:0}];
 const metrics=[{chat_id:'a',task:'연결한 채팅',client:'codex',session_id:'native',runs:0},
  {chat_id:'other',task:'연결한 채팅',client:'claude',runs:1}];
 const [row]=sessionWorkspaceRows(chats,[],metrics,[],workItemView);
 assert.equal(row.status,'시작 전');
 assert.equal(row.reason,'실행 기록 없음');
});

test('context shows each AI window share without summing or inventing zero',()=>{
 const {contextSummary}=require(source);
 const usage=(used,size)=>({context_usage:{used_tokens:used,window_tokens:size}});
 assert.equal(contextSummary([]),'—');
 assert.equal(contextSummary([{client:'codex',input_tokens:900000,output_tokens:1000}]),'—');
 assert.equal(contextSummary([{client:'codex',...usage(16000,100000)}]),'16%');
 assert.equal(contextSummary([{client:'codex',...usage(5000,null)}]),'—');
 assert.equal(contextSummary([{client:'codex',...usage(100,200000)}]),'<1%');
 assert.equal(contextSummary([{client:'codex',...usage(16000,100000)},{client:'claude',...usage(16000,200000)}]),'Codex 16% / Claude 8%');
 assert.equal(contextSummary([{client:'codex',...usage(16000,100000)},{client:'claude'}]),'Codex 16% / Claude —');
});
