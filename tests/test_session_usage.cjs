const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app/web/static/sessions.js','utf8');
const usage=(used=100,window=1000,time='2026-01-02T00:00:00Z')=>({used_tokens:used,window_tokens:window,observed_at:time});
const row=(extra={})=>({project:'one',task:'chat',client:'claude',session_id:'a',runs:1,running:0,input_tokens:500,output_tokens:50,input_reports:1,output_reports:1,last_started_at:'2026-01-02T00:00:00Z',...extra});
function screen(snapshot){
  class Node{
    constructor(text=''){this.text=text??'';this.children=[];this.classList={toggle(){}};}
    append(...nodes){this.children.push(...nodes);}
    replaceChildren(...nodes){this.children=nodes;}
    get lastChild(){return this.children.at(-1);}
    get textContent(){return [this.text,...this.children.map(n=>n.textContent)].join(' ');}
    set textContent(value){this.text=value;this.children=[];}
  }
  const nodes=new Map(),sessionRows=new Node();
  const context={window:{},snapshot,sessionRows,usageList:new Node(),envProject:new Node(),filter:'',
    $:id=>{if(!nodes.has(id))nodes.set(id,new Node());const n=nodes.get(id);n.value='one';return n;},
    el:(tag,text)=>new Node(text),button:text=>new Node(text),openChat:()=>{},projectLabel:name=>name};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  function contextCell('),source.indexOf('  window.refreshSessionView=')),context);
  context.renderUsage();
  return sessionRows;
}
test('uses latest session metrics while summing only cumulative run tokens',()=>{
  const table=screen({running:[],sessions:[],usage:[row({context_usage:usage(),execution_model:'old'}),
    row({session_id:'b',last_started_at:'2026-01-03T00:00:00Z',context_usage:usage(0),execution_model:'actual'})]});
  assert.match(table.textContent,/0.0% 1,100 actual/);
  assert.doesNotMatch(table.textContent,/old|미수집/);
});
test('connected native session appears even without local run history',()=>{
  const table=screen({running:[],usage:[],sessions:[row({metrics:{execution_model:'native',context_usage:usage(100)}})]});
  assert.match(table.textContent,/10.0% 미수신 native/);
  assert.match(table.children[0].children[2].title,/100 \/ 1,000/);
});
test('missing capacity keeps measured count and missing usage is never zero',()=>{
  const table=screen({running:[],sessions:[],usage:[row({context_usage:usage(42,null),execution_model:'actual'}),row({task:'unknown'})]});
  assert.match(table.textContent,/42 토큰/);
  assert.match(table.textContent,/측정값 없음/);
  assert.doesNotMatch(table.textContent,/0.0%/);
});
test('older native transcript does not replace newer measured capacity',()=>{
  const table=screen({running:[],usage:[row({context_usage:usage(100),execution_model:'actual'})],
    sessions:[row({metrics:{context_usage:usage(90,null,'2026-01-01T00:00:00Z'),execution_model:'old'}})]});
  assert.match(table.textContent,/10.0%.*actual/);
});
test('new running session clears old session metrics until it reports',()=>{
  const table=screen({usage:[row({context_usage:usage(),execution_model:'old'})],sessions:[],
    running:[{project:'one',command:{client:'claude',task:'chat'},metadata:{session_id:'b'},metrics:{},cancellable:true}]});
  assert.match(table.textContent,/실행 중 측정값 없음/);
  assert.doesNotMatch(table.textContent,/old/);
});
test('an older connection in another mode cannot override the latest local session',()=>{
  const table=screen({running:[],usage:[row({session_id:'new',execution_model:'new-model'})],sessions:[
    row({session_id:'new',metrics:{execution_model:'new-model'}}),
    row({session_id:'old',metrics:{execution_model:'old-model',context_usage:usage()}})]});
  assert.match(table.textContent,/측정값 없음.*new-model/);
  assert.doesNotMatch(table.textContent,/old-model/);
});
test('compaction marker prevents cached pre-compaction context from reappearing',()=>{
  const table=screen({running:[],usage:[row({execution_model:'actual',context_usage:usage(null,null,'2026-01-03T00:00:00+00:00')})],
    sessions:[row({metrics:{execution_model:'actual',context_usage:usage()}})]});
  assert.match(table.textContent,/측정값 없음/);
  assert.doesNotMatch(table.textContent,/10.0%/);
});
test('a model-only update cannot retain context from a different model',()=>{
  const table=screen({running:[],usage:[row({execution_model:'old',context_usage:usage()})],
    sessions:[row({metrics:{execution_model:'new'}})]});
  assert.match(table.textContent,/측정값 없음.*new/);
  assert.doesNotMatch(table.textContent,/10.0%/);
});
