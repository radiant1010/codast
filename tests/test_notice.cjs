const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const nodes={},timers=new Map();let next=0;
 const $=id=>nodes[id]??={textContent:'',error:false,classList:{toggle(name,on){nodes[id][name]=on;}}};
 const context={$ ,setTimeout(fn,delay){timers.set(++next,{fn,delay});return next;},clearTimeout(id){timers.delete(id);}};
 vm.createContext(context);
 const source=fs.readFileSync('app/web/static/app.js','utf8');
 vm.runInContext(source.slice(source.indexOf('let noticeTimer;'),source.indexOf('const projectNameError=')),context);
 return {...context,timers};
}
test('completion notices disappear after four seconds without occupying inline space',()=>{
 const f=fixture();f.notice('복원 완료');
 assert.equal(f.$('status').textContent,'');assert.equal(f.$('status-toast').textContent,'복원 완료');
 const timer=[...f.timers.values()][0];assert.equal(timer.delay,4000);timer.fn();
 assert.equal(f.$('status-toast').textContent,'');
});
test('errors and ongoing connection notices replace a toast and never expire',()=>{
 for(const error of [true,false]){
  const f=fixture();f.notice('완료');f.notice('다시 확인하세요.',error,{persistent:!error});
  assert.equal(f.$('status-toast').textContent,'');assert.equal(f.$('status').textContent,'다시 확인하세요.');
  assert.equal(f.$('status').error,error);assert.equal(f.timers.size,0);
 }
});
test('a new toast resets its timer and an explicit clear cancels it',()=>{
 const f=fixture();f.notice('첫 번째');f.notice('두 번째');
 assert.equal(f.timers.size,1);assert.equal(f.$('status-toast').textContent,'두 번째');
 f.notice('');assert.equal(f.timers.size,0);assert.equal(f.$('status-toast').textContent,'');
});
