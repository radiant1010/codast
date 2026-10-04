const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync('app/web/static/startup.js','utf8');
async function start({saved={status:'in_progress'},last='',names=[],clients=[],failed=false}={}){
  let value='',opened=0,loaded=0,checked=0;
  const select={get value(){return value;},set value(v){value=names.includes(v)?v:'';}};
  const context={projects:async()=>{},$:()=>select,notice:()=>{},loadProject:async()=>loaded++,
    window:{chatState:{lastProject:()=>last},openConnections:async()=>opened++},
    api:async path=>{if(path==='/onboarding')return saved;checked++;if(failed)throw Error('offline');return {clients};}};
  vm.createContext(context);vm.runInContext(source,context);const afterReady=await context.initializeWorkspace();if(afterReady)await afterReady();
  return {opened,loaded,checked,value};
}
test('connected agent suppresses setup even with incomplete onboarding and other agent missing',async()=>{
  for(const client of ['codex','claude']){
    const result=await start({clients:[{client,state:'installed',auth:'ready'},{state:'missing'}]});
    assert.equal(result.opened,0);assert.equal(result.checked,1);
  }
});
test('saved project restores without reopening setup or waiting on auth',async()=>{
  assert.deepEqual(await start({saved:{status:'in_progress',project:'one'},names:['one']}),
    {opened:0,loaded:1,checked:0,value:'one'});
});
test('background connection checks never interrupt with an automatic modal',async()=>{
  assert.equal((await start({saved:{status:'pending'},clients:[{state:'installed',auth:'check_required'}]})).opened,0);
  for(const status of ['completed','deferred'])assert.equal((await start({saved:{status}})).opened,0);
  assert.equal((await start({failed:true})).opened,0);
});

test('startup blocks interaction until ready and offers retry after failure',async()=>{
  const nodes={};const $=id=>nodes[id]??={hidden:false,inert:false,textContent:'',classList:{add(){},remove(){}},setAttribute(k,v){this[k]=v;},focus(){}};
  const context={$};vm.createContext(context);vm.runInContext(source,context);
  let release;context.initializeWorkspace=()=>new Promise(done=>release=done);
  const pending=context.startWorkspace();assert.equal($('workspace').inert,true);assert.equal($('startup-loading').hidden,false);
  release();await pending;assert.equal($('workspace').inert,false);assert.equal($('startup-loading').hidden,true);
  context.initializeWorkspace=async()=>{throw Error('offline');};await context.startWorkspace();
  assert.equal($('workspace').inert,true);assert.equal($('startup-retry').hidden,false);assert.match($('startup-message').textContent,/offline/);
  context.initializeWorkspace=async()=>{};await $('startup-retry').onclick();assert.equal($('workspace').inert,false);
});

test('saved local project does not depend on onboarding availability',async()=>{
  let loaded=0;
  const select={value:''};
  const context={$:()=>select,projects:async()=>{},loadProject:async()=>loaded++,
    window:{chatState:{lastProject:()=> 'saved'}},api:()=>{throw Error('onboarding must not be requested');}};
  vm.createContext(context);vm.runInContext(source,context);
  await context.initializeWorkspace();assert.equal(loaded,1);
});

test('slow connection check leaves workspace usable and ignores a later project selection',async()=>{
  const nodes={};const $=id=>nodes[id]??={value:'',hidden:false,inert:false,classList:{remove(){}},setAttribute(){}};
  let release,checked=false;const notices=[];
  const context={$,projects:async()=>{},notice:text=>notices.push(text),window:{chatState:{lastProject:()=>''}},
    api:async path=>path==='/onboarding'?{status:'pending'}:new Promise(done=>{checked=true;release=done;})};
  vm.createContext(context);vm.runInContext(source,context);
  await context.startWorkspace();assert.equal(checked,true);
  assert.equal($('workspace').inert,false);assert.equal($('startup-loading').hidden,true);
  $('project').value='chosen';const count=notices.length;release({clients:[]});
  await new Promise(setImmediate);assert.equal(notices.length,count);
});
