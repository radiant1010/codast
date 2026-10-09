import json
import pytest
from app.core.data_guard import GuardOptions, guard
from app.core.material_extract import extract
from app.main import create_app


def pdf_bytes(streams):
    """Small synthetic PDFs, no external fixture files or document-generation dependency."""
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'']
    objects.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    kids = []
    for stream in streams:
        number = len(objects)+1
        kids.append(f'{number} 0 R')
        objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents {number+1} 0 R >>'.encode())
        objects.append(b'<< /Length '+str(len(stream)).encode()+b' >>\nstream\n'+stream+b'\nendstream')
    objects[1] = f'<< /Type /Pages /Count {len(kids)} /Kids [{" ".join(kids)}] >>'.encode()
    output = bytearray(b'%PDF-1.4\n'); offsets = [0]
    for number, body in enumerate(objects,1):
        offsets.append(len(output)); output.extend(f'{number} 0 obj\n'.encode()+body+b'\nendobj\n')
    start = len(output)
    output.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]: output.extend(f'{offset:010} 00000 n \n'.encode())
    output.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF'.encode())
    return bytes(output)


TABLE = b'''0.5 w
50 700 m 550 700 l S 50 670 m 550 670 l S 50 640 m 550 640 l S
50 640 m 50 700 l S 250 640 m 250 700 l S 550 640 m 550 700 l S
BT /F1 12 Tf 60 680 Td (name) Tj ET
BT /F1 12 Tf 260 680 Td (request) Tj ET
BT /F1 12 Tf 60 650 Td (Sample Person) Tj ET
BT /F1 12 Tf 260 650 Td (Delivery request) Tj ET
BT /F1 12 Tf 50 750 Td (Consultation) Tj ET'''


def test_pdf_table_fields_page_positions_and_no_duplicate_body():
    parts, omissions = extract('private-filename.pdf', pdf_bytes([TABLE]))
    assert any(p.location=='P1T1R2C1' and p.field=='name' and p.text=='Sample Person' for p in parts)
    assert sum('Sample Person' in p.text for p in parts)==1
    assert any(p.location.startswith('P1L') and p.text=='Consultation' for p in parts)
    report = guard(parts, GuardOptions())
    assert 'Sample Person' not in json.dumps(report)
    assert any(p['text']=='Delivery request' for p in report['parts'])


def test_pdf_partial_and_unreadable_are_distinct():
    parts, omissions = extract('mixed.pdf', pdf_bytes([TABLE,b'']))
    assert parts and any('2페이지' in item and '텍스트' in item for item in omissions)
    with pytest.raises(ValueError): extract('scan.pdf', pdf_bytes([b'']))
    with pytest.raises(ValueError): extract('broken.pdf', b'%PDF-1.4\nsource-private-value')
    with pytest.raises(ValueError): extract('too-many.pdf', pdf_bytes([b'']*101))


def test_pdf_cancel_and_timeout_release_worker(monkeypatch):
    from app.core import material_pdf
    import multiprocessing
    before = {p.pid for p in multiprocessing.active_children()}
    calls = 0
    def cancel():
        nonlocal calls
        calls += 1
        if calls>1: raise ValueError('cancelled')
    with pytest.raises(ValueError,match='cancelled'):
        material_pdf.extract_pdf(pdf_bytes([TABLE]),checkpoint=cancel)
    assert {p.pid for p in multiprocessing.active_children()}==before
    monkeypatch.setattr(material_pdf,'PDF_TIMEOUT',0)
    with pytest.raises(ValueError,match='시간'):
        material_pdf.extract_pdf(pdf_bytes([TABLE]))
    assert {p.pid for p in multiprocessing.active_children()}==before


@pytest.mark.parametrize('staged',[False,True])
def test_pdf_attaches_automatically_with_filter_and_omission_report(tmp_path,staged):
    harness = create_app(tmp_path/'ws').state.harness
    harness.projects.create('one'); store = harness.materials
    prepared = store.prepare('one','table.pdf',pdf_bytes([TABLE,b'']))
    if staged:
        token = store.stage('one',prepared)
        assert store.list('one')==[]
        result = store.commit('one',token)
    else:
        result = store.persist('one',prepared)
    assert result['status']=='ready'
    assert any('2페이지' in message for message in result['omissions'])
    selected,_ = store.selected('one',[result['id']])
    assert 'Sample Person' not in selected[0].content
    assert 'Delivery request' in selected[0].content
    assert 'Consultation' in selected[0].content


def test_pdf_extraction_limits_do_not_save_partial_result():
    page=b'BT /F1 8 Tf 20 750 Td ('+b'A'*1300+b') Tj ET'
    with pytest.raises(ValueError): extract('long.pdf',pdf_bytes([page]*100))


def test_pdf_parser_does_not_log_source_values(capfd):
    extract('warning.pdf',pdf_bytes([b'/private-source G BT /F1 12 Tf 50 750 Td (Consultation) Tj ET']))
    captured = capfd.readouterr()
    assert 'private-source' not in captured.err+captured.out
