const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const calls=[];
 function el(tag,text='',className=''){return {tag,textContent:text,className,children:[],value:'',append(...items){this.children.push(...items);},setAttribute(){},focus(){}};}
 const context={window:{},metadata:x=>x,el,button:(text,fn)=>Object.assign(el('button',text),{onclick:fn}),localStorage:{getItem(){return null;},setItem(){},removeItem(){}},crypto:{randomUUID:()=> 'fixture-request'},epoch:1,valid:()=>true,notice(){},api:async(...args)=>calls.push(args)};
 vm.createContext(context);vm.runInContext(fs.readFileSync('app/web/static/questions.js','utf8'),context);
 return {calls,card:meta=>context.window.questionCard({run_id:'fixture-run',metadata:{question:{question:'Which format?',choices:['JSON']},...meta}},'/projects/sample',async()=>{})};
}
for(const owner of [{workflow_id:'CDS-WF-fixture'},{parallel_group:'CDS-WF-fixture'}])test('managed question guides workflow answer without generic send controls '+JSON.stringify(owner),()=>{
 const f=fixture(),card=f.card(owner);
 assert.equal(card.children.some(x=>x.tag==='textarea'||x.tag==='button'),false);
 assert.match(card.children.at(-1).textContent,/워크플로/);
 assert.equal(f.calls.length,0);
});
test('ordinary chat question keeps choices, editable answer and run-specific reply',async()=>{
 const f=fixture(),card=f.card({});const [,,choices,input,send]=card.children;
 choices.children[0].onclick();assert.equal(input.value,'JSON');
 await send.onclick();assert.equal(f.calls.length,1);
 assert.equal(f.calls[0][0],'/projects/sample/runs/fixture-run/reply');
 assert.equal(f.calls[0][2].answer,'JSON');
});
test('answered question displays its durable receipt',()=>{
 const card=fixture().card({workflow_id:'CDS-WF-fixture',reply_run_id:'next'});
 assert.equal(card.children[0].textContent,'답변 접수됨');
 assert.match(card.children.at(-1).textContent,/이어진 실행/);
});
