const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function fixture(){
 const nodes={};const $=id=>nodes[id]??={value:'',disabled:false,textContent:'',open:false,addEventListener(){},showModal(){this.open=true;},close(){this.open=false;}};
 let reply={path:null};const calls=[];
 const context={$ ,api:async(...args)=>{calls.push(args);if(reply instanceof Error)throw reply;return reply;},projects:async()=>{},loadProject:async()=>{},notice:()=>{}};
 vm.createContext(context);vm.runInContext(fs.readFileSync('app/web/static/workspaces.js','utf8'),context);
 return {$,calls,reply:value=>reply=value};
}
test('manual path enables registration and sends trimmed path',async()=>{
 const f=fixture();f.$('add-workspace').onclick();f.$('workspace-path').value=' C:/sample ';f.$('workspace-path').oninput();
 assert.equal(f.$('register-folder').disabled,false);f.$('workspace-name').value='sample';
 await f.$('register-workspace').onsubmit({preventDefault(){}});
 assert.equal(f.calls[0][2].path,'C:/sample');assert.equal(f.$('workspace-dialog').open,false);
});
test('cancel and picker error preserve path and restore controls',async()=>{
 const f=fixture();f.$('choose-workspace').onclick();f.$('workspace-path').value='C:/keep';
 await f.$('pick-folder').onclick();assert.equal(f.$('workspace-path').value,'C:/keep');assert.match(f.$('folder-status').textContent,/취소/);
 f.reply(new Error('시간 초과'));await f.$('pick-folder').onclick();
 assert.equal(f.$('folder-status').textContent,'시간 초과');
 for(const id of ['pick-folder','cancel-workspace','register-folder'])assert.equal(f.$(id).disabled,false);
});
test('successful selection populates path and suggested project name',async()=>{
 const f=fixture();f.$('add-workspace').onclick();f.reply({path:'C:/sample-project'});await f.$('pick-folder').onclick();
 assert.equal(f.$('workspace-path').value,'C:/sample-project');assert.equal(f.$('workspace-name').value,'sample-project');assert.equal(f.$('register-folder').disabled,false);
});
