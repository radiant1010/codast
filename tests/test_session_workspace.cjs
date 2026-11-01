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
 assert.equal(rows.find(r=>r.chat.id==='a').status,'실행 없음');
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
