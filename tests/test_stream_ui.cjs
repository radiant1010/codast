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
