const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
const source=fs.readFileSync('app/web/static/run-notifications.js','utf8');
function boot(storage,api){const context={window:{},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},api};vm.createContext(context);vm.runInContext(source,context);return context.window.runNotifications;}
test('offline completions catch up once and survive reload and read',async()=>{
 const storage=new Map(),rows=[{seq:2,run_id:'a'},{seq:4,run_id:'b'}];let offline=false;
 const api=async url=>{if(offline)throw Error('offline');const after=Number(url.split('=')[1]);const events=rows.filter(r=>r.seq>after);return {events,cursor:events.at(-1)?.seq||after};};
 let state=boot(storage,api);await state.refresh();assert.equal(state.snapshot().unread,2);await state.refresh();assert.equal(state.snapshot().unread,2);
 state.read();rows.push({seq:6,run_id:'c'});offline=true;await assert.rejects(state.refresh());assert.equal(state.snapshot().cursor,4);
 state=boot(storage,api);assert.equal(state.snapshot().unread,0);offline=false;await state.refresh();assert.equal(state.snapshot().unread,1);assert.equal(state.snapshot().events.length,3);
 state=boot(storage,api);await state.refresh();assert.equal(state.snapshot().unread,1);
});
test('bounded catch-up and duplicate terminal records',async()=>{
 const storage=new Map();let requests=0;const state=boot(storage,async()=>{requests++;return {events:[{seq:requests,run_id:'same'}],cursor:requests,has_more:requests<6};});
 await state.refresh();assert.equal(requests,4);await state.refresh();assert.equal(requests,6);assert.equal(state.snapshot().unread,1);
});
