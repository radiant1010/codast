"""PDF extraction in a disposable process, with no original file on disk."""
import io
import logging
import multiprocessing
from threading import BoundedSemaphore
from time import monotonic

PDF_TIMEOUT = 20
PDF_SLOTS = BoundedSemaphore(2)


def _read_pdf(content, sender):
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
                raise ValueError()
            if text.strip(): parts.append((location,text,field or ''))
        with pdfplumber.open(io.BytesIO(content)) as pdf:
            if len(pdf.pages)>100: raise ValueError()
            for number,page in enumerate(pdf.pages,1):
                start = len(parts)
                if len(page.chars)>120000 or len(page.edges)>10000: raise ValueError()
                if page.images: omissions.append(f'{number}페이지: 이미지 내용은 읽지 못함, OCR 미지원')
                if any(not char.get('upright',True) for char in page.chars):
                    omissions.append(f'{number}페이지: 회전된 텍스트 제외')
                readable = page.filter(lambda obj:obj.get('object_type')!='char' or obj.get('upright',True))
                tables = readable.find_tables()
                if len(tables)>100: raise ValueError()
                boxes = [table.bbox for table in tables]
                outside = readable.filter(lambda obj:not any(
                    box[0]<=obj.get('x0',-1) and obj.get('x1',-1)<=box[2]
                    and box[1]<=obj.get('top',-1) and obj.get('bottom',-1)<=box[3] for box in boxes))
                blocks = [(line['top'],line['x0'],'line',line['text']) for line in outside.extract_text_lines()]
                blocks += [(table.bbox[1],table.bbox[0],'table',(index,table)) for index,table in enumerate(tables,1)]
                line_no = 0
                for _,_,kind,value in sorted(blocks,key=lambda block:block[:2]):
                    if kind=='line':
                        line_no += 1; add(f'P{number}L{line_no}',value)
                    else:
                        index,table = value; rows = table.extract(); headers = rows[0] if rows else []
                        for row,values in enumerate(rows,1):
                            for column,text in enumerate(values,1):
                                add(f'P{number}T{index}R{row}C{column}',text,headers[column-1] if row>1 and column<=len(headers) else '')
                if len(parts)==start: omissions.append(f'{number}페이지: 읽을 수 있는 텍스트 없음')
                page.close()
        sender.send((True,parts,omissions))
    except Exception:
        # Never send a parser exception containing source text to the parent or UI.
        sender.send((False,[],[]))
    finally:
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
                if not ok: raise ValueError('PDF를 읽을 수 없거나 처리 한도를 초과했습니다. 손상, 암호화 여부와 100페이지 제한을 확인하세요.')
                if not parts: raise ValueError('PDF에서 읽을 수 있는 텍스트가 없습니다. 글자가 있는 PDF나 직접 입력을 사용하세요.')
                return [Part(*part) for part in parts],omissions
            if not worker.is_alive(): raise ValueError('PDF 추출에 실패했습니다. 파일을 다시 확인하세요.')
    finally:
        if worker.pid is not None:
            if worker.is_alive(): worker.terminate()
            worker.join()
        receiver.close(); sender.close(); PDF_SLOTS.release()
