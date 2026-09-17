from fastapi.testclient import TestClient
from app.main import create_app


def test_empty_chat_persists_without_synthetic_messages(tmp_path):
    root = tmp_path/'ws'
    with TestClient(create_app(root)) as c:
        c.post('/api/projects', json={'name':'one'})
        assert c.post('/api/projects/missing/tasks', json={'task':'empty'}).status_code == 404
        assert c.post('/api/projects/one/tasks', json={'task':'  '}).status_code == 422
        response = c.post('/api/projects/one/tasks', json={'task':' empty '})
        assert response.status_code == 201
        assert response.json() == {'task':'empty','count':0,'status':'active'}
        assert c.post('/api/projects/one/tasks', json={'task':'empty'}).status_code == 409
        assert c.get('/api/projects/one/messages').json()['messages'] == []
        assert c.get('/api/projects/one/runs').json()['runs'] == []
    with TestClient(create_app(root)) as c:
        assert c.get('/api/projects/one/tasks').json()['tasks'] == [{'task':'empty','count':0,'status':'active'}]
        assert c.patch('/api/projects/one/tasks', json={'task':'empty','title':'renamed','status':'paused'}).status_code == 200
        assert c.get('/api/projects/one/tasks').json()['tasks'] == [{'task':'renamed','count':0,'status':'paused'}]


def test_rename_preserves_native_links_but_merge_resets_both(tmp_path):
    app = create_app(tmp_path/'ws')
    s = app.state.harness.storage
    with TestClient(app) as c:
        c.post('/api/projects', json={'name':'one'})
        c.post('/api/projects/one/tasks', json={'task':'source'})
        cwd = str(app.state.harness.projects.select('one'))
        for client in ('codex','claude'):
            s.save_session('one','source',client,cwd,'read-only',client+'-fixture')
        assert c.patch('/api/projects/one/tasks', json={'task':'source','title':'renamed'}).status_code == 200
        for client in ('codex','claude'):
            assert s.session('one','renamed',client,cwd,'read-only') == client+'-fixture'
            assert s.session('one','source',client,cwd,'read-only') is None
        c.post('/api/projects/one/tasks', json={'task':'target'})
        s.save_session('one','target','codex',cwd,'read-only','target-fixture')
        assert c.patch('/api/projects/one/tasks', json={'task':'renamed','title':'target'}).status_code == 200
        assert c.get('/api/projects/one/tasks').json()['tasks'] == [{'task':'target','count':0,'status':'active'}]
        for client in ('codex','claude'):
            assert s.session('one','target',client,cwd,'read-only') is None


def test_empty_chat_is_a_duplicate_for_native_attach(tmp_path):
    from app.core.storage import Storage
    import pytest
    s = Storage(tmp_path/'test.sqlite3')
    s.create_task('one','reserved')
    with pytest.raises(FileExistsError):
        s.attach_native_thread('one','reserved',str(tmp_path),'test-native')
    assert s.messages('one','reserved',20,0) == []
