"""Attachment repository and local import boundary. No raw source files are retained."""
import hashlib
import json
from threading import Lock
from time import monotonic
from pathlib import Path
from uuid import uuid4
from app.core.data_guard import GuardOptions, RULE_VERSION, guard
from app.core.material_extract import extract
from app.core.material_markdown import to_markdown
from app.core.material_context import index_material, retrieve, search_terms
from app.core.storage import now
from app.models.schemas import ContextPart


def fingerprint(options):
    # Keep pre-selection fingerprints valid when the new option is unused.
    excluded = {'excel_sheets'} if not options.excel_sheets else set()
    excluded.add('test_data')  # Label for future uploads, not a content protection policy.
    if options.privacy_mode is None:
        excluded.add('privacy_mode')
    return hashlib.sha256((RULE_VERSION+options.model_dump_json(exclude=excluded)).encode()).hexdigest()


class Materials:
    def __init__(self, storage):
        self.storage = storage
        self.pending = {}
        self.pending_lock = Lock()

    def options(self, project):
        with self.storage.connect() as db:
            row = db.execute('SELECT options FROM guard_options WHERE project=?',(project,)).fetchone()
        return GuardOptions.model_validate_json(row[0]) if row else GuardOptions()

    def configure(self, project, options):
        with self.storage.connect() as db:
            db.execute('INSERT INTO guard_options VALUES (?,?) ON CONFLICT(project) DO UPDATE SET options=excluded.options',
                       (project,options.model_dump_json()))
        return options

    def import_file(self, project, filename, content, test_data=False):
        return self.persist(project, self.prepare(project, filename, content, test_data))

    def prepare(self, project, filename, content, test_data=False, checkpoint=lambda: None):
        checkpoint()
        options = self.options(project)
        parts, omissions = extract(filename, content, options, checkpoint)
        checkpoint()
        try:
            key = self.storage.guard_pseudonym_key(project) if options.privacy_mode == 'replace' else None
            report = guard(parts, options, key, checkpoint)
        except Exception:
            raise ValueError('민감정보 검사에 실패했습니다. 자료를 저장하거나 전달하지 않았습니다.') from None
        filtered = report.pop('parts')
        try:
            text = to_markdown(filtered, Path(filename).suffix.lower(), checkpoint) if report['status']=='ready' else ''
        except Exception:
            raise ValueError('문서 변환에 실패했습니다. 자료를 저장하거나 전달하지 않았습니다.') from None
        identity = uuid4().hex
        # Filenames may contain personal data; retain only format + generated ID.
        report.update(id=identity, label='자료 '+identity[:8]+Path(filename).suffix.lower(),
                      created_at=now(), test_data=test_data, omissions=omissions)
        if Path(filename).suffix.lower() in {'.pdf', '.pptx'}:
            report['context_structure'] = 'native-pages-v1'
        checkpoint()
        return fingerprint(options), report, text

    def persist(self, project, prepared):
        policy, report, text = prepared
        with self.storage.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT COUNT(*) FROM materials WHERE project=?',(project,)).fetchone()[0]>=100:
                raise ValueError('자료는 프로젝트별 100개까지 보관합니다. 불필요한 자료를 삭제하세요.')
            db.execute('INSERT INTO materials VALUES (?,?,?,?,?)',
                       (report['id'],project,policy,json.dumps(report,ensure_ascii=False),text))
            if text:
                index_material(db, report['id'], text)
        return report

    def stage(self, project, prepared):
        with self.pending_lock:
            self.pending = {k:v for k,v in self.pending.items() if v[0]>monotonic()}
            if len(self.pending)>=10:
                raise ValueError('검사 대기 자료가 많습니다. 잠시 후 다시 첨부하세요.')
            token = uuid4().hex
            self.pending[(project, token)] = (monotonic()+60, prepared)
            return token

    def discard(self, project, token):
        with self.pending_lock:
            self.pending.pop((project, token), None)

    def commit(self, project, token):
        with self.pending_lock:
            item = self.pending.pop((project, token), None)
        if not item or item[0]<=monotonic():
            raise FileNotFoundError('검사 결과가 만료되었거나 취소됐습니다. 다시 첨부하세요.')
        if item[1][0]!=fingerprint(self.options(project)):
            raise ValueError('보호 설정이 바뀌었습니다. 다시 첨부하세요.')
        return self.persist(project, item[1])

    def list(self, project):
        current = fingerprint(self.options(project))
        with self.storage.connect() as db:
            rows = db.execute('SELECT report,fingerprint FROM materials WHERE project=? ORDER BY rowid DESC',(project,)).fetchall()
        return [dict(json.loads(row['report']), stale=row['fingerprint']!=current) for row in rows]

    def read(self, project, identity):
        with self.storage.connect() as db:
            row = db.execute('SELECT * FROM materials WHERE project=? AND id=?',(project,identity)).fetchone()
        if not row: raise FileNotFoundError('자료를 찾을 수 없습니다.')
        return dict(row)

    def delete(self, project, identity):
        with self.storage.connect() as db:
            db.execute('DELETE FROM material_chunks WHERE material IN (SELECT id FROM materials WHERE project=? AND id=?)', (project,identity))
            db.execute('DELETE FROM materials WHERE project=? AND id=?',(project,identity))

    def selected(self, project, identities, query='', budget=24000):
        current = fingerprint(self.options(project))
        selected, reports, rows = [], [], []
        for identity in dict.fromkeys(identities):
            row = self.read(project, identity)
            report = json.loads(row['report'])
            if report['status']!='ready': raise ValueError('차단된 자료는 전달할 수 없습니다.')
            if row['fingerprint']!=current: raise ValueError('가드 설정이 변경되었습니다. 선택 자료를 다시 업로드하세요.')
            reports.append(report)
            rows.append(row)
        terms = search_terms(query)
        large = sum(len(row['content']) > 8000 for row in rows) if terms else 0
        reserved = sum(len(ContextPart(path=report['label'], content=row['content']).model_dump_json()) + 2
                       for row, report in zip(rows, reports) if not terms or len(row['content']) <= 8000)
        share = min(6000, (budget - reserved) // max(1, large) - 128)
        with self.storage.connect() as db:
            for row, report in zip(rows, reports):
                native = Path(report['label']).suffix.lower() in {'.pdf', '.pptx'}
                structured = native and report.get('context_structure') == 'native-pages-v1'
                # Older native uploads have no reliable page boundaries in their saved copy.
                query_terms = [] if native and not structured else terms
                text, ranges = retrieve(db, row['id'], row['content'], query_terms, share, whole_pages=structured)
                selected.append(ContextPart(path=report['label'],content=text))
                report['delivery'] = {'mode':'excerpt' if ranges else 'full', 'source_chars':len(row['content']),
                                      'sent_chars':len(text), 'ranges':ranges}
        return selected, {'scope':'attachments','state':'prepared','materials':reports} if reports else None
