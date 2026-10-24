const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function fixture(){
 const nodes={};const $=id=>nodes[id]??={value:'',disabled:false,textContent:'',open:false,options:[],addEventListener(){},focus(){},select(){},showModal(){this.open=true;},close(){this.open=false;}};
 let reply={path:null};const calls=[];
 const context={$ ,api:async(...args)=>{calls.push(args);if(reply instanceof Error)throw reply;return reply;},projects:async()=>{},loadProject:async()=>{},notice:()=>{},projectNames:{one:'기존이름'},projectLabel:name=>context.projectNames[name]||name,window:{dispatchEvent(){}},Event:class{}};
 vm.createContext(context);vm.runInContext(fs.readFileSync('app/web/static/workspaces.js','utf8'),context);
 return {$,calls,reply:value=>reply=value,context};
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

test('Korean folder names are preserved in the suggestion and registration',async()=>{
 const f=fixture();f.$('add-workspace').onclick();f.reply({path:'C:/가상프로젝트'});await f.$('pick-folder').onclick();
 assert.equal(f.$('workspace-name').value,'가상프로젝트');
 await f.$('register-workspace').onsubmit({preventDefault(){}});
 assert.equal(f.calls[1][2].name,'가상프로젝트');assert.equal(f.$('workspace-dialog').open,false);
});

test('project rename opens with the current label and cancel does not save',()=>{
 const f=fixture();f.$('project').value='one';f.$('rename-project').onclick();
 assert.equal(f.$('rename-project-name').value,'기존이름');assert.equal(f.$('rename-project-dialog').open,true);
 f.$('cancel-project-name').onclick();assert.equal(f.calls.length,0);assert.equal(f.$('rename-project-dialog').open,false);
});

test('project rename preserves selection and draft state while updating the visible name',async()=>{
 const f=fixture();let reloads=0;f.context.loadProject=async()=>reloads++;
 f.$('project').value='one';f.$('project').options=[{value:'one',textContent:'기존이름'}];
 f.$('manage-project-name').onclick();f.$('rename-project-name').value='수정한이름';f.reply({name:'one',display_name:'수정한이름'});
 await f.$('rename-project-form').onsubmit({preventDefault(){}});
 assert.equal(f.calls[0][0],'/projects/one');assert.equal(f.calls[0][1],'PATCH');assert.equal(f.calls[0][2].name,'수정한이름');
 assert.equal(f.$('project').value,'one');assert.equal(f.$('project').options[0].textContent,'수정한이름');
 assert.equal(f.context.projectNames.one,'수정한이름');assert.equal(reloads,0);assert.equal(f.$('rename-project-dialog').open,false);
});

test('failed rename keeps the input and previous label for retry',async()=>{
 const f=fixture();f.$('project').value='one';f.$('rename-project').onclick();f.$('rename-project-name').value='중복이름';f.reply(new Error('이미 사용 중인 프로젝트 이름입니다.'));
 await f.$('rename-project-form').onsubmit({preventDefault(){}});
 assert.equal(f.$('rename-project-dialog').open,true);assert.equal(f.$('rename-project-name').value,'중복이름');
 assert.match(f.$('rename-project-status').textContent,/이미 사용/);assert.equal(f.context.projectNames.one,'기존이름');
 assert.equal(f.$('save-project-name').disabled,false);assert.equal(f.$('cancel-project-name').disabled,false);
});

test('pending rename submits once and never switches back to a previously selected project',async()=>{
 const f=fixture();let finish;f.reply(new Promise(resolve=>finish=resolve));
 f.$('project').value='one';f.$('rename-project').onclick();f.$('rename-project-name').value='수정한이름';
 const pending=f.$('rename-project-form').onsubmit({preventDefault(){}});
 await f.$('rename-project-form').onsubmit({preventDefault(){}});f.$('cancel-project-name').onclick();
 assert.equal(f.calls.length,1);assert.equal(f.$('rename-project-dialog').open,true);
 f.$('project').value='two';finish({name:'one',display_name:'수정한이름'});await pending;
 assert.equal(f.$('project').value,'two');assert.equal(f.context.projectNames.one,'수정한이름');
});
