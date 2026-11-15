import io
import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.core.materials import Materials
from app.core.storage import Storage
from app.core.data_guard import GuardOptions


@pytest.fixture
def store(tmp_path):
    return Materials(Storage(tmp_path / 'runtime' / 'data.sqlite3'))


def original(store, text=b'password=synthetic-private\n', project='one', filename='private-name.txt'):
    return store.import_file(project, filename, text, mode='original')


def test_original_bytes_restart_manifest_and_policy_independence(store):
    content = b'password=synthetic-private\n' * 10000
    report = original(store, content)
    assert report['mode'] == 'original'
    assert 'private-name' not in json.dumps(report)
    assert store.read('one', report['id'])['content'] == ''
    store = Materials(Storage(store.storage.path))
    store.configure('one', GuardOptions(level='allow'))
    assert not store.list('one')[0]['stale']
    path, data = store.original('one', report['id'])
    assert data == content and path.read_bytes() == content
    parts, audit = store.selected('one', [report['id']], query='password?', budget=24000)
    manifest = json.loads(parts[0].content)
    assert manifest['path'] == str(path)
    assert 'synthetic-private' not in parts[0].content
    assert len(parts[0].content) < 2000
    assert audit['materials'][0]['delivery']['mode'] == 'original'


def test_legacy_default_text_mixed_modes_and_no_original_recovery(store):
    legacy = store.import_file('one', 'old.txt', b'password=synthetic-private')
    raw = original(store)
    parts, audit = store.selected('one', [legacy['id'], raw['id'], raw['id']])
    assert len(parts) == 2
    assert 'synthetic-private' not in parts[0].content
    assert audit['materials'][0]['delivery']['mode'] == 'full'
    with pytest.raises(ValueError, match='원본'):
        store.original('one', legacy['id'])


def test_prepare_cancel_and_commit_durability(store):
    prepared = store.prepare('one', 'sample.txt', b'hello', mode='original')
    token = store.stage('one', prepared)
    assert not list(store.storage.path.parent.rglob('*.txt'))
    store.discard('one', token)
    with pytest.raises(FileNotFoundError):
        store.commit('one', token)
    token = store.stage('one', prepared)
    store.configure('one', GuardOptions(level='allow'))
    assert store.commit('one', token)['mode'] == 'original'
    assert len(store.list('one')) == 1


def test_project_scope_delete_missing_and_tampered_file(store):
    report = original(store)
    identity = report['id']
    path, _ = store.original('one', identity)
    for method in [store.read, store.original, store.delete]:
        with pytest.raises(FileNotFoundError):
            method('two', identity)
    path.write_bytes(b'changed')
    with pytest.raises(ValueError, match='변경|손상'):
        store.selected('one', [identity])
    store.delete('one', identity)
    assert not path.exists()
    with pytest.raises(FileNotFoundError):
        store.selected('one', [identity])
    assert not path.exists()


def test_concurrent_delete_and_selection_cannot_recreate(store):
    report = original(store)
    path, _ = store.original('one', report['id'])
    def select():
        try:
            store.selected('one', [report['id']])
        except FileNotFoundError:
            pass
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(select) for _ in range(10)]
        pool.submit(store.delete, 'one', report['id']).result()
        for future in futures:
            future.result()
    assert not path.exists()
    assert store.list('one') == []


@pytest.mark.parametrize('name,data', [('x.exe', b'MZ'), ('x.pdf', b'fake'), ('x.docx', b'fake'),
    ('x.txt', b'\x00'), ('x.txt', b'\xff'), ('../escape.txt', b'hello'), ('C:\\escape.txt', b'hello'),
    ('x.txt', b'a' * (8 * 1024 * 1024 + 1))], ids=['exe','pdf','docx','null','encoding','traversal','drive','size'])
def test_invalid_original_leaves_no_file(store, name, data):
    with pytest.raises((ValueError, PermissionError)):
        original(store, data, filename=name)
    assert store.list('one') == []
    assert not list(store.storage.path.parent.rglob('*.txt'))


def test_link_and_hardlink_rejected(store, tmp_path):
    report = original(store)
    path, _ = store.original('one', report['id'])
    target = tmp_path / 'outside.txt'
    target.write_bytes(path.read_bytes())
    path.unlink()
    path.hardlink_to(target)
    with pytest.raises(PermissionError):
        store.original('one', report['id'])
    with pytest.raises(PermissionError):
        store.delete('one', report['id'])
    assert target.exists()


def test_original_docx_preserves_binary_without_conversion(store):
    from docx import Document
    doc = Document(); doc.add_paragraph('Synthetic original document')
    buffer = io.BytesIO(); doc.save(buffer)
    report = original(store, buffer.getvalue(), filename='sample.docx')
    assert store.original('one', report['id'])[1] == buffer.getvalue()


def test_restored_database_cannot_delete_live_originals(store):
    report = original(store)
    restored = Storage(store.storage.path.with_name('restored.sqlite3'))
    with store.storage.connect() as source, restored.connect() as target:
        source.backup(target)
    copy = Materials(restored)
    with pytest.raises(FileNotFoundError):
        copy.original('one', report['id'])
    copy.delete('one', report['id'])
    assert store.original('one', report['id'])[1] == b'password=synthetic-private\n'


def test_office_extension_and_xml_names_do_not_make_a_document(store):
    import zipfile
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as archive:
        archive.writestr('[Content_Types].xml', '<foo/>')
        archive.writestr('word/document.xml', '<foo/>')
    with pytest.raises(ValueError):
        original(store, stream.getvalue(), filename='fake.docx')


def test_original_pdf_validation_and_decompression_limit(store):
    import zlib
    from tests.test_pdf_materials import pdf_bytes, TABLE
    from app.core.material_originals import PDF_STRUCTURE_BYTES
    content = pdf_bytes([TABLE])
    report = original(store, content, filename='sample.pdf')
    assert store.original('one', report['id'])[1] == content
    data = zlib.compress(b'\x00' * (PDF_STRUCTURE_BYTES + 1))
    payload = b'%PDF-1.5\n1 0 obj\n<< /Type /XRef /Size 1 /W [1 1 1] /Length '+str(len(data)).encode()+b' /Filter /FlateDecode >>\nstream\n'+data+b'\nendstream\nendobj\nstartxref\n9\n%%EOF'
    with pytest.raises(ValueError):
        original(store, payload, filename='compressed.pdf')
    assert len(store.list('one')) == 1


def test_original_cancellation_leaves_no_pending_or_files(store):
    def cancelled():
        raise ValueError('cancelled')
    with pytest.raises(ValueError, match='cancelled'):
        store.prepare('one','cancel.txt',b'hello',checkpoint=cancelled,mode='original')
    assert not store.pending and store.list('one') == []


def test_original_size_boundary_and_missing_file(store):
    content = b'a' * (8 * 1024 * 1024)
    report = original(store, content)
    path, data = store.original('one', report['id'])
    assert data == content
    path.unlink()
    with pytest.raises(FileNotFoundError):
        store.selected('one', [report['id']])
    store.delete('one', report['id'])
    assert store.list('one') == []


def test_original_failed_db_commit_removes_new_file(store, monkeypatch):
    from contextlib import contextmanager
    connect = store.storage.connect
    prepared = store.prepare('one','sample.txt',b'hello',mode='original')
    @contextmanager
    def fail():
        with connect() as db:
            yield db
            raise ValueError('commit failed')
    monkeypatch.setattr(store.storage,'connect',fail)
    with pytest.raises(ValueError, match='commit failed'):
        store.persist('one',prepared)
    assert not list(store.storage.path.parent.rglob('*.txt'))


def test_reparse_path_is_rejected_before_read_or_delete(store, monkeypatch):
    from types import SimpleNamespace
    report = original(store)
    path, _ = store.original('one',report['id'])
    lstat = Path.lstat
    def reparse(value):
        if value == path.parent:
            return SimpleNamespace(st_mode=0,st_file_attributes=0x400)
        return lstat(value)
    monkeypatch.setattr(Path,'lstat',reparse)
    for operation in (store.original,store.delete):
        with pytest.raises(PermissionError):
            operation('one',report['id'])
    assert path.exists()
