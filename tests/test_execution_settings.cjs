const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync('app/web/static/execution-settings.js','utf8');
// Small DOM fixture for async settings transitions, without a browser dependency.
function screen(api){
  const nodes={};
  class Element {
    constructor(tag='div',text=''){this.tag=tag;this.textContent=text;this.options=[];this.listeners={};this._value='';this.checked=false;}
    set id(value){nodes[value]=this;this._id=value;} get id(){return this._id;}
    set value(value){this._value=value;} get value(){return this._value;}
    get selectedOptions(){return this.options.filter(o=>o.value===this.value);}
    setAttribute(){} append(){} after(){} focus(){} contains(){return false;}
    addEventListener(name,fn){this.listeners[name]=fn;}
    replaceChildren(...items){this.options=items;this.value=items[0]?.value||'';}
    add(item){this.options.push(item);}
    change(value){this.value=value;return this.listeners.change?.();}
    toggle(checked){this.checked=checked;return this.listeners.change?.();}
  }
  for(const id of ['client','text','execution-menu','model-picker','execution-summary']){const n=new Element();n.id=id;}
  nodes.client.value='codex';
  const context={window:{chatState:{save(){}}},document:{addEventListener(){}},$:id=>nodes[id],
    el:(tag,text)=>new Element(tag,text),Option:class{constructor(text,value){this.textContent=text;this.value=value;this.disabled=false;}},
    api,notice(){},act:fn=>fn()};
  vm.runInNewContext(source,context);return {nodes,settings:context.window};
}
const row=(model,efforts,extra={})=>({model,displayName:model,supportedReasoningEfforts:efforts.map(reasoningEffort=>({reasoningEffort})),...extra});

test('model switch removes unsupported effort and cross-provider commands do not inherit settings',async()=>{
  const ui=screen(async()=>({models:[row('strong',['high','ultra']),row('small',['low','high'])]}));
  await ui.settings.loadModelChoices('strong','ultra');
  assert.equal(ui.settings.selectedReasoningSettings().reasoning_effort,'ultra');
  ui.nodes['execution-model'].change('small');
  assert.equal(ui.settings.selectedReasoningSettings().reasoning_effort,null);
  ui.nodes['reasoning-effort'].value='high';ui.nodes.text.value='/claude hello';
  assert.equal(ui.settings.selectedExecutionModel(),null);
  assert.equal(ui.settings.selectedReasoningSettings(true).reasoning_effort,null);
});

test('late lookup cannot replace a newer agent, model or effort',async()=>{
  let resolve;
  const ui=screen(path=>path.includes('codex')?new Promise(done=>{resolve=done;}):Promise.resolve({version:'2.1.284',ultracode:true,models:[row('opus',['medium','xhigh'])]}));
  const old=ui.settings.loadModelChoices('old','ultra');
  ui.nodes.client.value='claude';await ui.settings.loadModelChoices('opus','medium',true);
  resolve({models:[row('old',['ultra'])]});await old;
  assert.equal(ui.settings.selectedConfiguredModel(),'opus');
  assert.equal(ui.settings.selectedReasoningSettings().reasoning_effort,'medium');
  assert.equal(ui.settings.selectedReasoningSettings().ultracode,true);
  assert.doesNotThrow(ui.settings.validateExecutionSettings);
});

test('failed lookup preserves saved settings but blocks unverified explicit effort',async()=>{
  const ui=screen(async()=>{throw Error('offline');});
  await ui.settings.loadModelChoices('saved','high');
  assert.equal(ui.settings.selectedConfiguredModel(),'saved');
  assert.equal(ui.settings.selectedReasoningSettings().reasoning_effort,'high');
  assert.throws(ui.settings.validateExecutionSettings,/지원 여부/);
  ui.nodes['reasoning-effort'].value='';assert.doesNotThrow(ui.settings.validateExecutionSettings);
});

test('Claude Ultracode stays independent and unavailable versions cannot dispatch it',async()=>{
  const ui=screen(async()=>({version:'2.1.284',ultracode:true,models:[row('opus',['low','xhigh'])]}));
  ui.nodes.client.value='claude';await ui.settings.loadModelChoices('opus','low',true);
  assert.equal(ui.settings.selectedReasoningSettings().reasoning_effort,'low');
  assert.equal(ui.settings.selectedReasoningSettings().ultracode,true);
  ui.nodes.ultracode.toggle(false);ui.nodes['execution-model'].change('');
  assert.equal(ui.settings.selectedReasoningSettings().ultracode,false);
  const old=screen(async()=>({version:'2.1.273',ultracode:false,models:[row('opus',['low','xhigh'])]}));
  old.nodes.client.value='claude';await old.settings.loadModelChoices('opus','low',true);
  assert.throws(old.settings.validateExecutionSettings,/2.1.284/);
  assert.equal(old.nodes.ultracode.disabled,false);
  old.nodes.ultracode.toggle(false);assert.doesNotThrow(old.settings.validateExecutionSettings);
  assert.equal(old.settings.selectedReasoningSettings(true).ultracode,false);
  assert.equal(old.nodes.ultracode.disabled,true);
});

test('Claude starts with Ultracode off and toggles serialize explicit booleans',async()=>{
  const ui=screen(async()=>({version:'2.1.284',ultracode:true,models:[row('opus',['medium','xhigh'])]}));
  ui.nodes.client.value='claude';await ui.settings.loadModelChoices('opus','medium');
  assert.equal(ui.settings.selectedReasoningSettings(true).ultracode,false);
  assert.equal(ui.nodes.ultracode.checked,false);
  ui.nodes.ultracode.toggle(true);
  assert.equal(ui.settings.selectedReasoningSettings(true).ultracode,true);
  assert.equal(ui.settings.selectedReasoningSettings(true).reasoning_effort,'medium');
  ui.nodes.ultracode.toggle(false);
  assert.equal(ui.settings.selectedReasoningSettings(true).ultracode,false);
  ui.nodes.text.value='/codex hello';
  assert.equal(ui.settings.selectedReasoningSettings(true).ultracode,null);
});

test('failed capability lookup still lets a saved Ultracode preference be turned off',async()=>{
  const ui=screen(async()=>{throw Error('offline');});
  ui.nodes.client.value='claude';await ui.settings.loadModelChoices(null,null,true);
  assert.throws(ui.settings.validateExecutionSettings,/Ultracode/);
  assert.equal(ui.nodes.ultracode.disabled,false);
  ui.nodes.ultracode.toggle(false);
  assert.doesNotThrow(ui.settings.validateExecutionSettings);
  assert.equal(ui.settings.selectedReasoningSettings(true).ultracode,false);
});

test('Codex does not validate or retain a hidden Claude preference',async()=>{
  const ui=screen(async()=>({models:[row('codex-model',['high'])]}));
  await ui.settings.loadModelChoices('codex-model','high',true);
  assert.doesNotThrow(ui.settings.validateExecutionSettings);
  assert.equal(ui.settings.selectedReasoningSettings().ultracode,null);
});
