const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const file='app/web/static/plugins.js';
const source=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
const sample=(id='sample@catalog',enabled=true)=>({id,name:id.split('@')[0],version:'1.0',scope:'user',enabled,revision:'a'.repeat(64),marketplace:'catalog',description:'Sample',components:{skills:['review']},actions:{enable:true,disable:true,update:true,remove:true},reason:''});
function screen(api){
  const nodes={},events={};let page;
  class Node{
    constructor(tag,text='',cls=''){this.tag=tag;this.textContent=text;this.className=cls;this.children=[];this.attributes={};this.events={};this.value='';this.scrollTop=0;this.hidden=false;this.classList={add:()=>{}};}
    set id(value){this._id=value;nodes[value]=this;}get id(){return this._id;}
    append(...children){this.children.push(...children);}replaceChildren(...children){this.children=children;}
    setAttribute(key,value){this.attributes[key]=value;}addEventListener(key,fn){(this.events[key]??=[]).push(fn);}
    async fire(key,event={}){await this['on'+key]?.(event);for(const fn of this.events[key]||[])await fn(event);}
    focus(){this.focused=true;}
  }
  nodes.project=new Node('select');nodes.project.value='demo';
  const el=(...args)=>new Node(...args),button=(label,fn,cls)=>{const node=el('button',label,cls);node.onclick=fn;return node;};
  const context={el,button,$:id=>nodes[id],api,console,encodeURIComponent,confirm:()=>false,
    window:{settingsPage:{register(key,label,node){page=node;}},addEventListener(key,fn){events[key]=fn;}},location:{hash:'#settings/plugins'}};
  context.window.confirm=()=>context.confirm();vm.createContext(context);vm.runInContext(source,context);
  const all=(node=page)=>node?[node,...node.children.flatMap(n=>all(n))]:[];
  return {nodes,context,all,get page(){return page;},open:()=>page?.fire('settings-open')};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('plugin tabs preserve independent search and scroll while showing real inventory',async()=>{
  const ui=screen(async path=>({plugins:[sample(path.endsWith('codex')?'first@catalog':'second@catalog')]}));
  assert.ok(ui.page,'plugin settings page is registered');await ui.open();
  const search=ui.nodes['plugin-search-codex'];search.value='first';await search.fire('input');
  ui.nodes['plugin-list-codex'].scrollTop=160;
  await ui.nodes['plugin-tab-claude'].fire('click');await tick();
  assert.equal(ui.nodes['plugin-search-claude'].value,'');
  await ui.nodes['plugin-tab-codex'].fire('click');
  assert.equal(search.value,'first');assert.equal(ui.nodes['plugin-list-codex'].scrollTop,160);
  assert.equal(ui.nodes['plugin-tab-codex'].attributes['aria-selected'],'true');
});

test('a late inventory from another project never overwrites current plugins',async()=>{
  let finish;const ui=screen(path=>path.includes('/demo/')?new Promise(resolve=>finish=resolve):Promise.resolve({plugins:[sample('new@catalog')]}));
  assert.ok(ui.page);const old=ui.open();await tick();ui.nodes.project.value='next';await ui.nodes.project.fire('change');await tick();
  finish({plugins:[sample('old@catalog')]});await old;
  assert.ok(ui.all().some(n=>n.textContent==='new'));
  assert.ok(!ui.all().some(n=>n.textContent==='old'));
});

test('failed mutation restores the observed toggle and keeps its error visible',async()=>{
  const calls=[];const ui=screen(async(path,method,body)=>{calls.push({path,method,body});if(method==='POST')throw Error('blocked');return {plugins:[sample()]};});
  assert.ok(ui.page);await ui.open();await ui.nodes['plugin-tab-claude'].fire('click');await tick();
  const toggle=ui.all(ui.nodes['plugin-pane-claude']).find(n=>n.tag==='input'&&n.attributes.role==='switch'&&!n.disabled);
  toggle.checked=false;await toggle.fire('change');
  assert.equal(calls.find(c=>c.method==='POST').body.action,'disable');
  assert.ok(ui.all().some(n=>n.tag==='input'&&n.attributes.role==='switch'&&n.checked===true));
  assert.match(ui.nodes['plugin-status-claude'].textContent,/blocked/);
});

test('unsupported actions are disabled and cancelling removal sends no mutation',async()=>{
  const calls=[];const row=sample();row.actions.enable=false;row.actions.disable=false;
  const ui=screen(async(path,method)=>{calls.push(method);return {plugins:[row]};});
  assert.ok(ui.page);await ui.open();
  assert.ok(ui.all().find(n=>n.attributes.role==='switch').disabled);
  await ui.all().find(n=>n.tag==='button'&&n.textContent==='제거').fire('click');
  assert.ok(!calls.includes('POST'));
});
