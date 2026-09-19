"""Attachment repository and local import boundary. No raw source files are retained."""
import hashlib
import json
from pathlib import Path
from uuid import uuid4
from app.core.data_guard import GuardOptions, RULE_VERSION, guard
from app.core.material_extract import extract
from app.core.storage import now
from app.models.schemas import ContextPart


def fingerprint(options):
    return hashlib.sha256((RULE_VERSION+options.model_dump_json()).encode()).hexdigest()


class Materials:
    def __init__(self, storage):
        self.storage = storage

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
        options = self.options(project)
        parts, omissions = extract(filename, content)
        try:
            report = guard(parts, options)
        except Exception:
            raise ValueError('민감정보 검사에 실패했습니다. 자료를 저장하거나 전달하지 않았습니다.') from None
        text = '\n'.join('['+part['location']+'] '+part['text'] for part in report.pop('parts'))
        identity = uuid4().hex
        # Filenames may contain personal data; retain only format + generated ID.
        report.update(id=identity, label='자료 '+identity[:8]+Path(filename).suffix.lower(),
                      created_at=now(), test_data=test_data, omissions=omissions)
        with self.storage.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT COUNT(*) FROM materials WHERE project=?',(project,)).fetchone()[0]>=100:
                raise ValueError('자료는 프로젝트별 100개까지 보관합니다. 불필요한 자료를 삭제하세요.')
            db.execute('INSERT INTO materials VALUES (?,?,?,?,?)',
                       (identity,project,fingerprint(options),json.dumps(report,ensure_ascii=False),text))
        return report

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
            db.execute('DELETE FROM materials WHERE project=? AND id=?',(project,identity))

    def selected(self, project, identities):
        current = fingerprint(self.options(project))
        selected, reports = [], []
        for identity in dict.fromkeys(identities):
            row = self.read(project, identity)
            report = json.loads(row['report'])
            if report['status']!='ready': raise ValueError('차단된 자료는 전달할 수 없습니다.')
            if row['fingerprint']!=current: raise ValueError('가드 설정이 변경되었습니다. 선택 자료를 다시 업로드하세요.')
            selected.append(ContextPart(path=report['label'],content=row['content']))
            reports.append(report)
        return selected, {'scope':'attachments','state':'prepared','materials':reports} if reports else None
