const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync('app/web/static/app.js','utf8');
const fn=source.slice(source.indexOf('function streamRun('),source.indexOf("$('toggle-sidebar')"));
test('late SSE completion from a switched chat cannot refresh or notify the new chat',async()=>{
  const handlers={};let refreshes=0,notices=0,closed=0;
  const context={epoch:1,streams:[],valid:(_b,e)=>e===context.epoch,
    EventSource:class{addEventListener(name,fn){handlers[name]=fn;}close(){closed++;}},
    act:fn=>fn(),conversation:async()=>{refreshes++;},notice:()=>{notices++;}};
  vm.createContext(context);vm.runInContext(fn,context);
  const container={isConnected:true};context.streamRun('run','/projects/one',container,true);
  context.epoch=2;handlers.end();await new Promise(setImmediate);
  assert.equal(refreshes,0);assert.equal(notices,0);assert.equal(closed,1);
  context.streamRun('run','/projects/one',container,true);container.isConnected=false;
  handlers.end();await new Promise(setImmediate);assert.equal(refreshes,0);
  container.isConnected=true;context.streamRun('run','/projects/one',container,true);
  handlers.end();await new Promise(setImmediate);assert.equal(refreshes,1);assert.equal(notices,1);
});

test('detached server refreshes a live card once; saved replay never loops',async()=>{
 const handlers={};let refreshes=0,notices=0;
 const context={epoch:1,streams:[],valid:(_b,e)=>e===context.epoch,
 EventSource:class{addEventListener(name,fn){handlers[name]=fn;}close(){}},act:fn=>fn(),conversation:async()=>{refreshes++;},notice:()=>{notices++;}};
 vm.createContext(context);vm.runInContext(fn,context);const container={isConnected:true};
 context.streamRun('run','/projects/one',container,true);handlers.detached();await new Promise(setImmediate);assert.equal(refreshes,1);assert.equal(notices,1);
 context.streamRun('run','/projects/one',container,false);handlers.detached();await new Promise(setImmediate);assert.equal(refreshes,1);
 context.streamRun('run','/projects/one',container,true);context.epoch++;handlers.detached();await new Promise(setImmediate);assert.equal(refreshes,1);
});
const presentation=source.slice(source.indexOf('function consoleText('),source.indexOf('function base('));
test('console presentation preserves masked text, code and incomplete streamed fences',()=>{
 const context={el:()=>({})};vm.createContext(context);vm.runInContext(presentation,context);
 const raw='```text\n아이디: qwe***\n  <script>literal</script>\n```';
 const node=context.consoleOutput(raw);
 assert.equal(node.textContent,'아이디: qwe***\n  <script>literal</script>');assert.equal(node.consoleSource,raw);
 assert.equal(context.consoleText('````js\n```\ncode\n````'),'```\ncode');
 assert.equal(context.consoleText('~~~text\r\nvalue\r\n~~~'),'value\r');
 const partial='```text\n아이디: qwe***\n``';context.setConsoleOutput(node,partial);assert.equal(node.textContent,partial);
 context.setConsoleOutput(node,node.consoleSource+'`');assert.equal(node.textContent,'아이디: qwe***');
 assert.equal(context.consoleText('plain `code` **text**\n    indent'),'plain `code` **text**\n    indent');
});
const tokenSource=source.slice(source.indexOf('function tokenCount('),source.indexOf('function messageCard('));
test('token summary distinguishes missing counts and avoids double counting Codex cache',()=>{
 const context={};vm.createContext(context);vm.runInContext(tokenSource,context);
 assert.equal(context.tokenCount(null,'codex'),null);
 assert.equal(context.tokenCount({input_tokens:120},'codex'),null);
 assert.equal(context.tokenCount({input_tokens:120,output_tokens:30,cached_input_tokens:100},'codex'),150);
 assert.equal(context.tokenCount({input_tokens:0,output_tokens:0},'codex'),0);
 assert.equal(context.tokenCount({input_tokens:5,output_tokens:2,cache_read_input_tokens:10,cache_creation_input_tokens:20},'claude'),37);
 assert.equal(context.tokenCount({total_tokens:40,input_tokens:5,output_tokens:2},'codex'),40);
});
