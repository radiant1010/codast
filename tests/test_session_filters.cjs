const test=require('node:test');
const assert=require('node:assert/strict');
const {sessionWorkspaceRows,sessionGroup}=require('../app/web/static/session-workspace.js');
const {workItemView}=require('../app/web/static/work-items.js');

test('each saved session belongs to one filter, including held and unknown runs',()=>{
 const chats=['new','idle','paused','done','running','unknown','blocked','review'].map(id=>({id,task:id,runs:id==='idle'?1:0,status:['paused','done'].includes(id)?id:'active'}));
 const goals=['blocked','review'].map(id=>({id:'goal-'+id,chat_id:id,title:id,status:'review',phase:'verify',runs:[{id:'goal-run-'+id,status:id==='blocked'?'failed':'completed'}]}));
 const runs=['running','unknown'].map(id=>({id:'run-'+id,cancellable:id==='running',command:{chat_id:id,client:'codex'}}));
 const rows=sessionWorkspaceRows(chats,goals,[],runs,workItemView);
 const counts={};for(const row of rows){const group=sessionGroup(row);counts[group]=(counts[group]||0)+1;}
 assert.deepEqual(counts,{running:1,attention:4,new:1,idle:1,done:1});
 assert.equal(Object.values(counts).reduce((sum,n)=>sum+n,0),chats.length);
});

test('running and attention precede pins while pinning orders each priority group',()=>{
 const chats=[{id:'new',task:'new'},{id:'pin',task:'pin',pinned:true},{id:'held',task:'held',status:'paused'},{id:'live',task:'live'}];
 const runs=[{id:'r',cancellable:true,command:{chat_id:'live',client:'codex'}}];
 assert.deepEqual(sessionWorkspaceRows(chats,[],[],runs,workItemView).map(row=>row.chat.id),['live','held','pin','new']);
});
