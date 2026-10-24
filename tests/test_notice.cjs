const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const nodes={},timers=new Map();let next=0;
 const $=id=>nodes[id]??={textContent:'',error:false,setAttribute(name,value){this[name]=value;},classList:{toggle(name,on){nodes[id][name]=on;}}};
 const context={$ ,setTimeout(fn,delay){timers.set(++next,{fn,delay});return next;},clearTimeout(id){timers.delete(id);}};
 vm.createContext(context);
 const source=fs.readFileSync('app/web/static/app.js','utf8');
 vm.runInContext(source.slice(source.indexOf('let noticeTimer;'),source.indexOf('const projectNameError=')),context);
 return {...context,timers};
}
test('completion notices disappear after four seconds without occupying inline space',()=>{
 const f=fixture();f.notice('복원 완료',false,{success:true});
 assert.equal(f.$('status').textContent,'');assert.equal(f.$('status-toast').textContent,'복원 완료');
 assert.equal(f.$('status-toast')['is-success'],true);assert.equal(f.$('status-toast')['is-error'],false);
 const timer=[...f.timers.values()][0];assert.equal(timer.delay,4000);timer.fn();
 assert.equal(f.$('status-toast').textContent,'');
});
test('an error toast expires while its inline recovery message remains',()=>{
 const f=fixture();f.notice('완료',false,{success:true});f.notice('다시 확인하세요.',true);
 assert.equal(f.$('status-toast').textContent,'다시 확인하세요.');assert.equal(f.$('status').textContent,'다시 확인하세요.');
 assert.equal(f.$('status').error,true);assert.equal(f.$('status-toast')['is-error'],true);assert.equal(f.$('status-toast')['is-success'],false);
 assert.equal(f.$('status-toast')['aria-hidden'],'true','The inline status announces the error once');
 [...f.timers.values()][0].fn();assert.equal(f.$('status-toast').textContent,'');assert.equal(f.$('status').textContent,'다시 확인하세요.');
});
test('ongoing connection notices remain inline and never expire',()=>{
 const f=fixture();f.notice('완료',false,{success:true});f.notice('연결을 다시 확인하고 있습니다.',false,{persistent:true});
 assert.equal(f.$('status-toast').textContent,'');assert.equal(f.$('status').textContent,'연결을 다시 확인하고 있습니다.');
 assert.equal(f.$('status').error,false);assert.equal(f.timers.size,0);
});
test('general information clears prior success and error colors',()=>{
 const f=fixture();f.notice('완료',false,{success:true});f.notice('오류',true);f.notice('프로젝트를 선택하세요.');
 assert.equal(f.$('status-toast')['is-success'],false);assert.equal(f.$('status-toast')['is-error'],false);
 assert.equal(f.$('status-toast')['aria-hidden'],'false');assert.equal(f.$('status').textContent,'');
});
test('a new toast resets its timer and an explicit clear cancels it',()=>{
 const f=fixture();f.notice('첫 번째');f.notice('두 번째');
 assert.equal(f.timers.size,1);assert.equal(f.$('status-toast').textContent,'두 번째');
 f.notice('');assert.equal(f.timers.size,0);assert.equal(f.$('status-toast').textContent,'');
});
