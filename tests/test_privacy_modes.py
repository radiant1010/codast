import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from app.core.data_guard import GuardOptions, Part, guard
from app.core.storage import Storage
from app.main import create_app
from app.models.schemas import AgentResult


@pytest.mark.parametrize('mode', ['replace', 'partial', 'raw'])
def test_privacy_modes_are_independent_from_secret_protection(mode):
    options = GuardOptions(privacy_mode=mode)
    result = guard([Part('A1', 'qwerty', '아이디'), Part('A2', 'password=dummy-pass'),
                    Part('A3', '900101-1234567')], options, b'test-only-key')
    values = [p['text'] for p in result['parts']]
    if mode == 'replace': assert values[0].startswith('가상_') and 'qwerty' not in values[0]
    elif mode == 'partial': assert values[0] == 'qwe***' and values[2] == '900***'
    else: assert values[0] == 'qwerty' and values[2] == '900101-1234567'
    assert values[1] == 'password=[비밀값]'
    private = guard([Part('A1', '-----BEGIN PRIVATE KEY-----')], options, b'test-only-key')
    assert private['status'] == 'blocked' and private['parts'] == []
    assert 'qwerty' not in json.dumps(result['findings'])


def test_partial_short_values_and_overlapping_secret_take_precedence():
    parts = [Part(str(i), value, '이름') for i, value in enumerate(['a', 'ab', 'abc', 'abcdef'])]
    result = guard(parts, GuardOptions(privacy_mode='partial'))
    assert [p['text'] for p in result['parts']] == ['***', 'a***', 'ab***', 'abc***']
    result = guard([Part('A1', 'password=dummy-pass', '이름')], GuardOptions(privacy_mode='raw'))
    assert result['parts'][0]['text'] == '[비밀값]'


def test_replace_requires_key_and_same_value_is_stable_across_types():
    options = GuardOptions(privacy_mode='replace')
    parts = [Part('A1', 'qwerty', '아이디'), Part('B1', 'qwerty', '이름'), Part('C1', 'another', '이름')]
    with pytest.raises(ValueError): guard(parts, options)
    first = guard(parts, options, b'project-one-key')
    values = [p['text'] for p in first['parts']]
    assert values[0] == values[1] and values[0] != values[2]
    assert first == guard(parts, options, b'project-one-key')
    assert values[0] != guard(parts, options, b'project-two-key')['parts'][0]['text']
    # Allowing secrets never overrides the explicitly selected privacy mode.
    allowed = guard(parts, GuardOptions(level='allow', privacy_mode='partial'))
    assert allowed['parts'][0]['text'] == 'qwe***'


class Recorder:
    def __init__(self): self.inputs = []
    async def run(self, context):
        self.inputs.append(context.model_dump_json())
        return AgentResult(adapter='mock', output='ok')


def test_restart_project_isolation_delivery_stale_and_private_key_not_exposed(tmp_path):
    root = tmp_path/'workspaces'
    agent = Recorder()
    base = '/api/projects/one'
    with TestClient(create_app(root, agent)) as client:
        outputs = []
        for name in ['one', 'two']:
            client.post('/api/projects', json={'name': name})
            endpoint = '/api/projects/'+name
            assert client.put(endpoint+'/guard', json={'privacy_mode': 'replace'}).status_code == 200
            response = client.post(endpoint+'/materials?filename=test.txt', content='아이디: qwerty'.encode())
            identity = response.json()['id']
            outputs.append(client.get(endpoint+'/materials/'+identity).json()['content'])
            if name == 'one': saved_id = identity
        assert outputs[0] != outputs[1]
        result = client.post(base+'/commands', json={'text': 'test', 'material_ids': [saved_id]})
        assert result.status_code == 200
        run_id = result.json()['run_id']
        assert 'qwerty' not in agent.inputs[0] and '가상_' in agent.inputs[0]
    with TestClient(create_app(root, agent)) as client:
        response = client.post(base+'/materials?filename=second.txt', content='아이디: qwerty'.encode())
        assert client.get(base+'/materials/'+response.json()['id']).json()['content'] == outputs[0]
        storage = client.app.state.harness.storage
        key = storage.guard_pseudonym_key('one')
        public = client.get(base+'/guard').text + client.get(base+'/materials').text + client.get(base+'/runs/'+run_id).text
        assert key.hex() not in public and 'qwerty' not in public
        with storage.connect() as db:
            # No original-to-pseudonym mapping or unmasked value is persisted in this mode.
            dump = '\n'.join(db.iterdump())
            assert 'qwerty' not in dump
        assert client.put(base+'/guard', json={'privacy_mode': 'partial'}).status_code == 200
        assert client.post(base+'/commands', json={'text': 'test', 'material_ids': [saved_id]}).status_code == 400
        assert client.put(base+'/guard', json={'privacy_mode': 'unsupported'}).status_code == 422


def test_v9_migration_and_concurrent_key_creation(tmp_path):
    path = tmp_path/'test.sqlite3'
    storage = Storage(path)
    with storage.connect() as db:
        db.execute('DROP TABLE guard_pseudonym_keys')
        db.execute('PRAGMA user_version=9')
        db.execute('INSERT INTO guard_options VALUES (?,?)', ('one', '{"level":"medium","fields":[]}'))
    storage = Storage(path)
    with ThreadPoolExecutor(max_workers=4) as pool:
        keys = list(pool.map(lambda _: storage.guard_pseudonym_key('one'), range(8)))
    assert len(set(keys)) == 1 and len(keys[0]) == 32
    with storage.connect() as db:
        assert db.execute('PRAGMA user_version').fetchone()[0] == 10
        assert json.loads(db.execute('SELECT options FROM guard_options').fetchone()[0])['level'] == 'medium'
        assert db.execute('SELECT COUNT(*) FROM guard_pseudonym_keys').fetchone()[0] == 1


def test_test_data_preference_persists_without_invalidating_materials(tmp_path):
    root = tmp_path/'workspaces'
    base = '/api/projects/one'
    with TestClient(create_app(root)) as client:
        client.post('/api/projects', json={'name': 'one'})
        client.put(base+'/guard', json={'privacy_mode': 'partial'})
        response = client.post(base+'/materials?filename=test.txt', content=b'password=dummy-pass')
        identity = response.json()['id']
        client.put(base+'/guard', json={'privacy_mode': 'partial', 'test_data': True})
        assert not client.get(base+'/materials').json()['materials'][0]['stale']
        assert not client.get(base+'/materials').json()['materials'][0]['test_data']
    with TestClient(create_app(root)) as client:
        assert client.get(base+'/guard').json()['test_data'] is True
        assert client.get(base+'/materials/'+identity).status_code == 200
