from fastapi.testclient import TestClient
from app.main import create_app
import pytest


@pytest.mark.parametrize('selected_client', ['codex', 'claude'])
def test_setup_resume_existing_auth_and_revocation(tmp_path, monkeypatch, selected_client):
    auth = ['check_required']
    calls = []
    async def fake(client, path):
        calls.append(client)
        return {'client': client, 'state': 'installed', 'auth': auth[0]}
    monkeypatch.setattr('app.core.onboarding.probe', fake)
    root = tmp_path/'ws'
    with TestClient(create_app(root)) as c:
        assert c.get('/api/onboarding').json()['status'] == 'pending'
        assert c.get('/api/onboarding').json()['step'] == 'client'
        c.put('/api/onboarding', json={'client': selected_client})
        assert c.post('/api/onboarding/check').json()['step'] == 'authentication'
        auth[0] = 'ready'
        assert c.post('/api/onboarding/check').json()['step'] == 'project'
        auth[0] = 'check_required'
        c.post('/api/projects', json={'name': 'one'})
        assert c.put('/api/onboarding', json={'project': 'one', 'client': selected_client, 'deferred': True}).json()['status'] == 'deferred'
        assert c.post('/api/onboarding/check').json()['step'] == 'authentication'
    with TestClient(create_app(root)) as c:
        assert c.get('/api/onboarding').json()['project'] == 'one'
        auth[0] = 'ready'
        result = c.post('/api/onboarding/check').json()
        assert result['status'] == 'completed' and result['execution_state'] == 'not_verified'
        assert set(calls) == {selected_client}
        auth[0] = 'check_required'
        assert c.post('/api/onboarding/check').json()['status'] == 'in_progress'
        assert c.put('/api/onboarding', json={'project': 'missing'}).status_code == 404
        assert c.put('/api/onboarding', json={'client': 'mock'}).status_code == 422
        assert c.put('/api/onboarding', json={'status': 'completed'}).status_code == 422


def test_v4_migration_keeps_existing_data(tmp_path):
    from app.core.storage import Storage
    path = tmp_path/'db.sqlite3'
    storage = Storage(path)
    storage.save_client_path('codex', 'fake-path')
    with storage.connect() as db:
        db.execute('DROP TABLE onboarding_state')
        db.execute('PRAGMA user_version=4')
    restored = Storage(path)
    assert restored.client_path('codex') == 'fake-path'
    assert restored.onboarding()['status'] == 'pending'
