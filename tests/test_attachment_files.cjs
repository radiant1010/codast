const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const queued=[],body={children:[],append(node){this.children.push(node);}};let serial=0;
 const el=(tag,text)=>({tag,textContent:text,children:[],events:{},open:false,
  append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;},setAttribute(){},
  addEventListener(name,handler){this.events[name]=handler;},showModal(){this.open=true;},
  close(){if(!this.open)return;this.open=false;queued.push(()=>this.events.close?.());}});
 const context={window:{},document:{body},el,button:(text,click)=>Object.assign(el('button',text),{click}),crypto:{randomUUID:()=>String(++serial)},setTimeout};
 vm.runInNewContext(fs.readFileSync('app/web/static/attachment-files.js','utf8'),context);
 const dialog=body.children[0],flush=()=>{while(queued.length)queued.shift()();};
 return {api:context.window.attachmentFiles,dialog,flush,list:dialog.children[2],confirm:dialog.children[3]};
}
test('late workflow close cannot cancel a newly opened chat attachment choice',async()=>{
 const f=fixture(),workflow=f.api.choose([{name:'first.txt'}],'workflow');
 f.confirm.click();assert.equal((await workflow)[0].mode,'original');
 const chat=f.api.choose([{name:'second.txt'}],'chat');
 f.flush();f.api.cancelChoice('workflow');f.flush();
 assert.equal(f.dialog.open,true);
 assert.equal(f.list.children.length,1);
 assert.equal(f.list.children[0].children[0].textContent,'second.txt');
 f.list.children[0].children[1].value='text';f.confirm.click();
 assert.equal((await chat)[0].mode,'text');f.flush();
});
test('cancellation resolves no files and unknown modes never claim protection',async()=>{
 const f=fixture(),choice=f.api.choose([{name:'pending.txt'}]);
 assert.equal(f.api.label(null),'확인 중');assert.equal(f.api.label({}),'텍스트 변환');
 f.api.cancelChoice();f.flush();assert.equal((await choice).length,0);
 assert.equal(f.list.children.length,0);
});
