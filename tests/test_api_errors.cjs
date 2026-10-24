const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app/web/static/app.js','utf8');

function fixture(fetch){
  const context={fetch,window:{dispatchEvent(){}},Event};
  vm.createContext(context);vm.runInContext(source.slice(0,source.indexOf('let streams=[];')),context);
  return context;
}
function client(status,detail){return fixture(async()=>new Response(JSON.stringify({detail}),{status})).api;}

test('non-JSON and empty server failures retain HTTP status and exact diagnostics',async()=>{
  for(const [status,raw] of [[500,'Internal Server Error'],[502,'<html>Bad gateway</html>'],[503,''],[500,'null'],[500,'{"detail":{"code":"internal"}}']]){
    const f=fixture(async()=>new Response(raw,{status}));
    await assert.rejects(f.api('/projects'),error=>{
      assert.equal(error.status,status);assert.match(error.message,/서버|연결/);
      assert.doesNotMatch(error.message,/Unexpected|JSON|<html>|internal|Cannot read/);return true;
    });
    const log=vm.runInContext('requestErrors[0]',f);
    assert.equal(log.raw,raw);assert.equal(log.status,status);assert.equal(log.path,'/projects');
  }
});

test('invalid success responses and network failures are readable, cancellation remains cancellation',async()=>{
  for(const raw of ['','null','broken','<html>login</html>']){
    const f=fixture(async()=>new Response(raw));
    await assert.rejects(f.api('/projects'),error=>/응답.*형식/.test(error.message));
    assert.equal(vm.runInContext('requestErrors[0].raw',f),raw);
  }
  const f=fixture(async()=>{throw new TypeError('Failed to fetch');});
  await assert.rejects(f.api('/projects'),/서버.*연결/);
  assert.match(vm.runInContext('requestErrors[0].raw',f),/Failed to fetch/);
  const aborted=new DOMException('aborted','AbortError'),cancel=fixture(async()=>{throw aborted;});
  await assert.rejects(cancel.api('/projects'),error=>error===aborted);
  assert.equal(vm.runInContext('requestErrors.length',cancel),0);
});

test('uploads and downloads share validation without changing binary content or request options',async()=>{
  const detail=[{type:'string_too_long',loc:['query','filename'],ctx:{max_length:255}}];
  const failed=fixture(async()=>new Response(JSON.stringify({detail}),{status:422}));
  for(const type of ['json','blob'])await assert.rejects(failed.request('/materials',{method:'POST',body:'file'},type),/파일 이름.*255/);
  const bytes=new Uint8Array([80,75,0,255]),options={method:'POST',body:bytes,signal:new AbortController().signal};
  const success=fixture(async(url,actual)=>{assert.equal(url,'/api/export');assert.equal(actual,options);return new Response(bytes);});
  assert.deepEqual(new Uint8Array(await (await success.request('/export',options,'blob')).arrayBuffer()),bytes);
});

test('project name validation identifies the field and correction without exposing raw input',async()=>{
  const detail=[{type:'string_pattern_mismatch',loc:['body','name'],msg:'String should match pattern',input:'가상/프로젝트',ctx:{pattern:'restricted-project-name'}}];
  for(const path of ['/workspaces','/projects','/projects/legacy']){
    await assert.rejects(client(422,detail)(path,'POST',{}),error=>{
      assert.equal(error.status,422);
      assert.match(error.message,/프로젝트 이름 형식 오류/);
      assert.match(error.message,/한글.*영문.*숫자/);assert.match(error.message,/64/);
      assert.doesNotMatch(error.message,/string_pattern_mismatch|"loc"|가상\/프로젝트|restricted-project-name/);
      return true;
    });
  }
});

test('validation messages explain missing fields and length limits in Korean',async()=>{
  const detail=[{type:'missing',loc:['body','path'],msg:'Field required',input:{}},
    {type:'string_too_long',loc:['body','text'],msg:'String should have at most 8000 characters',input:'private-input',ctx:{max_length:8000}}];
  await assert.rejects(client(422,detail)('/workspaces','POST',{}),error=>{
    assert.match(error.message,/경로.*필수/);assert.match(error.message,/메시지.*8,000/);
    assert.doesNotMatch(error.message,/Field required|String should|private-input/);return true;
  });
});

test('unrecognized error details produce a readable fallback without dumping server data',async()=>{
  for(const detail of [{trace:'private-input'},[{type:'future_error',loc:['body','unknown'],msg:'internal implementation',input:'private-input'}],null]){
    await assert.rejects(client(500,detail)('/workspaces'),error=>{
      assert.equal(error.status,500);assert.match(error.message,/오류/);
      assert.doesNotMatch(error.message,/private-input|future_error|internal implementation|trace/);return true;
    });
  }
});

test('existing readable server errors and successful responses stay intact',async()=>{
  await assert.rejects(client(409,'이미 등록한 폴더입니다.')('/workspaces'),error=>error.status===409&&error.message==='이미 등록한 폴더입니다.');
  assert.equal((await client(200,'정상')('/projects')).detail,'정상');
});

test('unsupported server requests explain how to apply a server update',async()=>{
  await assert.rejects(client(405,'Method Not Allowed')('/projects/legacy','PATCH',{name:'변경'}),error=>{
    assert.equal(error.status,405);assert.match(error.message,/405/);assert.match(error.message,/서버.*재시작/);
    assert.match(error.message,/새로고침/);assert.doesNotMatch(error.message,/Method Not Allowed/);return true;
  });
});

test('both project name inputs enforce the server character rules in current browsers',()=>{
  const html=fs.readFileSync('app/web/templates/index.html','utf8');
  for(const id of ['name','workspace-name']){
    const input=html.match(new RegExp('<input id="'+id+'"[^>]*>'))[0];
    const pattern=new RegExp('^(?:'+input.match(/pattern="([^"]+)"/)[1]+')$','v');
    for(const name of ['a','1project','sample-project','sample_project','가상프로젝트','테스트-Project_1','ㄱㄴ_실험','\u1100\u1161','가'.repeat(64)])assert.ok(pattern.test(name),name);
    for(const name of ['','가상 프로젝트','가상/하위','가상\\하위','가상:비밀','_sample','-sample','가'.repeat(65)])assert.equal(pattern.test(name),false,name);
  }
});
