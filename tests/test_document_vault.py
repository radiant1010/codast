import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def vault(tmp_path):
    app = create_app(tmp_path / 'projects', db_path=tmp_path / 'runtime.sqlite3')
    with TestClient(app) as client:
        assert client.post('/api/projects', json={'name': 'sample'}).status_code == 201
        base = '/api/projects/sample/document-vault'
        root = tmp_path / 'artifacts' / '.codast-documents'
        response = client.put(base, json={'path': str(root), 'mode': 'create'})
        assert response.status_code == 200, response.text
        identity = response.json()['binding']['connection_id']
        yield client, app, base, root, identity


def create(client, base, identity, text='초안'):
    response = client.post(base + '/documents', json={'connection_id': identity, 'title': '요구사항', 'content': text})
    assert response.status_code == 201, response.text
    return response.json()


def submit(client, base, identity, doc):
    response = client.post(base + '/documents/' + doc['id'] + '/reviews', json={
        'connection_id': identity, 'expected_revision': doc['revision'], 'reason': '기준 확인'})
    assert response.status_code == 201, response.text
    return response.json()


def decide(client, base, identity, doc, decision='approved'):
    response = client.post(base + f"/documents/{doc['id']}/reviews/{doc['pending']}/decision", json={
        'connection_id': identity, 'expected_revision': doc['revision'], 'decision': decision, 'comment': '검토 완료'})
    assert response.status_code == 200, response.text
    return response.json()


def save(client, base, identity, doc, text):
    return client.put(base + '/documents/' + doc['id'], json={
        'connection_id': identity, 'expected_revision': doc['revision'], 'title': doc['title'], 'content': text})


def test_approval_rejection_and_restore_with_new_database(vault, tmp_path):
    c, app, base, root, identity = vault
    doc = decide(c, base, identity, submit(c, base, identity, create(c, base, identity, '전체 10MB')))
    assert doc['approved'] == 1
    doc = save(c, base, identity, doc, '파일당 10MB').json()
    assert doc['approved'] == 1 and len(doc['reviews']) == 1
    doc = submit(c, base, identity, doc)
    review = c.get(base + f"/documents/{doc['id']}/reviews/2?connection_id={identity}").json()
    assert review['before']['content'] == '전체 10MB'
    assert review['after']['content'] == '파일당 10MB'
    assert save(c, base, identity, doc, '몰래 수정').status_code == 409
    doc = decide(c, base, identity, doc, 'rejected')
    assert doc['approved'] == 1
    doc = save(c, base, identity, doc, '파일당 8MB').json()
    doc = decide(c, base, identity, submit(c, base, identity, doc))
    assert doc['approved'] == 3 and doc['reviews'][1]['decision'] == 'rejected'
    # A new app, project registry and database know nothing about the original runtime.
    with TestClient(create_app(tmp_path / 'fresh-projects', db_path=tmp_path / 'fresh.sqlite3')) as recovered:
        recovered.post('/api/projects', json={'name': 'recovered'})
        new_base = '/api/projects/recovered/document-vault'
        connection = recovered.put(new_base, json={'path': str(root), 'mode': 'connect'})
        assert connection.status_code == 200
        identity = connection.json()['binding']['connection_id']
        restored = recovered.get(new_base + f"/documents/{doc['id']}?connection_id={identity}").json()
        assert restored == doc
        assert recovered.get(new_base + f'/documents?connection_id={identity}').json()['issues'] == []
        assert recovered.get(new_base + f"/documents/{doc['id']}/reviews/1?connection_id={identity}").json()['after']['content'] == '전체 10MB'


def test_atomic_failure_keeps_old_catalog_and_ignores_orphan(vault, monkeypatch):
    c, app, base, root, identity = vault
    doc = create(c, base, identity)
    before = (root / 'catalog.json').read_bytes()
    from app.core import document_vault as module
    original = module.os.replace
    def fail_catalog(source, destination):
        if Path(destination).name == 'catalog.json':
            raise OSError('simulated interrupted publish')
        original(source, destination)
    monkeypatch.setattr(module.os, 'replace', fail_catalog)
    with pytest.raises(ValueError, match='저장에 실패'):
        app.state.document_vault.change('sample', identity, doc['id'], doc['revision'], 'submitted', reason='review')
    assert (root / 'catalog.json').read_bytes() == before
    assert not list(root.glob('.pending-*'))
    assert app.state.document_vault.read('sample', identity, doc['id']) == doc
    monkeypatch.setattr(module.os, 'replace', original)
    assert submit(c, base, identity, doc)['pending'] == 1


def test_stale_save_and_decision_are_rejected(vault):
    c, app, base, root, identity = vault
    old = create(c, base, identity)
    current = save(c, base, identity, old, '수정').json()
    assert save(c, base, identity, old, '뒤늦은 수정').status_code == 409
    current = submit(c, base, identity, current)
    result = decide(c, base, identity, current)
    endpoint = base + f"/documents/{current['id']}/reviews/1/decision"
    assert c.post(endpoint, json={'connection_id': identity, 'expected_revision': current['revision'], 'decision': 'rejected', 'comment': '늦은 반려'}).status_code == 409
    assert c.get(base + f"/documents/{old['id']}?connection_id={identity}").json() == result


def test_concurrent_saves_have_one_winner(vault):
    c, app, base, root, identity = vault
    doc = create(c, base, identity)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda text: save(c, base, identity, doc, text).status_code, ['one', 'two']))
    assert sorted(results) == [200, 409]


@pytest.mark.parametrize('damage', ['missing', 'modified'])
def test_missing_or_modified_snapshot_is_visible_and_blocks_approval(vault, damage):
    c, app, base, root, identity = vault
    doc = submit(c, base, identity, create(c, base, identity))
    snapshot = root / 'objects' / (doc['reviews'][0]['snapshot'] + '.json')
    if damage == 'missing': snapshot.unlink()
    else: snapshot.write_text('{"title":"changed","content":"changed"}', encoding='utf-8')
    listing = c.get(base + f'/documents?connection_id={identity}').json()
    assert len(listing['issues']) == 1 and listing['documents'] == []
    assert c.post(base + f"/documents/{doc['id']}/reviews/1/decision", json={'connection_id': identity, 'expected_revision': doc['revision'], 'decision': 'approved', 'comment': 'test'}).status_code == 400


def test_corrupt_catalog_is_not_silently_rebuilt(vault):
    c, app, base, root, identity = vault
    (root / 'catalog.json').write_text('{broken', encoding='utf-8')
    assert c.get(base + f'/documents?connection_id={identity}').status_code == 400
    assert c.put(base, json={'path': str(root), 'mode': 'create', 'expected_connection_id': identity}).status_code == 409
    assert (root / 'catalog.json').read_text(encoding='utf-8') == '{broken'


def test_project_boundary_and_changed_binding(vault, tmp_path):
    c, app, base, root, identity = vault
    doc = create(c, base, identity)
    c.post('/api/projects', json={'name': 'other'})
    assert c.put('/api/projects/other/document-vault', json={'path': str(root), 'mode': 'connect'}).status_code == 409
    assert c.get('/api/projects/other/document-vault/documents?connection_id=' + identity).status_code == 400
    second = tmp_path / 'second' / '.codast-documents'
    assert c.put(base, json={'path': str(second), 'mode': 'create'}).status_code == 409
    result = c.put(base, json={'path': str(second), 'mode': 'create', 'expected_connection_id': identity})
    assert result.status_code == 200
    assert save(c, base, identity, doc, 'stale').status_code == 409
    assert (root / 'catalog.json').exists()
    assert c.get(base + f'/documents?connection_id={identity}').status_code == 409


def test_input_origin_and_path_validation(vault, tmp_path):
    c, app, base, root, identity = vault
    assert c.post(base + '/documents', json={'connection_id': identity, 'title': '  ', 'content': ''}).status_code == 400
    assert c.post(base + '/documents', json={'connection_id': identity, 'title': 'x', 'content': 'x' * 200001}).status_code == 422
    assert c.post(base + '/documents', json={'connection_id': identity, 'title': 'x', 'content': ''}, headers={'origin': 'https://elsewhere.test'}).status_code == 403
    for path in ['relative/.codast-documents', str(tmp_path / 'not-dedicated')]:
        assert c.put(base, json={'path': path, 'mode': 'create', 'expected_connection_id': identity}).status_code == 400
    assert c.get(base + '/documents/not-an-id?connection_id=' + identity).status_code == 404
    assert c.get(base + '/documents?connection_id=' + '0' * 32).status_code == 409


def test_same_content_is_not_a_new_review(vault):
    c, app, base, root, identity = vault
    doc = decide(c, base, identity, submit(c, base, identity, create(c, base, identity)))
    assert c.post(base + f"/documents/{doc['id']}/reviews", json={'connection_id': identity, 'expected_revision': doc['revision'], 'reason': 'same'}).status_code == 400
    assert save(c, base, identity, doc, doc['content']).json()['revision'] == doc['revision']


def test_reconnecting_copied_vault_invalidates_previous_connection(vault, tmp_path):
    c, app, base, root, identity = vault
    doc = create(c, base, identity)
    copied = tmp_path / 'restored-copy' / '.codast-documents'
    shutil.copytree(root, copied)
    connected = c.put(base, json={'path': str(copied), 'mode': 'connect', 'expected_connection_id': identity})
    assert connected.status_code == 200
    assert connected.json()['binding']['connection_id'] != identity
    assert save(c, base, identity, doc, 'late request').status_code == 409


def test_ordinary_file_api_cannot_read_vault(tmp_path):
    from app.core.policy_engine import PolicyEngine
    from app.tools.filesystem import FileSystemTool
    folder = tmp_path / '.codast-documents'
    folder.mkdir()
    (folder / 'catalog.json').write_text('{}', encoding='utf-8')
    with pytest.raises(PermissionError):
        PolicyEngine().file_path(tmp_path, '.codast-documents/catalog.json')
    assert list(FileSystemTool().list_candidates(tmp_path)) == []


def test_linked_folder_is_rejected(vault, tmp_path):
    c, app, base, root, identity = vault
    link = tmp_path / 'linked'
    try: link.symlink_to(root, target_is_directory=True)
    except OSError: pytest.skip('OS does not permit symlink creation')
    assert c.put(base, json={'path': str(link / '.codast-documents'), 'mode': 'create', 'expected_connection_id': identity}).status_code == 403


def test_project_folders_share_base_and_preserve_legacy(vault, tmp_path):
    c, app, base, old_root, cid = vault
    original = create(c, base, cid, '기존 문서 보존')
    shared = tmp_path / 'shared-artifacts'
    result = c.put(base, json={'path': str(shared), 'layout': 'project', 'mode': 'create', 'expected_connection_id': cid})
    assert result.status_code == 200, result.text
    binding = result.json()['binding']
    assert Path(binding['path']) == shared / 'sample' / '.codast-documents'
    assert Path(binding['exports_path']).is_dir()
    assert (old_root / 'catalog.json').exists()
    c.post('/api/projects', json={'name': 'other'})
    second = c.put('/api/projects/other/document-vault', json={'path': str(shared), 'layout': 'project', 'mode': 'create'})
    assert second.status_code == 200, second.text
    assert Path(second.json()['binding']['path']) == shared / 'other' / '.codast-documents'
    assert binding['vault_id'] != second.json()['binding']['vault_id']
    connected = c.put(base, json={'path': str(shared), 'layout': 'project', 'mode': 'connect', 'expected_connection_id': binding['connection_id']})
    assert connected.status_code == 200
    restored = c.put(base, json={'path': str(old_root), 'layout': 'project', 'mode': 'connect', 'expected_connection_id': connected.json()['binding']['connection_id']})
    assert restored.status_code == 200
    doc = c.get(base+'/documents/'+original['id'], params={'connection_id': restored.json()['binding']['connection_id']})
    assert doc.json()['content'] == '기존 문서 보존'


def test_grouped_exports_file_blocks_connection(vault, tmp_path):
    c, app, base, old_root, cid = vault
    shared = tmp_path / 'shared'
    (shared / 'sample').mkdir(parents=True)
    (shared / 'sample' / 'exports').write_text('keep', encoding='utf-8')
    result = c.put(base, json={'path': str(shared), 'layout': 'project', 'mode': 'create', 'expected_connection_id': cid})
    assert result.status_code == 400
    assert c.get(base).json()['binding']['connection_id'] == cid
    assert not (shared / 'sample' / '.codast-documents').exists()
