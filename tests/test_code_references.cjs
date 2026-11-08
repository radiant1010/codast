// #15 CV-2 acceptance: file reference recognition in AI answers (window.codeReferences).
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const SOURCE='app/web/static/code-viewer.js';
function references(){
  assert.ok(fs.existsSync(SOURCE),SOURCE+' does not exist yet');
  const context={window:{addEventListener(){}},document:{addEventListener(){},readyState:'loading'},
    location:{href:'http://127.0.0.1:8765/'},URL,decodeURIComponent,console};
  vm.createContext(context);vm.runInContext(fs.readFileSync(SOURCE,'utf8'),context);
  assert.ok(context.window.codeReferences,'code-viewer.js must define window.codeReferences without a DOM');
  return context.window.codeReferences;
}
const ref=(path,line=null,endLine=null,column=null)=>({path,line,endLine,column});
const plain=value=>value&&JSON.parse(JSON.stringify(value));

test('inline code references are parsed into path, line range and column',()=>{
  const {parse}=references();
  const cases=[
    ['cli.py:18',ref('cli.py',18)],
    ['app/llm/cli.py',ref('app/llm/cli.py')],
    ['app\\llm\\cli.py:7',ref('app\\llm\\cli.py',7)],
    ['ExampleService.java:42',ref('ExampleService.java',42)],
    ['C:\\repo\\project\\main.rs:12:5',ref('C:\\repo\\project\\main.rs',12,null,5)],
    ['C:/repo/main.rs',ref('C:/repo/main.rs')],
    ['/home/user/app/main.py:7',ref('/home/user/app/main.py',7)],
    ['b/server/index.js#L10',ref('b/server/index.js',10)],
    ['src/app.ts#L42C5',ref('src/app.ts',42,null,5)],
    ['src/app.ts#L42-L50',ref('src/app.ts',42,50)],
    ['src/app.ts:42-50',ref('src/app.ts',42,50)],
    ['README.md:3',ref('README.md',3)],
    ['config.yaml',ref('config.yaml')],
    ['Dockerfile',ref('Dockerfile')],
    ['docs/README',ref('docs/README')],
  ];
  for(const [text,expected] of cases)assert.deepEqual(plain(parse(text)),expected,text);
});

test('code that only looks like a file name is not a reference',()=>{
  const {parse}=references();
  for(const text of ['os.path','window.renderMarkdown','s.storage','np.array','v1.2.3','e.g.','foo',
    'uv run start.py','12:30','node:test','file.py:abc','C:','https://example.com/a.py',''])
    assert.equal(parse(text),null,JSON.stringify(text));
});

test('markdown link targets that point to files are references',()=>{
  const {fromHref}=references();
  const cases=[
    ['app/llm/cli.py:18',ref('app/llm/cli.py',18)],
    ['C:\\DEV\\proj\\cli.py:18',ref('C:\\DEV\\proj\\cli.py',18)],
    ['file:///C:/x/y.py',ref('C:/x/y.py')],
    ['file:///home/u/y.py',ref('/home/u/y.py')],
    ['file:///C:/My%20Docs/y.py:3',ref('C:/My Docs/y.py',3)],
    ['src/app.ts#L42',ref('src/app.ts',42)],
    ['docs/guide',ref('docs/guide')],
    ['../README.md',ref('../README.md')],
  ];
  for(const [href,expected] of cases)assert.deepEqual(plain(fromHref(href)),expected,href);
});

test('web, mail, script and in-page links stay out of the code viewer',()=>{
  const {fromHref}=references();
  for(const href of ['https://example.com/docs','http://x.test/a.py','mailto:a@b.test','javascript:alert(1)','#section',''])
    assert.equal(fromHref(href),null,href);
});
