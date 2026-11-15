import asyncio
import json
import sys
from pathlib import Path

import pytest

from app.core.materials import Materials
from app.core.storage import Storage
from app.models.schemas import AgentContext
from app.core.material_originals import manifest


@pytest.fixture
def delivery(tmp_path):
    store = Materials(Storage(tmp_path / 'private' / 'runtime.sqlite3'))
    report = store.import_file('one', 'sample.txt', b'synthetic original', mode='original')
    parts, _ = store.selected('one', [report['id']])
    context = AgentContext(task='read selected file', rules=[], files=parts)
    cwd = tmp_path / 'project'
    cwd.mkdir()
    return store, report, context, cwd


def test_delivery_is_selected_original_inside_cwd_and_removed_after_run(delivery):
    store, report, context, cwd = delivery
    store.import_file('one', 'unselected.txt', b'unselected', mode='original')
    before = context.model_dump_json()
    with store.original_delivery('one', [report['id']], context, cwd) as sent:
        copy = Path(json.loads(sent.files[0].content)['path'])
        assert copy.is_relative_to(cwd)
        assert copy.read_bytes() == b'synthetic original'
        assert list(cwd.rglob('*.txt')) == [copy]
        assert context.model_dump_json() == before
    assert not copy.exists()
    assert not list(cwd.rglob('*.txt'))
    assert store.original('one', report['id'])[1] == b'synthetic original'


@pytest.mark.parametrize('error', [RuntimeError, asyncio.CancelledError])
def test_failed_or_cancelled_delivery_removes_copy(delivery, error):
    store, report, context, cwd = delivery
    with pytest.raises(error):
        with store.original_delivery('one', [report['id']], context, cwd):
            raise error()
    assert not list(cwd.rglob('*.txt'))


def test_deleted_or_wrong_project_original_is_not_staged(delivery):
    store, report, context, cwd = delivery
    for project in ['two', 'one']:
        if project == 'one':
            store.delete('one', report['id'])
        with pytest.raises(FileNotFoundError):
            with store.original_delivery(project, [report['id']], context, cwd):
                pytest.fail('deleted or unrelated material dispatched')
    assert not list(cwd.rglob('*.txt'))


def test_delete_during_preparation_does_not_dispatch_or_leave_copy(delivery, monkeypatch):
    store, report, context, cwd = delivery
    original = store.original
    def read_then_delete(project, identity):
        result = original(project, identity)
        store.delete(project, identity)
        return result
    monkeypatch.setattr(store, 'original', read_then_delete)
    with pytest.raises(FileNotFoundError):
        with store.original_delivery('one', [report['id']], context, cwd):
            pytest.fail('deleted material dispatched')
    assert not list(cwd.rglob('*.txt'))


def test_parallel_deliveries_have_independent_cleanup(delivery):
    store, report, context, cwd = delivery
    with store.original_delivery('one', [report['id']], context, cwd) as first:
        first_path = Path(json.loads(first.files[0].content)['path'])
        with store.original_delivery('one', [report['id']], context, cwd) as second:
            second_path = Path(json.loads(second.files[0].content)['path'])
            assert first_path != second_path
        assert first_path.exists() and not second_path.exists()
    assert not first_path.exists()


def test_tampered_original_is_not_staged(delivery):
    store, report, context, cwd = delivery
    path, _ = store.original('one', report['id'])
    path.write_bytes(b'tampered')
    with pytest.raises(ValueError):
        with store.original_delivery('one', [report['id']], context, cwd):
            pytest.fail('tampered original dispatched')
    assert not list(cwd.rglob('*.txt'))


def test_delivery_without_originals_does_not_create_directory(delivery):
    store, _, _, cwd = delivery
    report = store.import_file('one', 'text.txt', b'text mode')
    parts, _ = store.selected('one', [report['id']])
    context = AgentContext(task='read', rules=[], files=parts)
    with store.original_delivery('one', [report['id']], context, cwd) as sent:
        assert sent == context
    assert list(cwd.iterdir()) == []


def test_delivery_rejects_reparse_directory(delivery, monkeypatch):
    from types import SimpleNamespace
    store, report, context, cwd = delivery
    root = cwd / '.codast-attachments'
    root.mkdir()
    lstat = Path.lstat
    def info(path):
        if path == root:
            return SimpleNamespace(st_mode=0, st_file_attributes=0x400)
        return lstat(path)
    monkeypatch.setattr(Path, 'lstat', info)
    with pytest.raises(PermissionError):
        with store.original_delivery('one', [report['id']], context, cwd):
            pytest.fail('reparse directory accepted')
    assert list(root.iterdir()) == []


def test_delivery_requires_private_ignore_rules(delivery):
    store, report, context, cwd = delivery
    root = cwd / '.codast-attachments'
    root.mkdir()
    marker = root / '.gitignore'
    marker.write_text('!*.txt\n', encoding='utf-8')
    with pytest.raises(ValueError):
        with store.original_delivery('one', [report['id']], context, cwd):
            pytest.fail('unsafe ignore rules accepted')
    assert marker.read_text(encoding='utf-8') == '!*.txt\n'
    assert not list(cwd.rglob('*.txt'))


def test_pdf_manifest_points_to_installed_reader_runtime(tmp_path):
    result = manifest(tmp_path / 'sample.pdf', {'bytes': 100, 'sha256': 'synthetic'})
    runtime = result['reader_runtime']
    assert runtime['python'] == sys.executable
    assert runtime['text_library'] == 'pdfplumber'
    assert runtime['render_library'] == 'pypdfium2'
    assert '-B' in runtime['instruction']


def test_non_pdf_manifest_does_not_advertise_pdf_reader(tmp_path):
    result = manifest(tmp_path / 'sample.docx', {'bytes': 100, 'sha256': 'synthetic'})
    assert 'reader_runtime' not in result


def test_advertised_runtime_reads_original_pdf_from_foreign_cwd(tmp_path):
    import subprocess
    from tests.test_pdf_materials import pdf_bytes
    path = tmp_path / 'two pages.pdf'
    data = pdf_bytes([b'BT /F1 14 Tf 50 740 Td (FIRST-SYNTHETIC) Tj ET',
                      b'BT /F1 14 Tf 50 740 Td (SECOND-SYNTHETIC) Tj ET'])
    path.write_bytes(data)
    runtime = manifest(path, {'bytes': len(data), 'sha256': 'synthetic'})['reader_runtime']
    child = tmp_path / 'different cwd'
    child.mkdir()
    code = ('import sys,pdfplumber,pypdfium2; '
            'pdf=pdfplumber.open(sys.argv[1]); '
            'print("|".join(page.extract_text() for page in pdf.pages)); pdf.close()')
    result = subprocess.run([runtime['python'], '-B', '-c', code, str(path)], cwd=child,
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'FIRST-SYNTHETIC|SECOND-SYNTHETIC'
    assert path.read_bytes() == data
