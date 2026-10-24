const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app/web/static/app.js','utf8');

function client(status,detail){
  const context={fetch:async()=>({ok:status<400,status,json:async()=>({detail})})};
  vm.createContext(context);vm.runInContext(source.slice(0,source.indexOf('let streams=[];')),context);
  return context.api;
}

test('project name validation identifies the field and correction without exposing raw input',async()=>{
  const detail=[{type:'string_pattern_mismatch',loc:['body','name'],msg:'String should match pattern',input:'가상/프로젝트',ctx:{pattern:'restricted-project-name'}}];
  for(const path of ['/workspaces','/projects']){
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

test('both project name inputs enforce the server character rules in current browsers',()=>{
  const html=fs.readFileSync('app/web/templates/index.html','utf8');
  for(const id of ['name','workspace-name']){
    const input=html.match(new RegExp('<input id="'+id+'"[^>]*>'))[0];
    const pattern=new RegExp('^(?:'+input.match(/pattern="([^"]+)"/)[1]+')$','v');
    for(const name of ['a','1project','sample-project','sample_project','가상프로젝트','테스트-Project_1','ㄱㄴ_실험','\u1100\u1161','가'.repeat(64)])assert.ok(pattern.test(name),name);
    for(const name of ['','가상 프로젝트','가상/하위','가상\\하위','가상:비밀','_sample','-sample','가'.repeat(65)])assert.equal(pattern.test(name),false,name);
  }
});
