const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const file='app/web/static/toolchain.js';
function screen(api){
  const nodes={};let page;
  class Node{
    constructor(tag,text='',cls=''){this.tag=tag;this.textContent=text;this.className=cls;this.children=[];this.attributes={};this.events={};this.value='';this.hidden=false;this.classList={add:()=>{}};}
    set id(value){this._id=value;nodes[value]=this;}get id(){return this._id;}
    append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}
    setAttribute(key,value){this.attributes[key]=value;}addEventListener(key,fn){this.events[key]=fn;}
    async fire(key,event={}){await this['on'+key]?.(event);await this.events[key]?.(event);}focus(){}
  }
  const el=(...args)=>new Node(...args),button=(label,fn)=>{const n=el('button',label);n.onclick=fn;return n;};
  const context={el,button,api,window:{settingsPage:{register(key,label,node){page=node;}},openConnections(){}},console};
  vm.createContext(context);if(fs.existsSync(file))vm.runInContext(fs.readFileSync(file,'utf8'),context);
  const all=(n=page)=>n?[n,...n.children.flatMap(c=>all(c))]:[];
  return {nodes,all,get page(){return page;},open:()=>page?.fire('settings-open')};
}
const row=(id,defaults,state)=>({id,name:id,default:defaults,description:'description',url:'https://example.com',clients:Object.fromEntries(['codex','claude'].map(c=>[c,{state,connection:'not_verified',guide:id+' guide'}]))});
const report=()=>({clients:{codex:{state:'installed',auth:'ready'},claude:{state:'installed',auth:'check_required'}},tools:[row('core',true,'installed'),row('github',false,'missing'),row('notion',false,'installed')],errors:[]});

test('opening tools is read-only and optional services are collapsed by default',async()=>{
  const calls=[];const ui=screen(async(path,method)=>{calls.push([path,method]);return report();});
  assert.ok(ui.page);await ui.open();
  assert.equal(calls.length,1);assert.equal(calls[0][0],'/toolchain');assert.ok(!calls[0][1]);
  assert.ok(ui.all().some(n=>String(n.textContent).includes('로그인 필요')));
  assert.equal(ui.nodes['tool-card-github'].hidden,true);
  ui.nodes['tool-filter'].value='all';await ui.nodes['tool-filter'].fire('change');
  assert.equal(ui.nodes['tool-card-github'].hidden,false);
  ui.nodes['tool-search'].value='notion';await ui.nodes['tool-search'].fire('input');
  assert.equal(ui.nodes['tool-card-github'].hidden,true);
});

test('connection instructions replace one pane without opening login windows',async()=>{
  const ui=screen(async()=>report());await ui.open();
  await ui.nodes['tool-guide-github-codex'].fire('click');
  assert.equal(ui.nodes['tool-help'].hidden,false);
  assert.ok(ui.all(ui.nodes['tool-help']).some(n=>String(n.textContent).includes('github guide')));
  await ui.nodes['tool-guide-notion-claude'].fire('click');
  assert.ok(!ui.all(ui.nodes['tool-help']).some(n=>String(n.textContent).includes('github guide')));
  assert.ok(ui.all(ui.nodes['tool-help']).some(n=>String(n.textContent).includes('notion guide')));
});

test('install is explicit, prevents double submission and retains partial failures',async()=>{
  let finish;const calls=[];const ui=screen(async(path,method,body)=>{calls.push({path,method,body});if(method==='POST')return new Promise(resolve=>finish=resolve);return report();});
  await ui.open();const run=ui.nodes['tool-install'].fire('click');
  assert.equal(ui.nodes['tool-install'].disabled,true);
  await ui.nodes['tool-install'].fire('click');
  finish({...report(),errors:[{client:'claude',tool:'core',message:'retry required'}]});await run;
  assert.equal(calls.filter(c=>c.method==='POST').length,1);
  assert.ok(ui.all().some(n=>String(n.textContent).includes('retry required')));
});
