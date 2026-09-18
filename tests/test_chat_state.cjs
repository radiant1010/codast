const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('app/web/static/chat-state.js','utf8');
function screen(storage=new Map()){
  const nodes=Object.fromEntries(['text','client','cwd','mode','fresh','action','messages','task-name'].map(id=>[id,{value:'',checked:false,scrollTop:0}]));
  const context={window:{addEventListener(){}},document:{addEventListener(){}},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
    sessionStorage:{getItem:()=>null,removeItem(){}},
    $:id=>nodes[id],selectedPaths:()=>context.paths,paths:[],offset:0,notice:()=>{},actionHint:()=>{}};
  context.window.loadModelChoices=async model=>{context.model=model;};
  context.window.selectedConfiguredModel=()=>context.model;
  vm.createContext(context);vm.runInContext(source,context);
  return {context,nodes,state:context.window.chatState,storage};
}
const defaults={client:'codex',model:null,cwd:'.',mode:'read-only',context_paths:[]};
async function open(ui,project,task){ui.state.pause();const result=await ui.state.restore(project,task,defaults);if(result){ui.context.paths=result.state.paths;ui.state.finish(result);}return result;}

test('chat/project switching and reload preserve draft, settings, files and scroll',async()=>{
  const ui=screen();await open(ui,'one','A');
  ui.nodes.text.value='draft A';ui.nodes.client.value='codex';ui.context.model='selected-model';
  ui.context.paths=['docs/notes.md'];ui.nodes.mode.value='workspace-write';ui.nodes.messages.scrollTop=120;ui.context.offset=20;
  await open(ui,'one','B');assert.equal(ui.nodes.text.value,'');assert.equal(ui.nodes.client.value,'codex');
  ui.nodes.text.value='draft B';await open(ui,'two','A');ui.nodes.text.value='other project';
  await open(ui,'one','A');assert.equal(ui.nodes.text.value,'draft A');assert.equal(ui.nodes.client.value,'codex');
  assert.equal(ui.context.model,'selected-model');assert.equal(ui.context.paths[0],'docs/notes.md');
  assert.equal(ui.nodes.messages.scrollTop,120);assert.equal(ui.context.offset,20);
  const reloaded=screen(ui.storage);assert.equal(reloaded.state.lastProject(),'one');
  await open(reloaded,'one',reloaded.state.selected('one'));assert.equal(reloaded.nodes.text.value,'draft A');
  assert.ok(reloaded.state.drafts('one').includes('B'));
});

test('send clears only the submitted text; failure or a newer draft survives',async()=>{
  const ui=screen();await open(ui,'one','A');ui.nodes.text.value='submitted';ui.state.save();
  await open(ui,'one','B');ui.state.sent('one','A','submitted');await open(ui,'one','A');assert.equal(ui.nodes.text.value,'');
  ui.nodes.text.value='new text';ui.state.save();ui.state.sent('one','A','submitted');
  await open(ui,'one','B');await open(ui,'one','A');assert.equal(ui.nodes.text.value,'new text');
});

test('late model lookup cannot finish an obsolete chat restoration',async()=>{
  const ui=screen();let resolve;
  ui.context.window.loadModelChoices=()=>new Promise(done=>{resolve=done;});
  const old=ui.state.restore('one','old',defaults);
  ui.context.window.loadModelChoices=async()=>{};
  await open(ui,'one','new');ui.nodes.text.value='keep';ui.state.save();resolve();
  ui.state.finish(await old);assert.equal(ui.nodes.text.value,'keep');assert.equal(ui.state.selected('one'),'new');
});

test('broken browser storage does not prevent in-tab switching',async()=>{
  const storage=new Map([['codast.chat-state.v1','{broken']]);const ui=screen(storage);
  ui.context.localStorage.setItem=()=>{throw Error('quota');};
  await open(ui,'constructor','A');ui.nodes.text.value='recoverable';await open(ui,'constructor','B');
  await open(ui,'constructor','A');assert.equal(ui.nodes.text.value,'recoverable');
});

test('rename moves the draft and duplicate draft names are rejected',async()=>{
  const ui=screen();await open(ui,'one','A');ui.nodes.text.value='draft';
  ui.state.rename('one','A','A');await open(ui,'one','A');assert.equal(ui.nodes.text.value,'draft');
  ui.state.rename('one','A','renamed');await open(ui,'one','renamed');assert.equal(ui.nodes.text.value,'draft');
  assert.ok(!ui.state.drafts('one').includes('A'));
  await open(ui,'one','B');ui.nodes.text.value='other';ui.state.save();
  assert.throws(()=>ui.state.checkRename('one','renamed','B'),/같은 이름/);
});

test('request retries retain identity across reload and acknowledgement rotates it',async()=>{
  const ui=screen();ui.context.crypto=require('node:crypto').webcrypto;
  const payload={text:'run',task:'A',client:'mock'};
  const first=ui.state.request('one','A',payload);
  const reloaded=screen(ui.storage);reloaded.context.crypto=require('node:crypto').webcrypto;
  assert.equal(reloaded.state.request('one','A',payload),first);
  assert.notEqual(reloaded.state.request('one','B',payload),first);
  reloaded.state.acknowledge('one','A','unrelated');
  assert.equal(reloaded.state.request('one','A',payload),first);
  reloaded.state.acknowledge('one','A',first);
  assert.notEqual(reloaded.state.request('one','A',payload),first);
  assert.notEqual(reloaded.state.request('one','A',{...payload,text:'changed'}),first);
});

test('legacy mock drafts retain text but restore a real agent and clear mock model',async()=>{
  const ui=screen();await open(ui,'one','A');ui.nodes.text.value='keep draft';ui.nodes.client.value='mock';ui.context.model='test-only';ui.state.save();
  const result=await ui.state.restore('one','A',{...defaults,client:'claude'});ui.state.finish(result);
  assert.equal(ui.nodes.text.value,'keep draft');assert.equal(ui.nodes.client.value,'claude');assert.equal(ui.context.model,null);
  await open(ui,'one','B');ui.nodes.client.value='mock';ui.state.save();
  const fallback=await ui.state.restore('one','B',{...defaults,client:'mock'});ui.state.finish(fallback);
  assert.equal(ui.nodes.client.value,'codex');
});
