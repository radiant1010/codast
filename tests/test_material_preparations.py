import asyncio
import pytest
from fastapi.testclient import TestClient
from app.main import create_app
from app.api.materials import prepare


def test_preparation_cancel_commit_scope_and_policy(tmp_path):
    app=create_app(tmp_path/'ws')
    with TestClient(app) as c:
        for name in ['one','two']:c.post('/api/projects',json={'name':name})
        base='/api/projects/one'
        def stage():
            r=c.post(base+'/material-preparations?filename=test.txt',content=b'password=dummy-secret')
            assert r.status_code==201
            assert 'dummy-secret' not in r.text
            return r.json()['token']
        token=stage()
        assert c.get(base+'/materials').json()['materials']==[]
        assert c.post('/api/projects/two/material-preparations/'+token+'/commit').status_code==404
        assert c.delete(base+'/material-preparations/'+token).status_code==200
        assert c.post(base+'/material-preparations/'+token+'/commit').status_code==404
        token=stage()
        r=c.post(base+'/material-preparations/'+token+'/commit')
        assert r.status_code==201
        assert c.post(base+'/material-preparations/'+token+'/commit').status_code==404
        assert 'dummy-secret' not in c.get(base+'/materials/'+r.json()['id']).text
        token=stage()
        c.put(base+'/guard',json={'privacy_mode':'partial'})
        assert c.post(base+'/material-preparations/'+token+'/commit').status_code==400
        assert len(c.get(base+'/materials').json()['materials'])==1
        token=stage()
    with TestClient(create_app(tmp_path/'ws')) as c:
        assert c.post(base+'/material-preparations/'+token+'/commit').status_code==404
        assert len(c.get(base+'/materials').json()['materials'])==1


@pytest.mark.parametrize('stage',['extract','guard'])
def test_disconnect_stops_preparation_without_persistence(tmp_path,monkeypatch,stage):
    app=create_app(tmp_path/'ws');s=app.state.harness;s.projects.create('one')
    from app.core import materials
    original=getattr(materials,stage)
    def slow_extract(*args):
        checkpoint=args[-1]
        import time
        time.sleep(.05)
        checkpoint()
        return original(*args)
    monkeypatch.setattr(materials,stage,slow_extract)
    class Request:
        def __init__(self):self.app=app
        async def stream(self):yield b'password=dummy'
        async def receive(self):return {'type':'http.disconnect'}
    with pytest.raises(ValueError):asyncio.run(prepare('one',Request(),'test.txt'))
    assert s.materials.list('one')==[]
    assert not s.materials.pending


def test_pending_capacity_expiry_and_discard(tmp_path):
    app=create_app(tmp_path/'ws');s=app.state.harness;s.projects.create('one');store=s.materials
    prepared=store.prepare('one','test.txt',b'hello')
    tokens=[store.stage('one',prepared) for _ in range(10)]
    with pytest.raises(ValueError):store.stage('one',prepared)
    store.pending[('one',tokens[0])]=(0,prepared)
    with pytest.raises(FileNotFoundError):store.commit('one',tokens[0])
    store.discard('one',tokens[1]);assert len(store.pending)==8
    assert store.list('one')==[]


def test_real_http_disconnect_never_saves_or_stages(tmp_path,monkeypatch):
    import socket
    import threading
    import time
    import httpx
    import uvicorn
    from app.core import materials
    app=create_app(tmp_path/'ws');store=app.state.harness.materials
    app.state.harness.projects.create('one')
    started=threading.Event();finished=threading.Event()
    original=materials.extract
    def slow_extract(*args):
        started.set()
        try:
            time.sleep(.3)
            return original(*args)
        finally:finished.set()
    monkeypatch.setattr(materials,'extract',slow_extract)
    async def scenario():
        sock=socket.socket();sock.bind(('127.0.0.1',0))
        port=sock.getsockname()[1]
        server=uvicorn.Server(uvicorn.Config(app,log_level='critical'))
        task=asyncio.create_task(server.serve(sockets=[sock]))
        try:
            for _ in range(200):
                if server.started:break
                await asyncio.sleep(.01)
            assert server.started
            async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}') as c:
                upload=asyncio.create_task(c.post('/api/projects/one/material-preparations?filename=test.txt',content=b'password=dummy'))
                for _ in range(200):
                    if started.is_set():break
                    await asyncio.sleep(.01)
                assert started.is_set()
                upload.cancel()
                with pytest.raises(asyncio.CancelledError):await upload
                for _ in range(200):
                    if finished.is_set():break
                    await asyncio.sleep(.01)
                assert finished.is_set()
                await asyncio.sleep(.15)
                assert (await c.get('/api/projects/one/materials')).json()['materials']==[]
                assert not store.pending
        finally:
            server.should_exit=True
            await task
            sock.close()
    asyncio.run(scenario())
