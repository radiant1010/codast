import json
import pytest
from app.core.data_guard import GuardOptions, guard
from app.core.material_extract import extract
from app.main import create_app


def pdf_bytes(streams, font=None, extra_objects=(), font_resources=b'/F1 3 0 R', rotation=0):
    """Small synthetic PDFs, no external fixture files or document-generation dependency."""
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'']
    objects.append(font or b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    objects.extend(extra_objects)
    kids = []
    for stream in streams:
        number = len(objects)+1
        kids.append(f'{number} 0 R')
        objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Rotate {rotation} /Resources << /Font << '.encode()+font_resources+f' >> >> /Contents {number+1} 0 R >>'.encode())
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


def test_pdf_empty_decoration_tables_do_not_generate_empty_markdown(tmp_path):
    drawing = TABLE.split(b'BT /F1')[0]+b'BT /F1 12 Tf 50 750 Td (Consultation) Tj ET'
    store = create_app(tmp_path/'ws').state.harness
    store.projects.create('one')
    report = store.materials.import_file('one', 'decoration.pdf', pdf_bytes([drawing]))
    text = store.materials.read('one', report['id'])['content']
    assert 'Consultation' in text
    assert '| --- |' not in text and 'P1T' not in text


def inherited_korean_font_pdf(drawings=b'', table=False, rotation=0):
    cmap = b'''/CIDInit /ProcSet findresource begin
12 dict begin begincmap
/Adobe-Korea1-UCS2 usecmap
/CIDSystemInfo << /Registry (Unidocs) /Ordering (Korea1) /Supplement 1 >> def
/CMapName /Synthetic-Korean def /CMapType 2 def
1 begincodespacerange <0000> <ffff> endcodespacerange
endcmap CMapName currentdict /CMap defineresource pop end end'''
    font = b'<< /Type /Font /Subtype /Type0 /BaseFont /HYGoThic-Medium /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>'
    descendant = b'<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYGoThic-Medium /CIDSystemInfo << /Registry (Unidocs) /Ordering (Korea1) /Supplement 1 >> /DW 1000 >>'
    mapping = b'<< /Length '+str(len(cmap)).encode()+b' >>\nstream\n'+cmap+b'\nendstream'
    objects = [descendant, mapping]
    resources = b'/F1 3 0 R'
    if table:
        objects.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
        resources += b' /F2 6 0 R'
        drawings += TABLE.replace(b'/F1',b'/F2')
    return pdf_bytes([drawings+b'BT /F1 12 Tf 50 600 Td <088E0A0A> Tj ET'], font, objects, resources, rotation)


def test_pdf_recovers_inherited_korean_font_without_cid_output():
    parts, omissions = extract('korean.pdf', inherited_korean_font_pdf())
    text = '\n'.join(part.text for part in parts)
    assert '사용' in text
    assert '(cid:' not in text
    assert any('폰트' in item for item in omissions)


def test_pdf_page_limit_has_a_specific_error():
    with pytest.raises(ValueError, match='^PDF는 100페이지 이하'):
        extract('large.pdf', pdf_bytes([b'']*101))


def test_font_recovery_does_not_run_table_detection_on_dense_drawings():
    parts, _ = extract('drawing.pdf', inherited_korean_font_pdf(b'0 0 m 1 1 l S\n'*10001))
    assert '사용' in '\n'.join(part.text for part in parts)


def test_font_recovery_still_excludes_rotated_text():
    rotation = b'BT /F1 12 Tf 0 1 -1 0 80 600 Tm <088E0A0A> Tj ET\n'
    parts, omissions = extract('rotated.pdf', inherited_korean_font_pdf(rotation))
    assert '\n'.join(part.text for part in parts).count('사용') == 1
    assert any('회전된 텍스트 제외' in item for item in omissions)


def test_font_recovery_preserves_table_fields_for_privacy_filter():
    parts, _ = extract('mixed-font.pdf', inherited_korean_font_pdf(table=True))
    report = guard(parts, GuardOptions())
    text = '\n'.join(part['text'] for part in report['parts'])
    assert '사용' in text and 'Delivery request' in text
    assert 'Sample Person' not in text
    assert any(part.field=='name' for part in parts)


def test_font_recovery_handles_page_rotation():
    parts, _ = extract('page-rotation.pdf', inherited_korean_font_pdf(rotation=180))
    text = ''.join(part.text for part in parts)
    assert sorted(text) == sorted('사용') and '(cid:' not in text


def test_font_recovery_deduplicates_overprinted_glyphs():
    overprint = b'BT /F1 12 Tf 50 600 Td <088E0A0A> Tj ET\n'
    parts, _ = extract('overprint.pdf', inherited_korean_font_pdf(overprint))
    assert ''.join(part.text for part in parts) == '사용'


def test_pdf_columns_read_left_body_before_right_body():
    stream=b"""300 100 m 300 700 l S
BT /F1 12 Tf 50 750 Td (Page title) Tj ET
BT /F1 12 Tf 50 680 Td (Left first) Tj ET
BT /F1 12 Tf 50 650 Td (Left second) Tj ET
BT /F1 12 Tf 330 680 Td (Right first) Tj ET
BT /F1 12 Tf 330 650 Td (Right second) Tj ET
BT /F1 12 Tf 50 50 Td (Page footer) Tj ET"""
    parts,_=extract('columns.pdf',pdf_bytes([stream]))
    assert [p.text for p in parts]==['Page title','Left first','Left second','Right first','Right second','Page footer']


def test_pdf_horizontal_table_preserves_rows_and_separate_next_table():
    stream=b"""50 700 m 550 700 l S 50 680 m 550 680 l S
50 650 m 250 650 l S 250 650 m 550 650 l S
50 620 m 250 620 l S 250 620 m 550 620 l S
50 680 m 50 700 l S 250 680 m 250 700 l S 550 680 m 550 700 l S
BT /F1 12 Tf 60 685 Td (name) Tj ET
BT /F1 12 Tf 260 685 Td (request) Tj ET
BT /F1 12 Tf 60 660 Td (Sample Person) Tj ET
BT /F1 12 Tf 260 660 Td (Delivery request) Tj ET
BT /F1 12 Tf 60 630 Td (Other Person) Tj ET
BT /F1 12 Tf 260 630 Td (Second request) Tj ET
BT /F1 12 Tf 50 590 Td (Next section) Tj ET"""
    parts,_=extract('horizontal.pdf',pdf_bytes([stream]))
    assert any(p.text=='Sample Person' and p.field=='name' for p in parts)
    assert any(p.text=='Delivery request' and p.field=='request' for p in parts)
    assert any(p.text=='Next section' and p.location.startswith('P1L') for p in parts)
    assert 'Sample Person' not in json.dumps(guard(parts,GuardOptions()))


def test_pdf_adjacent_tables_keep_their_own_sensitive_headers():
    first=TABLE.rsplit(b'BT /F1',1)[0]
    second=first
    for old,new in [(b'700',b'610'),(b'670',b'580'),(b'640',b'550'),(b'680',b'590'),(b'650',b'560')]:
        second=second.replace(old,new)
    second=second.replace(b'(name)',b'(task)').replace(b'(request)',b'(name)')
    second=second.replace(b'(Sample Person)',b'(Second task)').replace(b'(Delivery request)',b'(Other Person)')
    parts,_=extract('adjacent.pdf',pdf_bytes([first+second]))
    assert any(p.text=='Other Person' and p.field=='name' for p in parts)
    assert 'Other Person' not in json.dumps(guard(parts,GuardOptions()))


def test_pdf_column_sections_read_each_band_left_then_right():
    stream=b"""300 100 m 300 700 l S 50 400 m 550 400 l S
BT /F1 12 Tf 50 650 Td (Upper left) Tj ET
BT /F1 12 Tf 330 650 Td (Upper right) Tj ET
BT /F1 12 Tf 50 350 Td (Lower left) Tj ET
BT /F1 12 Tf 330 350 Td (Lower right) Tj ET"""
    parts,_=extract('bands.pdf',pdf_bytes([stream]))
    assert [p.text for p in parts]==['Upper left','Upper right','Lower left','Lower right']


def test_pdf_blank_border_row_does_not_replace_table_headers():
    border=b'50 730 m 550 730 l S 50 700 m 50 730 l S 250 700 m 250 730 l S 550 700 m 550 730 l S'
    parts,_=extract('blank-row.pdf',pdf_bytes([TABLE+border]))
    assert any(p.text=='Sample Person' and p.field=='name' for p in parts)
    assert 'Sample Person' not in json.dumps(guard(parts,GuardOptions()))


def test_pdf_column_rule_outside_page_is_clipped_before_cropping():
    stream=b"""300 -20 m 300 820 l S
BT /F1 12 Tf 50 650 Td (Left body) Tj ET
BT /F1 12 Tf 330 650 Td (Right body) Tj ET"""
    parts,_=extract('overflow-rule.pdf',pdf_bytes([stream]))
    assert [p.text for p in parts]==['Left body','Right body']
