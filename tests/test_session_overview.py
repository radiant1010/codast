from fastapi.testclient import TestClient
from app.main import create_app
from app.models.schemas import Command


def test_overview_excludes_deleted_projects_and_keeps_old_running(tmp_path):
    app = create_app(tmp_path / 'workspaces')
    with TestClient(app) as client:
        service = app.state.harness
        for name in ('visible', 'archived'):
            service.projects.create(name)
            service.storage.save_session(name, 'chat', 'codex', '/workspace', 'read-only', name + '-session')
        service.projects.delete('archived')
        active = service.storage.start_run('visible', Command(text='old run', task='chat'), 'mock')
        for index in range(21):
            run = service.storage.start_run('visible', Command(text=str(index), task='chat'), 'mock')
            service.storage.finish_run(run, 'completed', output='done')
        data = client.get('/api/session-overview').json()
        assert [row['session_id'] for row in data['sessions']] == ['visible-session']
        assert [row['id'] for row in data['running']] == [active]
        assert data['running'][0]['cancellable'] is False
        assert data['running'][0]['command']['task'] == 'chat'


def test_usage_totals_native_sessions_missing_values_and_chat_move(tmp_path):
    app = create_app(tmp_path / 'workspaces')
    with TestClient(app) as client:
        s = app.state.harness
        s.projects.create('sample')
        for index in range(22):
            run = s.storage.start_run('sample', Command(text='test', task='chat', client='codex'), 'codex')
            s.storage.finish_run(run, 'completed', metadata={'session_id':'native-a',
                'usage':{'input_tokens':10, 'output_tokens':2}})
        missing = s.storage.start_run('sample', Command(text='missing', task='chat', client='codex'), 'codex')
        s.storage.finish_run(missing, 'failed', metadata={'session_id':'native-a'})
        other = s.storage.start_run('sample', Command(text='new', task='chat', client='claude'), 'claude')
        s.storage.finish_run(other, 'completed', metadata={'session_id':'native-b', 'usage':{'input_tokens':0}})
        data = client.get('/api/session-overview').json()['usage']
        codex = next(row for row in data if row['client']=='codex')
        assert (codex['input_tokens'], codex['output_tokens'], codex['runs'], codex['input_reports']) == (220,44,23,22)
        claude = next(row for row in data if row['client']=='claude')
        assert claude['input_tokens'] == 0 and claude['output_tokens'] is None
        s.storage.move_message('sample', other, 'moved')
        data = client.get('/api/session-overview').json()['usage']
        assert next(row for row in data if row['client']=='claude')['task']=='moved'


def test_overview_combines_stored_live_and_linked_metrics(tmp_path, monkeypatch):
    app = create_app(tmp_path / 'workspaces')
    with TestClient(app) as client:
        s = app.state.harness
        root = s.projects.create('sample')
        measured = {'execution_model': 'actual', 'context_usage': {'used_tokens': 12, 'window_tokens': 1000}}
        monkeypatch.setattr(app.state.session_metrics, 'snapshot', lambda *args: {**measured, 'state': 'available'})
        s.storage.save_session('sample', 'linked', 'codex', str(root), 'read-only', 'native')
        run = s.storage.start_run('sample', Command(text='test', task='live', client='claude'), 'claude')
        s.storage.update_run_metadata(run, {'session_id': 'live', **measured})
        data = client.get('/api/session-overview').json()
        assert data['sessions'][0]['metrics']['execution_model'] == 'actual'
        assert data['running'][0]['metrics'] == measured
        assert data['usage'][0]['context_usage']['used_tokens'] == 12
        s.storage.update_run_metadata(run, {'session_id': 'live', 'execution_model': 'changed'})
        current = client.get('/api/session-overview').json()['running'][0]['metrics']
        assert current == {'execution_model': 'changed'}
        s.storage.finish_run(run, 'completed', metadata={'session_id': 'live', **measured})
        data = client.get('/api/session-overview').json()
        assert not data['running']
        assert data['usage'][0]['execution_model'] == 'actual'
        assert data['usage'][0]['context_usage']['window_tokens'] == 1000
