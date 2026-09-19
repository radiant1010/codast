"""Local durable metadata. Workspace source files remain on the filesystem."""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import hashlib
from pathlib import Path
import sqlite3
from uuid import uuid4


def now():
    return datetime.now(timezone.utc).isoformat()


class ExistingRun(Exception):
    def __init__(self, run_id):
        self.run_id = run_id


class Storage:
    def __init__(self, path: Path):
        self.path = path.resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > 9:
                raise ValueError("현재 앱보다 새로운 DB 버전입니다.")
            db.execute("PRAGMA journal_mode=WAL")
            if version == 0:
                db.executescript("""
                    BEGIN IMMEDIATE;
                    CREATE TABLE IF NOT EXISTS project_settings (
                        project TEXT PRIMARY KEY,
                        settings TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS runs (
                        id TEXT PRIMARY KEY,
                        project TEXT NOT NULL,
                        command TEXT NOT NULL,
                        adapter TEXT NOT NULL,
                        status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
                        started_at TEXT NOT NULL,
                        finished_at TEXT,
                        output TEXT,
                        error TEXT
                    );
                    CREATE INDEX IF NOT EXISTS runs_project_started
                    ON runs(project, started_at DESC);
                    PRAGMA user_version=1;
                    COMMIT;
                """)
            if version < 2:
                db.executescript("""
                    BEGIN IMMEDIATE;
                    CREATE TABLE IF NOT EXISTS messages (
                        id TEXT PRIMARY KEY,
                        project TEXT NOT NULL,
                        task TEXT NOT NULL DEFAULT '',
                        text TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        run_id TEXT UNIQUE REFERENCES runs(id)
                    );
                    CREATE INDEX IF NOT EXISTS messages_project_task
                    ON messages(project, task, created_at);
                    INSERT OR IGNORE INTO messages(id,project,text,created_at,run_id)
                    SELECT id,project,json_extract(command,'$.text'),started_at,id FROM runs;
                    PRAGMA user_version=2;
                    COMMIT;
                """)

            if version < 3:
                db.executescript("""
                    BEGIN IMMEDIATE;
                    ALTER TABLE runs ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
                    CREATE TABLE task_states (
                        project TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
                        PRIMARY KEY(project,task)
                    );
                    CREATE TABLE client_sessions (
                        project TEXT NOT NULL, task TEXT NOT NULL, client TEXT NOT NULL,
                        cwd TEXT NOT NULL, mode TEXT NOT NULL, session_id TEXT NOT NULL,
                        PRIMARY KEY(project,task,client,cwd,mode)
                    );
                    CREATE TABLE client_config (client TEXT PRIMARY KEY, path TEXT NOT NULL);
                    PRAGMA user_version=3;
                    COMMIT;
                """)

            if version < 4:
                db.executescript("""
                    BEGIN IMMEDIATE;
                    CREATE TABLE run_events (
                        seq INTEGER PRIMARY KEY AUTOINCREMENT,
                        run_id TEXT NOT NULL REFERENCES runs(id),
                        kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
                    );
                    CREATE INDEX run_events_run_seq ON run_events(run_id,seq);
                    PRAGMA user_version=4;
                    COMMIT;
                """)

            if version < 5:
                db.executescript("""
                    BEGIN IMMEDIATE;
                    CREATE TABLE IF NOT EXISTS onboarding_state (
                        id INTEGER PRIMARY KEY CHECK(id=1),
                        status TEXT NOT NULL CHECK(status IN ('in_progress','deferred','completed')),
                        project TEXT,
                        client TEXT CHECK(client IN ('codex','claude')),
                        step TEXT NOT NULL CHECK(step IN ('project','client','authentication','complete')),
                        updated_at TEXT NOT NULL
                    );
                    PRAGMA user_version=5;
                    COMMIT;
                """)

            if version < 6:
                db.executescript("""
                    BEGIN IMMEDIATE;
                    CREATE TABLE IF NOT EXISTS chat_preferences (
                        project TEXT NOT NULL, task TEXT NOT NULL,
                        pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
                        archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
                        PRIMARY KEY(project,task)
                    );
                    PRAGMA user_version=6;
                    COMMIT;
                """)

            if version < 7:
                db.executescript("""
                    BEGIN IMMEDIATE;
                    CREATE TABLE IF NOT EXISTS rulebook_settings (project TEXT PRIMARY KEY, settings TEXT NOT NULL);
                    PRAGMA user_version=7;
                    COMMIT;
                """)

            if version < 8:
                db.execute('BEGIN IMMEDIATE')
                db.execute('CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, project TEXT NOT NULL, task TEXT NOT NULL, UNIQUE(project,task))')
                for table in ('messages','client_sessions'):
                    if 'chat_id' not in {row[1] for row in db.execute('PRAGMA table_info('+table+')')}:
                        db.execute('ALTER TABLE '+table+' ADD COLUMN chat_id TEXT')
                db.execute("""INSERT OR IGNORE INTO chats(id,project,task)
                    SELECT lower(hex(randomblob(16))),project,task FROM (
                      SELECT project,task FROM messages UNION SELECT project,task FROM task_states
                      UNION SELECT project,task FROM client_sessions UNION SELECT project,task FROM chat_preferences
                    ) WHERE task<>''""")
                for table in ('messages','client_sessions'):
                    db.execute('UPDATE '+table+' SET chat_id=(SELECT id FROM chats WHERE chats.project='+table+'.project AND chats.task='+table+'.task) WHERE chat_id IS NULL')
                db.execute('CREATE INDEX IF NOT EXISTS messages_chat_id ON messages(chat_id,created_at)')
                db.execute('CREATE UNIQUE INDEX IF NOT EXISTS client_sessions_chat_id ON client_sessions(chat_id,client,cwd,mode)')
                db.execute('PRAGMA user_version=8')
                db.commit()

            if version < 9:
                db.executescript("""
                    BEGIN IMMEDIATE;
                    CREATE TABLE IF NOT EXISTS guard_options (project TEXT PRIMARY KEY, options TEXT NOT NULL);
                    CREATE TABLE IF NOT EXISTS materials (id TEXT PRIMARY KEY, project TEXT NOT NULL,
                        fingerprint TEXT NOT NULL, report TEXT NOT NULL, content TEXT NOT NULL);
                    CREATE INDEX IF NOT EXISTS materials_project ON materials(project);
                    PRAGMA user_version=9;
                    COMMIT;
                """)

    @staticmethod
    def _chat_id(db, project, task):
        if not task:
            return None
        db.execute('INSERT OR IGNORE INTO chats VALUES (?,?,?)', (uuid4().hex,project,task))
        return db.execute('SELECT id FROM chats WHERE project=? AND task=?',(project,task)).fetchone()[0]

    def resolve_chat(self, project, task='', chat_id=None):
        with self.connect() as db:
            if chat_id:
                row = db.execute('SELECT id,task FROM chats WHERE project=? AND id=?',(project,chat_id)).fetchone()
                if not row:
                    raise FileNotFoundError('채팅을 찾을 수 없습니다.')
                return dict(row)
            return {'id':self._chat_id(db,project,task.strip()),'task':task.strip()}

    def rulebook_settings(self, project):
        with self.connect() as db:
            row = db.execute('SELECT settings FROM rulebook_settings WHERE project=?', (project,)).fetchone()
            return json.loads(row[0]) if row else {}

    def save_rulebook_settings(self, project, settings):
        with self.connect() as db:
            db.execute('INSERT INTO rulebook_settings VALUES (?,?) ON CONFLICT(project) DO UPDATE SET settings=excluded.settings', (project,json.dumps(settings,ensure_ascii=False)))

    def onboarding(self):
        with self.connect() as db:
            row = db.execute('SELECT status,project,client,step,updated_at FROM onboarding_state WHERE id=1').fetchone()
            return dict(row) if row else {'status': 'pending', 'project': None, 'client': None, 'step': 'client', 'updated_at': None}

    def save_onboarding(self, status, project, client, step):
        with self.connect() as db:
            db.execute('INSERT INTO onboarding_state VALUES (1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET '
                       'status=excluded.status,project=excluded.project,client=excluded.client,step=excluded.step,updated_at=excluded.updated_at',
                       (status, project, client, step, now()))
        return self.onboarding()

    def append_event(self, run_id, kind, text):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            count = db.execute('SELECT COUNT(*) FROM run_events WHERE run_id=?', (run_id,)).fetchone()[0]
            if count > 4096:
                return
            if count == 4096:
                kind, text = 'warning', '진행 로그 한도에 도달했습니다. 최종 결과는 별도로 저장됩니다.'
            db.execute('INSERT INTO run_events(run_id,kind,text,created_at) VALUES (?,?,?,?)',
                       (run_id, kind, str(text)[:8192], now()))

    def events(self, project, run_id, after=0, limit=200):
        self.run(project, run_id)
        with self.connect() as db:
            return [dict(row) for row in db.execute(
                'SELECT * FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?', (run_id, after, limit))]

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def settings(self, project):
        with self.connect() as db:
            row = db.execute("SELECT settings FROM project_settings WHERE project=?", (project,)).fetchone()
        return json.loads(row[0]) if row else {}

    def save_settings(self, project, settings):
        with self.connect() as db:
            db.execute("""INSERT INTO project_settings VALUES (?, ?, ?)
                ON CONFLICT(project) DO UPDATE SET settings=excluded.settings, updated_at=excluded.updated_at""",
                (project, json.dumps(settings, ensure_ascii=False), now()))

    def start_run(self, project, command, adapter, *, exclusive=False, request_id=None, reply_to=None, initial_metadata=None):
        run_id = hashlib.sha256(json.dumps([project, request_id]).encode()).hexdigest() if request_id else uuid4().hex
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if command.chat_id:
                chat = db.execute('SELECT task FROM chats WHERE project=? AND id=?', (project, command.chat_id)).fetchone()
                if not chat:
                    raise FileNotFoundError('채팅을 찾을 수 없습니다.')
                command = command.model_copy(update={'task': chat['task']})
            else:
                command = command.model_copy(update={'task': command.task.strip(), 'chat_id': self._chat_id(db, project, command.task.strip())})
            if request_id:
                prior = db.execute('SELECT command, adapter FROM runs WHERE id=? AND project=?', (run_id, project)).fetchone()
                if prior:
                    previous = json.loads(prior['command'])
                    previous.setdefault('material_ids', [])
                    if 'chat_id' not in previous:
                        message = db.execute('SELECT chat_id FROM messages WHERE run_id=?', (run_id,)).fetchone()
                        previous['chat_id'] = message['chat_id'] if message else None
                    if previous.get('chat_id') == command.chat_id and command.chat_id:
                        previous['task'] = command.task
                    if previous != command.model_dump() or prior['adapter'] != adapter:
                        raise FileExistsError('같은 요청 ID에 다른 실행 내용을 사용할 수 없습니다.')
                    raise ExistingRun(run_id)
            if exclusive and db.execute("SELECT 1 FROM runs WHERE project=? AND status='running'", (project,)).fetchone():
                raise FileExistsError("이 프로젝트에 실행 중이거나 종료 확인이 필요한 작업이 있습니다.")
            if reply_to:
                source = db.execute("SELECT r.metadata,r.status,m.chat_id FROM runs r JOIN messages m ON m.run_id=r.id WHERE r.project=? AND r.id=?", (project,reply_to)).fetchone()
                if not source or source['chat_id'] != command.chat_id:
                    raise FileNotFoundError('질문을 찾을 수 없습니다.')
                metadata = json.loads(source['metadata'])
                if source['status'] != 'completed' or not metadata.get('question') or metadata.get('reply_run_id'):
                    raise FileExistsError('이미 답변했거나 답변할 수 없는 질문입니다.')
                latest = db.execute('SELECT run_id FROM messages WHERE project=? AND chat_id=? AND run_id IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1', (project,command.chat_id)).fetchone()
                if not latest or latest['run_id'] != reply_to:
                    raise FileExistsError('이 질문 이후 새 실행이 있습니다. 현재 대화에서 계속해 주세요.')
                metadata['reply_run_id'] = run_id
                db.execute('UPDATE runs SET metadata=? WHERE id=?', (json.dumps(metadata,ensure_ascii=False),reply_to))
            if command.chat_id:
                db.execute("""UPDATE runs SET metadata=json_set(metadata,'$.superseded_by',?)
                    WHERE id IN (SELECT run_id FROM messages WHERE project=? AND chat_id=?)
                    AND json_extract(metadata,'$.question') IS NOT NULL
                    AND json_extract(metadata,'$.reply_run_id') IS NULL
                    AND json_extract(metadata,'$.superseded_by') IS NULL""", (run_id,project,command.chat_id))
            db.execute("""INSERT INTO runs(id,project,command,adapter,status,started_at)
                VALUES (?,?,?,?, 'running',?)""", (run_id, project, command.model_dump_json(), adapter, now()))
            if initial_metadata:
                db.execute('UPDATE runs SET metadata=? WHERE id=?', (json.dumps(initial_metadata,ensure_ascii=False),run_id))
            db.execute("INSERT INTO messages(id,project,task,text,created_at,run_id,chat_id) VALUES (?,?,?,?,?,?,?)",
                       (run_id, project, command.task.strip(), command.raw_text or command.text, now(), run_id, command.chat_id))
            db.execute('INSERT INTO run_events(run_id,kind,text,created_at) VALUES (?,?,?,?)',
                       (run_id, 'status', f'{adapter} 실행 시작', now()))
        return run_id

    def mark_guard_dispatch(self, run_id, audit):
        with self.connect() as db:
            db.execute("UPDATE runs SET metadata=json_set(metadata,'$.guard',json(?)) WHERE id=?",
                       (json.dumps(audit,ensure_ascii=False),run_id))

    def add_message(self, project, text, task, *, chat_id=None):
        message_id = uuid4().hex
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if chat_id:
                chat = db.execute('SELECT task FROM chats WHERE project=? AND id=?', (project, chat_id)).fetchone()
                if not chat:
                    raise FileNotFoundError('채팅을 찾을 수 없습니다.')
                task = chat['task']
            db.execute("INSERT INTO messages(id,project,task,text,created_at,chat_id) VALUES (?,?,?,?,?,?)",
                       (message_id, project, task.strip(), text, now(),self._chat_id(db,project,task.strip())))
        return message_id

    def attach_native_thread(self, project, task, cwd, session_id, client="codex"):
        if client not in ("codex", "claude"):
            raise ValueError("지원하지 않는 에이전트입니다.")
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute("SELECT 1 FROM runs WHERE project=? AND status='running'", (project,)).fetchone():
                raise FileExistsError('실행 중이거나 종료 확인이 필요한 작업이 있습니다.')
            if self._task_exists(db, project, task):
                raise FileExistsError('같은 이름의 채팅이 있습니다. 다른 이름을 사용하세요.')
            db.execute('INSERT INTO client_sessions VALUES (?,?,?,?,?,?,?)',
                       (project, task, client, cwd, 'read-only', session_id,self._chat_id(db,project,task)))
            db.execute('INSERT INTO messages(id,project,task,text,created_at,chat_id) VALUES (?,?,?,?,?,?)',
                       (uuid4().hex, project, task, f'기존 {client} 세션을 연결했습니다. 이전 대화는 네이티브 세션에 보관됩니다.', now(),self._chat_id(db,project,task)))
    def move_message(self, project, message_id, task):
        with self.connect() as db:
            old = db.execute("SELECT task FROM messages WHERE project=? AND id=?", (project,message_id)).fetchone()
            if db.execute("SELECT 1 FROM runs WHERE project=? AND status='running'", (project,)).fetchone():
                raise FileExistsError("실행이 끝난 뒤 메시지를 이동하세요.")
            if old:
                db.execute("DELETE FROM client_sessions WHERE project=? AND task IN (?,?)", (project,old['task'],task.strip()))
            result = db.execute("UPDATE messages SET task=?,chat_id=? WHERE project=? AND id=?",
                                (task.strip(), self._chat_id(db,project,task.strip()),project, message_id))
            if not result.rowcount:
                raise FileNotFoundError("메시지를 찾을 수 없습니다.")

    @staticmethod
    def _task_exists(db, project, task):
        return db.execute('SELECT 1 FROM messages WHERE project=? AND task=? UNION ALL '
                          'SELECT 1 FROM task_states WHERE project=? AND task=? UNION ALL '
                          'SELECT 1 FROM chats WHERE project=? AND task=? LIMIT 1',
                          (project, task, project, task, project, task)).fetchone() is not None

    def create_task(self, project, task):
        task = task.strip()
        if not task:
            raise ValueError('채팅 이름을 입력하세요.')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if self._task_exists(db, project, task):
                raise FileExistsError('같은 이름의 채팅이 있습니다.')
            chat_id = self._chat_id(db,project,task)
            db.execute('INSERT INTO task_states VALUES (?,?,?)', (project, task, 'active'))
        return {'id': chat_id, 'task': task, 'count': 0, 'status': 'active'}

    def tasks(self, project):
        with self.connect() as db:
            return [dict(row) for row in db.execute("""WITH names AS (
                SELECT task FROM messages WHERE project=? UNION SELECT task FROM task_states WHERE project=? UNION SELECT task FROM chats WHERE project=?)
                SELECT c.id, n.task, COUNT(m.id) AS count, COALESCE(s.status,'active') AS status,
                    COALESCE(p.pinned,0) AS pinned, COALESCE(p.archived,0) AS archived
                FROM names n LEFT JOIN chats c ON c.project=? AND c.task=n.task LEFT JOIN messages m ON m.project=? AND m.task=n.task
                LEFT JOIN task_states s ON s.project=? AND s.task=n.task
                LEFT JOIN chat_preferences p ON p.project=? AND p.task=n.task
                GROUP BY n.task ORDER BY pinned DESC, MAX(m.created_at) DESC,n.task""", (project,)*7)]

    def messages(self, project, task, limit, offset, chat_id=None):
        where = "m.project=?"
        args = [project]
        if chat_id:
            self.resolve_chat(project,chat_id=chat_id)
            where += " AND m.chat_id=?"
            args.append(chat_id)
        elif task is not None:
            where += " AND m.task=?"
            args.append(task)
        with self.connect() as db:
            rows = db.execute(f"""SELECT m.*, r.adapter, r.status, r.output, r.error, r.metadata
                FROM messages m LEFT JOIN runs r ON r.id=m.run_id
                WHERE {where} ORDER BY m.created_at DESC,m.id DESC LIMIT ? OFFSET ?""",
                (*args, limit, offset)).fetchall()
        return [dict(row) for row in rows]

    def pending_questions(self, project, chat_id):
        self.resolve_chat(project, chat_id=chat_id)
        with self.connect() as db:
            return [dict(row) for row in db.execute("""SELECT m.*,r.adapter,r.status,r.output,r.error,r.metadata
                FROM messages m JOIN runs r ON r.id=m.run_id
                WHERE m.project=? AND m.chat_id=? AND r.status='completed'
                  AND json_extract(r.metadata,'$.question') IS NOT NULL
                  AND json_extract(r.metadata,'$.reply_run_id') IS NULL
                  AND json_extract(r.metadata,'$.superseded_by') IS NULL
                ORDER BY m.created_at DESC LIMIT 1""", (project,chat_id))]

    def finish_run(self, run_id, status, *, output=None, error=None, adapter=None, metadata=None):
        with self.connect() as db:
            changed = db.execute("""UPDATE runs SET status=?, finished_at=?, output=?, error=?,
                adapter=COALESCE(?,adapter), metadata=COALESCE(?,metadata) WHERE id=? AND status='running'""",
                (status, now(), output, error, adapter, json.dumps(metadata,ensure_ascii=False) if metadata is not None else None, run_id))
            if not changed.rowcount:
                return
            db.execute('INSERT INTO run_events(run_id,kind,text,created_at) VALUES (?,?,?,?)',
                       (run_id, 'status', status, now()))

    def notifications(self, projects, after=0, limit=100):
        """Read durable terminal events, including runs completed between polls."""
        if not projects:
            return {'events': [], 'cursor': after, 'has_more': False}
        placeholders = ','.join('?' for _ in projects)
        with self.connect() as db:
            rows = db.execute(f"""SELECT e.seq, e.run_id, e.created_at, r.project, r.status,
                    COALESCE(m.task,'') AS task, m.chat_id,
                    (json_extract(r.metadata,'$.question') IS NOT NULL AND json_extract(r.metadata,'$.reply_run_id') IS NULL AND json_extract(r.metadata,'$.superseded_by') IS NULL) AS awaiting_answer
                FROM run_events e JOIN runs r ON r.id=e.run_id
                LEFT JOIN messages m ON m.run_id=r.id
                WHERE e.seq>? AND e.kind='status' AND e.text=r.status
                    AND r.status IN ('completed','failed','interrupted')
                    AND r.project IN ({placeholders})
                ORDER BY e.seq LIMIT ?""", (after, *projects, limit+1)).fetchall()
        events = [dict(row) for row in rows[:limit]]
        return {'events': events, 'cursor': events[-1]['seq'] if events else after,
                'has_more': len(rows)>limit}

    def runs(self, project, limit, offset):
        with self.connect() as db:
            rows = db.execute("SELECT * FROM runs WHERE project=? ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?",
                              (project, limit, offset)).fetchall()
        return [{**dict(row), "command": json.loads(row["command"])} for row in rows]

    def run(self, project, run_id):
        with self.connect() as db:
            row = db.execute("SELECT * FROM runs WHERE project=? AND id=?", (project,run_id)).fetchone()
        if not row:
            raise FileNotFoundError("실행을 찾을 수 없습니다.")
        return {**dict(row), "command": json.loads(row['command']), "metadata": json.loads(row['metadata'])}

    def session_overview(self, project):
        """Read native links and all unresolved runs, without a history-page limit."""
        with self.connect() as db:
            sessions = [dict(row) for row in db.execute(
                'SELECT * FROM client_sessions WHERE project=? ORDER BY task,client', (project,))]
            running = [dict(row) for row in db.execute(
                "SELECT * FROM runs WHERE project=? AND status='running' ORDER BY started_at DESC", (project,))]
        for row in running:
            row['command'] = json.loads(row['command'])
        return {'sessions': sessions, 'running': running, 'usage': self.session_usage(project)}

    def session_usage(self, project):
        """Aggregate recorded run usage by current chat and native session, not history page."""
        with self.connect() as db:
            rows = db.execute('''SELECT m.task,r.command,r.metadata,r.status,r.started_at
                FROM runs r JOIN messages m ON m.run_id=r.id AND m.project=r.project
                WHERE r.project=?''', (project,)).fetchall()
        groups = {}
        for row in rows:
            command, meta = json.loads(row['command']), json.loads(row['metadata'])
            key = (row['task'], command.get('client', 'mock'), meta.get('session_id'),
                   command.get('cwd', '.'), command.get('mode', 'read-only'))
            group = groups.setdefault(key, dict(project=project, task=key[0], client=key[1],
                session_id=key[2], cwd=key[3], mode=key[4], runs=0, running=0,
                input_tokens=None, output_tokens=None, input_reports=0, output_reports=0,
                last_started_at=row['started_at']))
            group['last_started_at'] = max(group['last_started_at'], row['started_at'])
            group['runs'] += 1
            group['running'] += row['status'] == 'running'
            usage = meta.get('usage') or {}
            if not isinstance(usage, dict):
                continue
            for kind in ('input', 'output'):
                value = usage.get(kind + '_tokens')
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    group[kind + '_tokens'] = (group[kind + '_tokens'] or 0) + value
                    group[kind + '_reports'] += 1
        return list(groups.values())

    def session(self, project, task, client, cwd, mode, *, chat_id=None):
        if chat_id:
            task = self.resolve_chat(project,chat_id=chat_id)['task']
        if not task:
            return None
        with self.connect() as db:
            row = db.execute("SELECT session_id FROM client_sessions WHERE project=? AND chat_id=(SELECT id FROM chats WHERE project=? AND task=?) AND client=? AND cwd=? AND mode=?",
                (project,project,task,client,cwd,mode)).fetchone()
        return row[0] if row else None

    def save_session(self, project, task, client, cwd, mode, session_id, *, chat_id=None):
        if chat_id:
            task = self.resolve_chat(project,chat_id=chat_id)['task']
        if task and session_id:
            with self.connect() as db:
                db.execute("INSERT OR REPLACE INTO client_sessions VALUES (?,?,?,?,?,?,?)", (project,task,client,cwd,mode,session_id,self._chat_id(db,project,task)))

    def forget_session(self, project, task, client, cwd, mode, *, chat_id=None):
        if chat_id:
            task = self.resolve_chat(project,chat_id=chat_id)['task']
        with self.connect() as db:
            db.execute("DELETE FROM client_sessions WHERE project=? AND task=? AND client=? AND cwd=? AND mode=?",
                (project,task,client,cwd,mode))

    def client_path(self, client):
        with self.connect() as db:
            row = db.execute("SELECT path FROM client_config WHERE client=?", (client,)).fetchone()
        return row[0] if row else ''

    def save_client_path(self, client, path):
        with self.connect() as db:
            db.execute("INSERT OR REPLACE INTO client_config VALUES (?,?)", (client,path))

    def update_task(self, project, task, title=None, status=None, *, pinned=None, archived=None, chat_id=None):
        task = task.strip()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if chat_id:
                chat = db.execute('SELECT task FROM chats WHERE project=? AND id=?', (project, chat_id)).fetchone()
                if not chat:
                    raise FileNotFoundError('채팅을 찾을 수 없습니다.')
                task = chat['task']
            title = title.strip() if title else task
            if (title != task or status is not None) and db.execute("SELECT 1 FROM runs WHERE project=? AND status='running'", (project,)).fetchone():
                raise FileExistsError("실행이 끝난 뒤 작업을 변경하세요.")
            if not self._task_exists(db, project, task):
                raise FileNotFoundError("작업을 찾을 수 없습니다.")
            old = db.execute("SELECT status FROM task_states WHERE project=? AND task=?", (project,task)).fetchone()
            self._chat_id(db,project,task)
            if title != task:
                if self._task_exists(db, project, title):
                    raise FileExistsError('같은 이름의 채팅이 있습니다. 다른 이름을 입력하세요.')
                db.execute("UPDATE chats SET task=? WHERE project=? AND task=?", (title,project,task))
                db.execute("UPDATE messages SET task=? WHERE project=? AND task=?", (title,project,task))
                db.execute("UPDATE client_sessions SET task=? WHERE project=? AND task=?", (title,project,task))
                db.execute("UPDATE chat_preferences SET task=? WHERE project=? AND task=?", (title,project,task))
                db.execute("DELETE FROM task_states WHERE project=? AND task=?", (project,task))
            db.execute("INSERT OR REPLACE INTO task_states VALUES (?,?,?)", (project,title,status or (old[0] if old else 'active')))
            if pinned is not None or archived is not None:
                db.execute('INSERT OR IGNORE INTO chat_preferences(project,task) VALUES (?,?)', (project,title))
                if pinned is not None:
                    db.execute('UPDATE chat_preferences SET pinned=? WHERE project=? AND task=?', (int(pinned),project,title))
                if archived is not None:
                    db.execute('UPDATE chat_preferences SET archived=? WHERE project=? AND task=?', (int(archived),project,title))

    def set_task_status(self, project, task, status):
        # Notes can change the backlog status without modifying a live native session.
        with self.connect() as db:
            self._chat_id(db,project,task)
            db.execute('INSERT OR REPLACE INTO task_states VALUES (?,?,?)', (project,task,status))
