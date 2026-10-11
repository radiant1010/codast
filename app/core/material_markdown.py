"""Convert CODAST's filtered document body to reusable Markdown, entirely locally."""
from html import escape
import re

from app.core.material_extract import MAX_TEXT


CELL = re.compile(r'^(.*?)R(\d+)C(\d+)$')


def to_markdown(parts, suffix, checkpoint=lambda: None):
    if suffix in {'.txt', '.md'}:
        lines = {int(part['location'][1:]): part['text'] for part in parts}
        text = '\n'.join(lines.get(number, '') for number in range(1, max(lines, default=0)+1))
    else:
        from markitdown.converters import HtmlConverter
        blocks = []
        index = 0
        container = None
        while index < len(parts):
            checkpoint()
            part = parts[index]
            native = re.match(r'^P(\d+)[LT]', part['location']) if suffix == '.pdf' else (
                re.match(r'^S(\d+)T', part['location']) if suffix == '.pptx' else None)
            if native and native[1] != container:
                container = native[1]
                blocks.append('<h1>'+('PDF 페이지 ' if suffix == '.pdf' else 'PPT 슬라이드 ')+container+'</h1>')
            cell = CELL.fullmatch(part['location'])
            if not cell:
                tag = 'h'+str(part['heading']) if part.get('heading') else 'p'
                body = part['text']
                if native:
                    # Literal source text must not create a generated page boundary.
                    body = body.replace('#', r'\#')
                blocks.append('<'+tag+'>'+escape(body).replace('\n', '<br>')+'</'+tag+'>')
                index += 1
                continue
            prefix = cell[1]
            rows, columns = {}, set()
            while index < len(parts):
                checkpoint()
                cell = CELL.fullmatch(parts[index]['location'])
                if not cell or cell[1] != prefix:
                    break
                row, column = int(cell[2]), int(cell[3])
                rows.setdefault(row, {})[column] = parts[index]['text']
                columns.add(column)
                index += 1
            if prefix:
                blocks.append('<h2>'+escape(prefix)+'</h2>')
            blocks.append('<table>')
            # An absent header must not promote the first data row into a heading.
            rows.setdefault(1, {})
            for row, values in sorted(rows.items()):
                tag = 'th' if row == 1 else 'td'
                blocks.append('<tr>'+''.join(
                    '<'+tag+'>'+escape(values.get(column, '')).replace('\\', '\\\\')
                    .replace('|', '\\|').replace('\n', '&lt;br&gt;')+'</'+tag+'>'
                    for column in sorted(columns))+'</tr>')
            blocks.append('</table>')
        # Only escaped, already-filtered text reaches this converter. No URLs or plugins.
        text = HtmlConverter().convert_string(''.join(blocks), escape_asterisks=False,
                                              escape_underscores=False).markdown
    checkpoint()
    if len(text) > MAX_TEXT:
        raise ValueError('Markdown 변환 한도를 초과했습니다. 필요한 부분만 나누어 첨부하세요.')
    return text
