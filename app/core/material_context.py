"""Local search over filtered Markdown. Offsets always refer to the saved copy."""
import json
import re


EXCERPT_NOTICE = ('[첨부 자료의 관련 부분 발췌입니다. 생략된 내용이 있으므로 문서 전체에 대한 '
                  '결론이나 정보의 부재를 단정하지 마세요. 전체 확인이 필요하면 사용자에게 알리세요.]')
WHOLE = re.compile(r'전체|전부|모든|요약|종합|요구\s*사항|검토|검증|비교|번역|설계|구현|개발|수정|작성|분석|빠짐|누락|'
                   r'합계|개수|몇|건수|목록|나열|정리|열거|만들|고쳐|리팩터|'
                   r'\b(all|every|entire|whole|summari\w*|review|compare|translate|implement|build|develop|write|analy\w*|'
                   r'total|count|list|overview|audit|check|validate|fix|change|create|generate)\b', re.I)
QUESTION = re.compile(r'\?|알려|찾아|어디|무엇|어떻게|얼마|언제|몇|\b(what|where|which|when|how|find|explain)\b', re.I)
STOP = set('자료 문서 파일 내용 설명 관련 대해 대한 어떻게 어디 무엇 알려줘 알려주세요 찾아줘 찾아주세요 받아 '
           '있어 있나요 인가요 무엇인가요 the a an is are of to in for about please what where which when how find explain'.split())
HEADING = re.compile(r'^(#{1,6})\s+')
SEPARATOR = re.compile(r'^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$')


def search_terms(query):
    # shortcut: lexical lookup only; use full context for global work or uncertain intent.
    if not query or len(query) > 600 or WHOLE.search(query) or not QUESTION.search(query):
        return []
    terms = []
    for word in re.findall(r'[\w-]+', query.lower()):
        if word in STOP:
            continue
        stripped = re.sub(r'(에서|으로|은|는|이|가|을|를|의|에|도|만|과|와)$', '', word)
        word = stripped if len(stripped) >= 2 else word
        if len(word) >= 2 and word not in STOP and word not in terms:
            terms.append(word)
    return terms if len(terms) <= 20 else []


def chunks(text):
    """Keep paragraphs, fences and table rows intact, with heading/header ranges."""
    lines = text.splitlines(keepends=True)
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))
    headings, result = [], []
    index = 0

    def add(first, last, parents):
        start, end = offsets[first], offsets[last]
        result.append((len(result), start, end, json.dumps(parents), text[start:end]))

    while index < len(lines):
        if not lines[index].strip():
            index += 1
            continue
        first = index
        heading = HEADING.match(lines[index])
        parents = [span for _, span in headings]
        if heading:
            level = len(heading[1])
            headings = [(depth, span) for depth, span in headings if depth < level]
            add(index, index + 1, [span for _, span in headings])
            headings.append((level, [offsets[index], offsets[index + 1]]))
            index += 1
        elif index + 1 < len(lines) and '|' in lines[index] and SEPARATOR.fullmatch(lines[index + 1].strip()):
            index += 2
            header = [offsets[first], offsets[index]]
            add(first, index, parents)
            while index < len(lines) and '|' in lines[index]:
                first = index
                index += 1
                while index < len(lines) and '|' in lines[index] and offsets[index + 1] - offsets[first] <= 1200:
                    index += 1
                add(first, index, parents + [header])
        elif fence := re.match(r'^\s*(`{3,}|~{3,})', lines[index]):
            index += 1
            closing = re.compile(r'^\s*' + re.escape(fence[1][0]) + '{' + str(len(fence[1])) + r',}\s*$')
            while index < len(lines):
                index += 1
                if closing.fullmatch(lines[index - 1].strip()):
                    break
            add(first, index, parents)
        else:
            index += 1
            while index < len(lines) and lines[index].strip() and not HEADING.match(lines[index]):
                if re.match(r'^\s*(`{3,}|~{3,})', lines[index]) or (index + 1 < len(lines) and SEPARATOR.fullmatch(lines[index + 1].strip())):
                    break
                index += 1
            add(first, index, parents)
    return result


def index_material(db, identity, text):
    # Concurrent readers may both discover an old upload without an index.
    db.execute('DELETE FROM material_chunks WHERE material=?', (identity,))
    db.executemany('INSERT INTO material_chunks(material,ordinal,start,end,parents,content) VALUES (?,?,?,?,?,?)',
                   [(identity, *chunk) for chunk in chunks(text)])


def merge_ranges(ranges):
    merged = []
    for start, end in sorted(ranges):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(end, merged[-1][1])
        else:
            merged.append([start, end])
    return merged


def render_excerpt(text, ranges):
    return EXCERPT_NOTICE + '\n\n' + '\n\n'.join(f'[문자 {start + 1}-{end}]\n{text[start:end]}' for start, end in ranges)


def retrieve(db, identity, text, terms, budget, whole_pages=False):
    if not terms or len(text) <= 8000 or budget < 500:
        return text, []
    if whole_pages:
        # PDF lines and slide shapes are not paragraphs: keep the complete source unit.
        starts = [m.start() for m in re.finditer(r'^# (?:PDF 페이지|PPT 슬라이드) \d+\s*$', text, re.M)]
        spans = list(zip(starts, starts[1:] + [len(text)]))
        ranges = merge_ranges([[start,end] for start,end in spans
                               if all(term in text[start:end].lower() for term in terms)])
        excerpt = render_excerpt(text, ranges)
        if ranges and len(excerpt) < len(text) and len(json.dumps(excerpt,ensure_ascii=False)) <= budget:
            return excerpt, ranges
        return text, []
    rows = db.execute('SELECT * FROM material_chunks WHERE material=? ORDER BY ordinal', (identity,)).fetchall()
    if not rows:
        # Existing uploads are indexed from the filtered copy, never from original files.
        if not db.in_transaction:
            db.execute('BEGIN IMMEDIATE')
        if not db.execute('SELECT 1 FROM materials WHERE id=?', (identity,)).fetchone():
            raise FileNotFoundError('자료를 찾을 수 없습니다.')
        index_material(db, identity, text)
        rows = db.execute('SELECT * FROM material_chunks WHERE material=? ORDER BY ordinal', (identity,)).fetchall()
    match = ' OR '.join('"' + term + '"' for term in terms)
    ranked = db.execute('SELECT ordinal FROM material_chunks WHERE material_chunks MATCH ? AND material=? ORDER BY bm25(material_chunks)',
                        (match, identity)).fetchall()
    rank = {row['ordinal']: i for i, row in enumerate(ranked)}
    # Substrings cover Korean particles and two-character terms missed by unicode61.
    scores = {row['ordinal']: sum(term in row['content'].lower() for term in terms) for row in rows}
    if not all(any(term in row['content'].lower() for row in rows) for term in terms):
        return text, []
    candidates = sorted((n for n, score in scores.items() if score), key=lambda n: (-scores[n], rank.get(n, len(rows)), n))
    # Generated DOCX table labels are not document section boundaries, including in old uploads.
    sections = [(row['start'], len(heading[1])) for row in rows
                if (heading := HEADING.match(row['content'])) and not re.fullmatch(r'## T\d+\s*', row['content'])]
    ranges = []
    for number in candidates:
        row = rows[number]
        parents = json.loads(row['parents'])
        table = any(SEPARATOR.fullmatch(line.strip()) for line in row['content'].splitlines()[:2]) or (
            parents and not HEADING.match(text[parents[-1][0]:parents[-1][1]]))
        if not table:
            # Adjacent paragraphs can omit later exceptions; keep the complete prose section.
            section = next((span for span in reversed(sections) if span[0] <= row['start']), None)
            if section is None:
                return text, []
            start, depth = section
            end = next((position for position, level in sections if position > start and level <= depth), len(text))
            proposed = merge_ranges(ranges + [[start, end]] + parents)
            excerpt = render_excerpt(text, proposed)
            if len(json.dumps(excerpt, ensure_ascii=False)) > budget:
                return text, []
            ranges = proposed
            continue
        related = [rows[number]]
        hit_range = [rows[number]['start'], rows[number]['end']]
        # A title/header hit needs its contents, not just the title/header itself.
        related.extend(row for row in rows if hit_range in json.loads(row['parents']))
        related.extend(rows[n] for n in (number - 1, number + 1)
                       if 0 <= n < len(rows) and rows[n]['parents'] == rows[number]['parents'])
        proposed = merge_ranges(ranges + [[row['start'], row['end']] for row in related]
                                + [span for row in related for span in json.loads(row['parents'])])
        excerpt = render_excerpt(text, proposed)
        if len(json.dumps(excerpt, ensure_ascii=False)) <= budget:
            ranges = proposed
        else:
            # Never drop a later match just because earlier matches filled the budget.
            return text, []
    excerpt = render_excerpt(text, ranges)
    if not ranges or len(excerpt) >= len(text) or not all(term in excerpt.lower() for term in terms):
        return text, []
    return excerpt, ranges
