const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('app/web/static/setup.js','utf8');
const finish=source.slice(source.indexOf('  async function finish(){'),source.indexOf('  async function open('));

for(const timeout_seconds of [null,7200])for(const client of ['codex','claude'])test('connection setup preserves timeout '+timeout_seconds+' when switching to '+client,async()=>{
  let written,displayed;
  const previous=client==='codex'?{client:'claude',reasoning_effort:'xhigh',ultracode:true}:{client:'codex',reasoning_effort:'ultra',ultracode:null};
  const settings={cwd:'.',context_paths:['guide.md'],mode:'read-only',model:'old',...previous,timeout_seconds};
  const nodes={client:{value:'codex'},cwd:{value:'.'},mode:{value:'read-only'}};
  const context={inspect:async()=>{},state:{status:'completed'},project:{value:'one'},client:{value:client},
    projects:async()=>{},loadProject:async()=>{},$:id=>nodes[id],base:()=>'/projects/one',selectedPaths:()=>['guide.md'],
    api:async(path,method,body)=>{assert.equal(path,'/projects/one/settings');if(method==='PUT'){written=body;return {...body};}return settings;},
    window:{loadModelChoices:async()=>{},runRuntime:{loadSettings:value=>displayed=value}},
    actionHint(){},dialog:{close(){}},notice(){}};
  vm.createContext(context);vm.runInContext(finish,context);await context.finish();
  assert.equal(written.timeout_seconds,timeout_seconds);
  assert.equal(written.client,client);assert.equal(written.model,null);
  assert.equal(written.reasoning_effort??null,null);assert.equal(written.ultracode??null,null);
  assert.equal(displayed.timeout_seconds,timeout_seconds);
});
