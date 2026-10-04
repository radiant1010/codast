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
