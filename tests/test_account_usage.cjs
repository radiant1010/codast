const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app/web/static/sessions.js','utf8');
const account=(client,percent)=>({state:'available',limits:[{bucket:client,name:client==='claude'?'Claude':'Codex',usedPercent:percent,windowDurationMins:300,resetsAt:1767225600}],models:[],source:'fixture',checked_at:'2026-01-01T00:00:00Z'});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function screen(replies){
  class Node{
    constructor(tag,text=''){this.tag=tag;this.text=text??'';this.children=[];}
    append(...nodes){this.children.push(...nodes);}
    replaceChildren(...nodes){this.children=nodes;}
    setAttribute(){}
    get textContent(){return [this.text,...this.children.map(n=>n.textContent)].join(' ');}
  }
  const rows=new Node('tbody'),body=new Node('div'),states=[];
  const context={el:(tag,text)=>new Node(tag,text),account:{},accountRows:rows,accountBody:body,
    queryStatus:()=>((...args)=>states.push(args)),document:{hidden:false},setInterval:()=>{},
    api:async path=>{const value=replies[path.includes('/claude/')?'claude':'codex'];if(value instanceof Error)throw value;return value;}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function accountPlaceholder('),source.indexOf('  const metrics='))+
    source.slice(source.indexOf('  let statusBusy=false;'),source.indexOf('  const alertBox=')),context);
  return {rows,body,states,refresh:()=>context.refreshAccount()};
}
test('both providers display actual limits including zero and reset time',async()=>{
  const ui=screen({codex:account('codex',25),claude:account('claude',0)});await tick();
  assert.match(ui.rows.textContent,/Codex 5시간 25%/);
  assert.match(ui.rows.textContent,/Claude 5시간 0%/);
  assert.doesNotMatch(ui.rows.textContent,/미수집/);
  assert.match(ui.body.textContent,/Claude/);
  assert.equal(ui.rows.children[1].children[2].textContent.includes('—'),false);
});
test('Claude auth failures replace old numbers without hiding Codex limits',async()=>{
  const replies={codex:account('codex',25),claude:account('claude',42)};
  const ui=screen(replies);await tick();
  replies.claude={state:'login_required',limits:[]};await ui.refresh();
  assert.match(ui.rows.textContent,/Codex 5시간 25%/);
  assert.match(ui.rows.textContent,/Claude 로그인 필요/);
  assert.doesNotMatch(ui.rows.textContent,/42%/);
  assert.equal(ui.states.at(-1)[0],'error');
});
test('Codex request failure leaves Claude limits visible',async()=>{
  const ui=screen({codex:new Error('private error'),claude:account('claude',12)});await tick();
  assert.match(ui.rows.textContent,/Codex 조회 실패/);
  assert.match(ui.rows.textContent,/Claude 5시간 12%/);
  assert.doesNotMatch(ui.body.textContent,/private error/);
});
test('temporary failures retain prior numbers and label them as the last observation',async()=>{
  const replies={codex:account('codex',25),claude:account('claude',42)};
  const ui=screen(replies);await tick();
  replies.codex=new Error('offline');replies.claude=account('claude',43);await ui.refresh();
  assert.match(ui.rows.textContent,/Codex 5시간 25%.*마지막 조회/);
  assert.match(ui.rows.textContent,/Codex 조회 실패/);
  assert.match(ui.rows.textContent,/Claude 5시간 43%/);
});
test('rate limits and missing percentages are not shown as zero',async()=>{
  const ui=screen({codex:account('codex',null),claude:{state:'rate_limited',limits:[]}});await tick();
  assert.match(ui.rows.textContent,/미수신/);
  assert.match(ui.rows.textContent,/Claude 조회 제한/);
  assert.doesNotMatch(ui.rows.textContent,/0%/);
});
