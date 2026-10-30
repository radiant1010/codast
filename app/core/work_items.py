"""Goals connect existing runs and explicit human verification without copying outputs."""
from hashlib import sha256
import json
from uuid import uuid4

from app.core.storage import now
from app.models.schemas import Command, ContextPart, WorkItemRun


class WorkItems:
    def __init__(self, harness):
        self.harness, self.storage = harness, harness.storage

    def create(self, project, body):
        identity, stamp = uuid4().hex, now()
        with self.storage.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            chat_id = body.chat_id
            if chat_id:
                if not db.execute('SELECT 1 FROM chats WHERE project=? AND id=?', (project, chat_id)).fetchone():
                    raise FileNotFoundError('채팅을 찾을 수 없습니다.')
                if db.execute('SELECT 1 FROM work_items WHERE chat_id=?', (chat_id,)).fetchone():
                    raise FileExistsError('이미 목표가 연결된 채팅입니다.')
                if db.execute('''SELECT 1 FROM runs r JOIN messages m ON m.run_id=r.id
                        WHERE r.project=? AND m.chat_id=? AND r.status='running' ''', (project, chat_id)).fetchone():
                    raise FileExistsError('실행 종료를 확인한 뒤 목표를 연결하세요.')
            else:
                chat_id = self.storage._chat_id(db, project, body.title.strip()[:75] + ' / ' + identity)
            db.execute('''INSERT INTO work_items(id,project,title,goal,done_criteria,chat_id,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?)''',
                (identity, project, body.title.strip(), body.goal.strip(), body.done_criteria.strip(), chat_id, stamp, stamp))
        return self.read(project, identity)

    def for_chat(self, project, chat_id):
        with self.storage.connect() as db:
            row = db.execute('SELECT id,revision FROM work_items WHERE project=? AND chat_id=?', (project, chat_id)).fetchone()
        return dict(row) if row else None

    def for_run(self, project, run_id):
        with self.storage.connect() as db:
            row = db.execute('''SELECT w.id,w.revision FROM work_items w JOIN messages m ON m.chat_id=w.chat_id
                WHERE w.project=? AND m.project=w.project AND m.run_id=?''', (project, run_id)).fetchone()
        return dict(row) if row else None

    @staticmethod
    def context(item):
        return [ContextPart(path='현재 목표와 완료 조건', content=f"목표: {item['goal']}\n완료 조건: {item['done_criteria']}\n"
                            '결과와 검증 근거, 미확인 사항을 제출하세요. 실행 종료는 사용자 확인을 대신하지 않습니다.')]

    def submit_chat(self, project, command, request_id):
        chat = self.storage.resolve_chat(project, command.task, command.chat_id)
        item = self.for_chat(project, chat['id'])
        if not item:
            return self.harness.submit(project, command, request_id)
        body = WorkItemRun(**command.model_dump(), expected_revision=item['revision'], request_id=request_id or uuid4().hex)
        return self.start(project, item['id'], body)

    def reply(self, project, run_id, answer, request_id):
        linked = self.for_run(project, run_id)
        if not linked:
            raise FileNotFoundError('질문에 연결된 목표를 찾을 수 없습니다.')
        item = self.read(project, linked['id'])
        return self.harness.reply(project, run_id, answer, request_id, extra_context=self.context(item),
                                  work_item_id=item['id'], work_item_revision=item['revision'])

    def list(self, project):
        with self.storage.connect() as db:
            rows = db.execute('''SELECT w.*,r.adapter AS client,json_extract(r.metadata,'$.execution_model') AS model,
                r.status AS run_status,r.metadata AS run_metadata,r.finished_at AS run_finished_at,
                length(trim(coalesce(r.output,'')))>0 AS has_output,
                (SELECT json_object('run_id',v.run_id,'verdict',v.verdict,'note',v.note,'created_at',v.created_at)
                 FROM work_item_verifications v WHERE v.work_item_id=w.id AND v.run_id=w.latest_run_id
                 ORDER BY v.created_at DESC,v.id DESC LIMIT 1) AS latest_verification,
                (SELECT json_group_array(json_object('id',a.id,'adapter',a.adapter))
                 FROM runs a WHERE a.work_item_id=w.id AND a.project=w.project AND a.status='running') AS running_runs
                FROM work_items w LEFT JOIN runs r ON r.id=w.latest_run_id
                WHERE w.project=? ORDER BY w.updated_at DESC,w.id''', (project,)).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            metadata = json.loads(item.pop('run_metadata') or '{}')
            latest = {'id': item['latest_run_id'], 'adapter': item['client'], 'status': item.pop('run_status'),
                      'has_output': bool(item.pop('has_output')), 'finished_at': item.pop('run_finished_at'),
                      'metadata': {k: metadata[k] for k in ('question', 'reply_run_id', 'superseded_by') if k in metadata}}
            item['latest_run'] = latest if latest['id'] else None
            item['latest_verification'] = json.loads(item['latest_verification'] or 'null')
            item['running_runs'] = json.loads(item['running_runs'])
            result.append(self.runtime(item))
        return result

    def runtime(self, item):
        running = item.pop('running_runs', [r for r in item.get('runs', []) if r['status'] == 'running'])
        item['active_runs'] = [{'id': r['id'], 'client': r['adapter']} for r in running if r['id'] in self.harness.active]
        item['recovery_required'] = item['status'] == 'running' and (
            item['latest_run_id'] not in self.harness.active or len(running) != len(item['active_runs']))
        if item['hold']:
            item['resume_status'], item['status'] = item['status'], item['hold']
        return item

    def control(self, project, work_id, body):
        with self.storage.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            item = db.execute('SELECT * FROM work_items WHERE project=? AND id=?', (project, work_id)).fetchone()
            if not item:
                raise FileNotFoundError('목표 작업을 찾을 수 없습니다.')
            if item['revision'] != body.expected_revision:
                raise FileExistsError('작업 상태가 변경되었습니다. 최신 상태를 확인하세요.')
            if item['status'] == 'running' or db.execute(
                    "SELECT 1 FROM runs WHERE work_item_id=? AND status='running'", (work_id,)).fetchone():
                raise FileExistsError('실행 중인 작업은 먼저 실행을 취소하고 종료를 확인하세요.')
            if body.action == 'resume':
                if not item['hold']:
                    raise FileExistsError('보류 또는 취소된 작업만 재개할 수 있습니다.')
                hold, reason, since = '', '', ''
            else:
                if item['hold'] or item['status'] == 'done':
                    raise FileExistsError('이미 보류, 취소되었거나 완료된 작업입니다.')
                hold, reason, since = ('paused' if body.action == 'pause' else 'cancelled'), body.reason.strip(), now()
            db.execute('''UPDATE work_items SET hold=?,hold_reason=?,hold_since=?,revision=revision+1,
                updated_at=? WHERE id=?''', (hold, reason, since, now(), work_id))
        return self.read(project, work_id)

    def read(self, project, work_id):
        with self.storage.connect() as db:
            row = db.execute('SELECT * FROM work_items WHERE project=? AND id=?', (project, work_id)).fetchone()
            if not row:
                raise FileNotFoundError('목표 작업을 찾을 수 없습니다.')
            item = dict(row)
            runs = db.execute('SELECT * FROM runs WHERE project=? AND work_item_id=? ORDER BY started_at DESC,id DESC',
                              (project, work_id)).fetchall()
            item['runs'] = [dict(r, command=json.loads(r['command']), metadata=json.loads(r['metadata']),
                                 cancellable=r['id'] in self.harness.active) for r in runs]
            item['verifications'] = [dict(v) for v in db.execute(
                'SELECT * FROM work_item_verifications WHERE work_item_id=? ORDER BY created_at DESC,id DESC', (work_id,))]
        return self.runtime(item)

    def start(self, project, work_id, body):
        item = self.read(project, work_id)
        command = Command.model_validate(body.model_dump(exclude={'request_id', 'expected_revision'}))
        chat = self.storage.resolve_chat(project, chat_id=item['chat_id'])
        command = command.model_copy(update={'task': chat['task'], 'chat_id': chat['id']})
        latest = item['runs'][0] if item['runs'] else None
        reply_to = latest['id'] if latest and latest['metadata'].get('question') and not latest['metadata'].get('reply_run_id') else None
        return self.harness.submit(project, command, body.request_id, reply_to=reply_to, extra_context=self.context(item),
                                   work_item_id=work_id, work_item_revision=body.expected_revision)

    def record_verification(self, project, work_id, body):
        with self.storage.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            item = db.execute('SELECT * FROM work_items WHERE project=? AND id=?', (project, work_id)).fetchone()
            if not item:
                raise FileNotFoundError('목표 작업을 찾을 수 없습니다.')
            if item['revision'] != body.expected_revision or item['latest_run_id'] != body.run_id:
                raise FileExistsError('작업 상태나 결과가 변경되었습니다. 최신 결과를 확인하세요.')
            if item['hold']:
                raise FileExistsError('보류 또는 취소된 목표입니다. 먼저 작업을 재개하세요.')
            run = db.execute('SELECT * FROM runs WHERE project=? AND id=? AND work_item_id=?',
                             (project, body.run_id, work_id)).fetchone()
            if (not run or run['status'] != 'completed' or not (run['output'] or '').strip()
                    or json.loads(run['metadata']).get('question')):
                raise FileExistsError('완료된 결과만 검증할 수 있습니다. 질문이나 실행 오류를 먼저 확인하세요.')
            stamp = now()
            db.execute('INSERT INTO work_item_verifications VALUES (?,?,?,?,?,?,?,?,?)',
                       (uuid4().hex, work_id, body.run_id, body.verdict, int(body.criteria_met), body.note.strip(),
                        sha256(run['output'].encode('utf-8')).hexdigest(), 'local-user', stamp))
            status, phase = {'passed': ('done', 'resolve'), 'failed': ('blocked', 'hypothesize'),
                             'inconclusive': ('review', 'verify')}[body.verdict]
            db.execute('''UPDATE work_items SET status=?, phase=?, blocked_reason=?, revision=revision+1,
                updated_at=? WHERE id=?''', (status, phase, body.note.strip() if status == 'blocked' else '', stamp, work_id))
        return self.read(project, work_id)
