import os,subprocess,sys,time,json,socket
from pathlib import Path
from uuid import uuid4
from hashlib import sha256
import httpx
base=Path('work/parallel-restart-'+uuid4().hex[:8]).resolve();base.mkdir()
with socket.socket() as listener:
    listener.bind(('127.0.0.1',0))
    port=listener.getsockname()[1]
origin=f'http://127.0.0.1:{port}'
env=dict(os.environ,HARNESS_PARALLEL_TEST_ROOT=str(base),HARNESS_TEST_HOLD_DESIGN='1',PYTHONPATH='.',PYTHONUTF8='1')
def start():
    proc=subprocess.Popen([sys.executable,'-m','uvicorn','parallel_server:app','--app-dir','tests/browser','--host','127.0.0.1','--port',str(port)],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)
    for _ in range(100):
        try:
            if httpx.get(origin+'/health').status_code==200:return proc
        except httpx.ConnectError:pass
        assert proc.poll() is None
        time.sleep(.1)
    raise AssertionError('server startup failed')
def api(path,method='GET',data=None):
    r=httpx.request(method,origin+'/api'+path,json=data,timeout=10)
    return r
proc=start()
try:
    api('/projects','POST',{'name':'sample'})
    cid=api('/projects/sample/document-vault','PUT',{'path':str(base/'artifacts'/'.codast-documents'),'mode':'create'}).json()['binding']['connection_id']
    db='/projects/sample/document-vault/documents'
    content='REQ-001: 가상 이름 필수 요구사항'
    d=api(db,'POST',{'connection_id':cid,'title':'가상 요구','content':content}).json()
    d=api(db+'/'+d['id']+'/reviews','POST',{'connection_id':cid,'expected_revision':d['revision'],'reason':'가상 검토'}).json()
    d=api(db+'/'+d['id']+'/reviews/1/decision','POST',{'connection_id':cid,'expected_revision':d['revision'],'decision':'approved','comment':'가상 승인'}).json()
    s=api('/projects/sample/workflows/parallel','POST',{'connection_id':cid,'request_id':uuid4().hex,'title':'강제 재시작 검증','source':{'kind':'document','identity':d['id'],'version':1,'expected_revision':d['revision'],'sha256':sha256(content.encode()).hexdigest()}}).json()
    path='/projects/sample/workflows/'+s['id']
    s=api(path+'/parallel','POST',{'connection_id':cid,'expected_revision':s['revision'],'action':'start'}).json()
    for _ in range(100):
        s=api(path+'?connection_id='+cid).json()
        if s['steps'][1]['status']=='review':break
        time.sleep(.1)
    assert s['steps'][0]['status']=='running' and s['steps'][1]['status']=='review'
    rid=s['steps'][0]['attempts'][0]['run_id'];peer=s['steps'][1]['attempts'].copy()
    proc.kill();proc.wait(timeout=10)
    proc=start()
    restored=api(path+'?connection_id='+cid).json()
    assert restored['steps'][0]['status']=='running' and restored['steps'][0]['cancellable'] is False
    assert restored['steps'][1]['attempts']==peer
    assert api('/projects/sample/runs/'+rid+'/cancel','POST').status_code==409
    assert 'event: detached' in api('/projects/sample/runs/'+rid+'/events').text
    assert api('/projects/sample/chat','POST',{'text':'일반 실행','client':'codex','action':'run','task':'일반 검증','auto_route':False}).status_code==409
    assert api('/projects/sample/runs/'+rid+'/reconcile','POST').status_code==200
    restored=api(path+'?connection_id='+cid).json()
    assert restored['steps'][0]['status']=='cancelled' and restored['steps'][1]['attempts']==peer
    (base/'summary.json').write_text(json.dumps({'result':'PASS','completed_peer_preserved':True,'detached_running_preserved':True,'no_automatic_replay':True}),encoding='utf-8')
    print('PASS hard server restart with mock CLI: peer result preserved, running record detached, cancel rejected, SSE replay, normal chat blocked, explicit reconciliation only')
finally:
    if proc.poll() is None:proc.kill();proc.wait(timeout=10)
