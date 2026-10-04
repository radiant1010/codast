import json,os,time
from pathlib import Path
from uuid import uuid4
ROOT=Path('work')/('claude-permission-api-'+uuid4().hex[:10]);ROOT.mkdir()
os.environ['HARNESS_WORKSPACES']=str(ROOT/'defaults');os.environ['HARNESS_DB']=str(ROOT/'default.db')
from fastapi.testclient import TestClient
from app.main import create_app
app=create_app(ROOT/'projects',db_path=ROOT/'test.db')
target=(ROOT/'outside.txt').resolve();base='/api/projects/synthetic'
with TestClient(app) as c:
 assert c.post('/api/projects',json={'name':'synthetic'}).status_code==201
 cwd=app.state.harness.projects.entry('synthetic')
 (cwd/'.claude').mkdir();(cwd/'.claude/settings.json').write_text(json.dumps({'permissions':{'ask':['Write']}}),encoding='utf-8')
 prompt=f'Synthetic native permission test only. Use Write exactly once to create {target} with content SYNTHETIC_PERMISSION_ONLY. Do not read files, use other tools, or retry if denied. Do not convert native permission denial into a codast-question. If denied, respond NATIVE_PERMISSION_DENIED, otherwise NATIVE_PERMISSION_WRITTEN.'
 r=c.post(base+'/chat',json={'text':prompt,'task':'native-permission','client':'claude','action':'run','mode':'workspace-write','fresh':True});assert r.status_code==200,r.text
 run=r.json()['run_id'];deadline=time.monotonic()+130
 while time.monotonic()<deadline:
  row=c.get(base+'/runs/'+run).json()
  if row['status']!='running':break
  time.sleep(.2)
 else:raise AssertionError('API test time limit')
 events=app.state.harness.storage.events('synthetic',run) if hasattr(app.state.harness.storage,'events') else c.get(base+'/runs/'+run+'/events').text
 (ROOT/'result.json').write_text(json.dumps({'run':row,'events':events},ensure_ascii=False,indent=2),encoding='utf-8')
 assert row['status']=='completed',row['status']
 assert not target.exists()
 assert 'question' not in row['metadata']
 assert 'NATIVE_PERMISSION_DENIED' in row['output']
 print(json.dumps({'actual_codast_api':True,'status':row['status'],'native_permission_card':False,'file_created':False,'local_report':str(ROOT/'result.json')},ensure_ascii=False),flush=True)
