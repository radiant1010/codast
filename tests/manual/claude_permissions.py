"""Synthetic native permission probes; no project source or credentials copied."""
import json, os, subprocess, threading, queue, time, sys
from pathlib import Path
from uuid import uuid4
from app.llm.cli import executable, ProcessRunner, CliAdapter
from app.core.questions import parse_question
ROOT=Path('work')/('claude-permission-'+uuid4().hex[:10]);ROOT.mkdir()
CWD=ROOT/'cwd';CWD.mkdir(); OUT=ROOT/'outside';OUT.mkdir()
report={'checks':{},'cases':{}}; PATH=executable('claude')
def save(): (ROOT/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
def summary(name,**values):
 report['checks'][name]=values;save();print(json.dumps({'check':name,**values},ensure_ascii=False),flush=True)
def launch(name,tools,host):
 args=[PATH,'-p','--output-format','stream-json','--verbose','--include-partial-messages','--permission-mode','default','--effort','low','--setting-sources=','--strict-mcp-config','--tools',tools,'--settings',json.dumps({'permissions':{'ask':['Write']}})]
 if host:args+=['--input-format','stream-json','--permission-prompt-tool','stdio']
 process=subprocess.Popen(args,cwd=str(CWD.resolve()),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
 q=queue.Queue();rows=[];errors=[]
 def read():
  for raw in iter(process.stdout.readline,b''):
   try:r=json.loads(raw)
   except ValueError:continue
   rows.append(r);q.put(r)
   with (ROOT/(name+'.jsonl')).open('a',encoding='utf-8') as f:f.write(raw.decode('utf-8'))
  q.put(None)
 threading.Thread(target=read,daemon=True).start()
 def stderr():
  for raw in iter(process.stderr.readline,b''):errors.append(raw.decode('utf-8',errors='replace'))
 threading.Thread(target=stderr,daemon=True).start()
 def send(obj):process.stdin.write((json.dumps(obj)+'\n').encode());process.stdin.flush()
 return process,q,rows,errors,send

def cleanup(p):
 if not p.stdin.closed:p.stdin.close()
 try:p.wait(timeout=8)
 except subprocess.TimeoutExpired:ProcessRunner().kill(p);p.wait(timeout=10)

# No-host behavior uses the same text input and EOF arrangement as CODAST.
target=(OUT/'no-host.txt').resolve()
p,q,rows,errors,send=launch('no-host','Write',False)
prompt=f'Synthetic permission check. Use Write exactly once to create {target} with content SYNTHETIC_PERMISSION_ONLY. Do not read other files, use other tools, or retry a denied operation. If denied, say exactly NATIVE_PERMISSION_DENIED. If successful, say NATIVE_PERMISSION_WRITTEN.'
p.stdin.write(prompt.encode());p.stdin.close();deadline=time.monotonic()+100;final=None
try:
 while time.monotonic()<deadline:
  try:r=q.get(timeout=.5)
  except queue.Empty:continue
  if r is None:break
  if r.get('type')=='result':final=r;break
finally:cleanup(p)
report['cases']['no-host']={'events':rows,'stderr':errors,'final':final};save()
assert final,'no-host timeout'
denials=final.get('permission_denials',[])
assert denials and not target.exists(), 'expected no-host permission denial'
summary('no_host_denies_without_waiting',passed=True,denied_tools=[d.get('tool_name') for d in denials],file_created=False,exit_code=p.returncode)
adapter=CliAdapter('claude',PATH);visible=[];adapter.on_event=lambda kind,text:visible.append({'kind':kind,'text':text})
for r in rows:adapter.stream_line('stdout',json.dumps(r))
result=adapter.parse('\n'.join(map(json.dumps,rows)))
summary('codast_parser_does_not_create_native_approval_card',passed=parse_question(result.output) is None,question_metadata=False,permission_denials_preserved_in_result_model='permission_denials' in result.model_dump())

# Prototype host, separate from CODAST, responds to two native requests in one session.
p,q,rows,errors,send=launch('with-host','AskUserQuestion,Write',True)
requests=[];results=[];pending=None;sent=False;phase=0;deadline=time.monotonic()+160
send({'type':'control_request','request_id':'probe-init','request':{'subtype':'initialize','hooks':None}})
try:
 while time.monotonic()<deadline:
  try:r=q.get(timeout=.5)
  except queue.Empty:continue
  if r is None:break
  if r.get('type')=='control_response' and r.get('response',{}).get('request_id')=='probe-init':
   assert r['response']['subtype']=='success',r
   sent=True
   send({'type':'user','session_id':'','message':{'role':'user','content':'Synthetic native question check. Call AskUserQuestion once, asking Which synthetic format? with CSV and JSON options. Do not decide without the tool answer. Do not use any other tool. After the tool returns the answer, reply exactly NATIVE_CHOICE_JSON.'},'parent_tool_use_id':None})
  elif r.get('type')=='control_request':
   req=r.get('request',{});requests.append(r)
   if req.get('subtype')=='can_use_tool' and req.get('tool_name')=='AskUserQuestion':
    data=req['input'];answer={x['question']:'JSON' for x in data.get('questions',[])}
    choice={'behavior':'allow','updatedInput':{**data,'answers':answer}}
    # Pause before response to demonstrate a genuine waiting point.
    before=sum(x.get('type')=='result' for x in rows);time.sleep(1)
    assert sum(x.get('type')=='result' for x in rows)==before
    summary('prototype_native_question_received',passed=True,question_count=len(answer),choice='JSON',codast_integration=False)
   elif req.get('subtype')=='can_use_tool' and req.get('tool_name')=='Write':
    data=req['input'];safe=Path(data.get('file_path','')).resolve()==(OUT/'host.txt').resolve() and data.get('content')=='SYNTHETIC_PERMISSION_ONLY'
    if phase==1:choice={'behavior':'deny','message':'Synthetic user denies this file write. Do not retry.'}
    elif phase==2 and safe:choice={'behavior':'allow','updatedInput':data}
    else:choice={'behavior':'deny','message':'Outside exact synthetic test scope.'}
    summary('prototype_native_write_decision_'+str(phase),passed=safe,decision=choice['behavior'],codast_integration=False)
   else:choice={'behavior':'deny','message':'Unsupported test request.'}
   send({'type':'control_response','response':{'subtype':'success','request_id':r['request_id'],'response':choice}})
  elif r.get('type')=='result':
   results.append(r)
   if phase==0:
    assert not r.get('is_error') and 'NATIVE_CHOICE_JSON' in r.get('result','')
    phase=1
   elif phase==1:
    assert not (OUT/'host.txt').exists()
    assert any(req.get('request',{}).get('tool_name')=='Write' for req in requests)
    phase=2
   elif phase==2:
    assert (OUT/'host.txt').read_text(encoding='utf-8')=='SYNTHETIC_PERMISSION_ONLY'
    summary('prototype_question_deny_allow_roundtrip',passed=True,turns=len(results),codast_integration=False)
    break
   content=f'Synthetic permission check. Use Write exactly once to create {(OUT/"host.txt").resolve()} with content SYNTHETIC_PERMISSION_ONLY. Do not use other tools or retry on denial. Reply NATIVE_WRITE_DONE if written, otherwise NATIVE_WRITE_DENIED.'
   send({'type':'user','session_id':'','message':{'role':'user','content':content},'parent_tool_use_id':None})
finally:
 cleanup(p);report['cases']['with-host']={'events':rows,'stderr':errors,'results':results,'requests':requests};save()
assert phase==2 and len(results)==3,'host protocol did not finish all turns'
summary('report',path=str(ROOT/'result.json'))
