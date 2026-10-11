"""PDF extraction in a disposable process, with no original file on disk."""
import io
import ctypes
import logging
import math
import multiprocessing
import re
from collections import defaultdict
from statistics import median
from threading import BoundedSemaphore
from time import monotonic

PDF_TIMEOUT = 20
PDF_SLOTS = BoundedSemaphore(2)


class _PdfLimit(ValueError):
    pass


def _table_settings(page, existing):
    horizontal = [e for e in page.edges if e['orientation']=='h' and e['width']>20]
    groups = defaultdict(set)
    for edge in horizontal:
        groups[(round(edge['x0'],1),round(edge['x1'],1))].add(round(edge['top'],1))
    vertical = []
    for (left,right), positions in groups.items():
        positions = sorted(positions)
        if len(positions)<2: continue
        spacing = median(b-a for a,b in zip(positions,positions[1:]))
        if len(positions)==2:
            preceding = [e['top'] for e in horizontal if e['x0']<=left+1 and e['x1']>=right-1
                         and .5<positions[0]-e['top']<=min(40,1.25*spacing)
                         and any(v['orientation']=='v' and abs(v['x0']-left)<1
                                 and v['top']<=e['top']<=v['bottom'] for v in page.edges)]
            if not preceding: continue
            positions.insert(0,max(preceding))
        gap = min(40,max(12,2*spacing))
        aligned = sorted((t.bbox for t in existing if t.bbox[0]<=left+1 and t.bbox[2]>=right-1),key=lambda b:b[1])
        breaks = [(a[3],b[1]) for a,b in zip(aligned,aligned[1:]) if a[3]<b[1]]
        runs = [[]]
        for y in positions:
            if runs[-1] and (y-runs[-1][-1]>gap or any(runs[-1][-1]<=a+1 and y>=b-1 for a,b in breaks)):
                runs.append([])
            runs[-1].append(y)
        for run in runs:
            if len(run)<3: continue
            above = [e['top'] for e in horizontal if e['x0']<=left+1 and e['x1']>=right-1
                     and .5<run[0]-e['top']<=min(40,1.25*spacing)
                     and not any(e['top']<=a+1 and run[0]>=b-1 for a,b in breaks)]
            top = max(above) if above else run[0]
            # Repeated row rules supply column boundaries even without drawn verticals.
            for x in (left,right):
                vertical.append(dict(object_type='line',orientation='v',x0=x,x1=x,width=0,
                                     top=top,bottom=run[-1],height=run[-1]-top))
    return {'explicit_vertical_lines':vertical}


def _reading_regions(page, tables):
    left,top,right,bottom = page.bbox
    for edge in sorted(page.edges,key=lambda e:e['height'],reverse=True):
        x,start,end = edge['x0'],max(top,edge['top']),min(bottom,edge['bottom'])
        if edge['orientation']!='v' or edge['height']<(bottom-top)*.4 or not left+(right-left)*.25<x<left+(right-left)*.75:
            continue
        chars = [c for c in page.chars if start<=c['top']<end]
        if not any(c['x1']<x for c in chars) or not any(c['x0']>x for c in chars): continue
        if any(c['x0']<x<c['x1'] for c in chars): continue
        crossing = sorted(set(e['top'] for e in page.edges if e['orientation']=='h'
                              and start<e['top']<end and e['x0']<x-6 and e['x1']>x+6))
        if any(b-a<40 for a,b in zip(crossing,crossing[1:])): continue
        if any(t.bbox[0]<x<t.bbox[2] and start<t.bbox[3] and t.bbox[1]<end
               and any(t.bbox[1]<=c['top']<t.bbox[3] and t.bbox[0]<=c['x0']<x for c in chars)
               and any(t.bbox[1]<=c['top']<t.bbox[3] and x<c['x1']<=t.bbox[2] for c in chars)
               for t in tables): continue
        regions = [(left,top,right,start)]
        boundaries = [start,*crossing,end]
        for a,b in zip(boundaries,boundaries[1:]):
            regions.extend([(left,a,x,b),(x,a,right,b)])
        return [*regions,(left,end,right,bottom)]
    # shortcut: only explicit long dividers define columns, revisit for unruled layouts.
    return [page.bbox]


def _read_pdf(content, sender):
    alternate = None
    try:
        import pdfplumber
        from app.core.material_extract import MAX_TEXT
        # Parser warnings can contain unprotected PDF operands.
        logging.disable(logging.CRITICAL)
        parts, omissions, size = [], ['PDF 이미지, 주석, 메타데이터는 전달하지 않음. 복잡한 표와 다단 문서의 읽기 순서는 검토 필요'], 0
        def add(location, text, field=''):
            nonlocal size
            text = text or ''
            size += len(text)
            if len(text)>16000 or size>MAX_TEXT or len(parts)>=10000:
                raise _PdfLimit('text')
            if text.strip() or re.search(r'R1C\d+$', location): parts.append((location,text,field or ''))
        with pdfplumber.open(io.BytesIO(content)) as pdf:
            if len(pdf.pages)>100: raise _PdfLimit('pages')
            for number,page in enumerate(pdf.pages,1):
                start = len(parts)
                if len(page.chars)>120000 or len(page.edges)>10000: raise _PdfLimit('layout')
                if page.images: omissions.append(f'{number}페이지: 이미지 내용은 읽지 못함, OCR 미지원')
                rotated = any(not char.get('upright',True) for char in page.chars)
                if rotated:
                    omissions.append(f'{number}페이지: 회전된 텍스트 제외')
                recovery = any(re.search(r'\(cid:\d+\)', char['text']) for char in page.chars)
                if recovery:
                    import pypdfium2
                    if alternate is None: alternate = pypdfium2.PdfDocument(content)
                    alternate_page = alternate[number-1]
                    text_page = alternate_page.get_textpage()
                    try:
                        count = text_page.count_chars()
                        if count>120000: raise _PdfLimit('layout')
                        origins = {}
                        glyph_x, glyph_y = ctypes.c_double(), ctypes.c_double()
                        for index in range(count):
                            if pypdfium2.raw.FPDFText_IsGenerated(text_page,index)==0 and pypdfium2.raw.FPDFText_GetCharOrigin(text_page,index,ctypes.byref(glyph_x),ctypes.byref(glyph_y)):
                                point = (glyph_x.value,glyph_y.value)
                                key = (math.floor(point[0]*100),math.floor(point[1]*100))
                                code = pypdfium2.raw.FPDFText_GetUnicode(text_page,index)
                                origins.setdefault(key,[]).append((*point,chr(code) if code else ''))
                        missing = False
                        # Recover glyphs in place so table headers and field protection survive.
                        x0,y0,x1,y1 = page.page_obj.mediabox
                        for char in page.chars:
                            if not char.get('upright',True) or not re.search(r'\(cid:\d+\)', char['text']):
                                continue
                            x,y = char['matrix'][4:]
                            x,y = {0:(x+x0,y+y0),90:(x1-y,x+y0),180:(x1-x,y1-y),270:(y+x0,y1-x)}[page.rotation]
                            key = (math.floor(x*100),math.floor(y*100))
                            candidates = [glyph for dx in (-1,0,1) for dy in (-1,0,1)
                                          for glyph in origins.get((key[0]+dx,key[1]+dy),[])
                                          if abs(glyph[0]-x)<.01 and abs(glyph[1]-y)<.01]
                            glyph = min(candidates,key=lambda glyph:(glyph[0]-x)**2+(glyph[1]-y)**2,default=None)
                            text = glyph[2] if glyph else ''
                            if not text or '\ufffe' in text or '\ufffd' in text:
                                missing = True
                            char['text'] = text.replace('\ufffe','').replace('\ufffd','')
                            if re.search(r'\(cid:\d+\)', char['text']): raise ValueError()
                    finally:
                        text_page.close()
                        alternate_page.close()
                    if missing:
                        omissions.append(f'{number}페이지: 일부 특수문자를 읽지 못함')
                    omissions.append(f'{number}페이지: 폰트 문자를 PDFium으로 복구')
                readable = page.dedupe_chars(tolerance=.01,extra_attrs=()) if recovery else page
                readable = readable.filter(lambda obj:obj.get('object_type')!='char' or obj.get('upright',True))
                existing = readable.find_tables()
                if len(existing)>100: raise _PdfLimit('layout')
                regions = _reading_regions(readable,existing)
                tables = []
                for box in regions:
                    if box[0]>=box[2] or box[1]>=box[3]: continue
                    column = readable if len(regions)==1 else readable.crop(box)
                    found = existing if len(regions)==1 else column.find_tables()
                    settings = _table_settings(column,found)
                    tables.extend(column.find_tables(settings) if settings['explicit_vertical_lines'] else found)
                    if len(tables)>100: raise _PdfLimit('layout')
                tables.sort(key=lambda table:(table.bbox[1],table.bbox[0]))
                tables = [(index,table,table.extract()) for index,table in enumerate(tables,1)]
                tables = [(index,table,rows) for index,table,rows in tables
                          if any((cell or '').strip() for row in rows for cell in row)]
                boxes = [table.bbox for _,table,_ in tables]
                outside = readable.filter(lambda obj:not any(
                    box[0]<=obj.get('x0',-1) and obj.get('x1',-1)<=box[2]
                    and box[1]<=obj.get('top',-1) and obj.get('bottom',-1)<=box[3] for box in boxes))
                def region_index(x,y):
                    return next((i for i,(left,top,right,bottom) in enumerate(regions)
                                 if left<=x<right and top<=y<bottom),0)
                blocks = []
                for region,box in enumerate(regions):
                    column = outside.filter(lambda obj:region_index(
                        (obj.get('x0',0)+obj.get('x1',0))/2,
                        (obj.get('top',0)+obj.get('bottom',0))/2)==region)
                    blocks += [(region,line['top'],line['x0'],'line',line['text']) for line in column.extract_text_lines()]
                blocks += [(region_index((table.bbox[0]+table.bbox[2])/2,table.bbox[1]),
                            table.bbox[1],table.bbox[0],'table',(index,rows)) for index,table,rows in tables]
                line_no = 0
                for _,_,_,kind,value in sorted(blocks,key=lambda block:block[:3]):
                    if kind=='line':
                        line_no += 1; add(f'P{number}L{line_no}',value)
                    else:
                        index,rows = value; headers = rows[0] if rows else []
                        for row,values in enumerate(rows,1):
                            for column,text in enumerate(values,1):
                                add(f'P{number}T{index}R{row}C{column}',text,headers[column-1] if row>1 and column<=len(headers) else '')
                if not any(part[1].strip() for part in parts[start:]): omissions.append(f'{number}페이지: 읽을 수 있는 텍스트 없음')
                page.close()
        sender.send((True,parts,omissions))
    except _PdfLimit as exc:
        sender.send((False,[],[str(exc)]))
    except Exception:
        # Never send a parser exception containing source text to the parent or UI.
        sender.send((False,[],[]))
    finally:
        if alternate is not None: alternate.close()
        sender.close()


def extract_pdf(content, checkpoint=lambda: None):
    from app.core.data_guard import Part
    checkpoint()
    started = monotonic()
    while not PDF_SLOTS.acquire(timeout=.05):
        checkpoint()
        if monotonic()-started>PDF_TIMEOUT: raise ValueError('PDF 처리 대기 시간이 초과되었습니다.')
    receiver, sender = multiprocessing.get_context('spawn').Pipe(duplex=False)
    worker = multiprocessing.get_context('spawn').Process(target=_read_pdf,args=(content,sender),daemon=True)
    try:
        worker.start(); sender.close()
        while True:
            checkpoint()
            if monotonic()-started>PDF_TIMEOUT: raise ValueError('PDF 처리 시간이 초과되었습니다. 필요한 페이지만 나눠 첨부하세요.')
            if receiver.poll(.05):
                try:
                    ok,parts,omissions = receiver.recv()
                except EOFError:
                    raise ValueError('PDF 추출에 실패했습니다. 파일을 다시 확인하세요.') from None
                checkpoint()
                if not ok:
                    reason = omissions[0] if omissions else ''
                    raise ValueError({'pages':'PDF는 100페이지 이하만 지원합니다. 필요한 페이지만 나누어 첨부하세요.',
                                      'text':'PDF 텍스트 처리 한도를 초과했습니다. 필요한 페이지만 나누어 첨부하세요.',
                                      'layout':'PDF 페이지 구조가 처리 한도를 초과했습니다. 필요한 부분만 나누어 첨부하세요.'}
                                     .get(reason,'PDF를 읽을 수 없습니다. 손상, 암호화 여부를 확인하세요.'))
                if not any(part[1].strip() for part in parts): raise ValueError('PDF에서 읽을 수 있는 텍스트가 없습니다. 글자가 있는 PDF나 직접 입력을 사용하세요.')
                return [Part(*part) for part in parts],omissions
            if not worker.is_alive(): raise ValueError('PDF 추출에 실패했습니다. 파일을 다시 확인하세요.')
    finally:
        if worker.pid is not None:
            if worker.is_alive(): worker.terminate()
            worker.join()
        receiver.close(); sender.close(); PDF_SLOTS.release()
