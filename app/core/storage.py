"""Local durable metadata. Workspace source files remain on the filesystem."""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
from uuid import uuid4


def now():
    return datetime.now(timezone.utc).isoformat()


class Storage:
    def __init__(self, path: Path):
        self.path = path.resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > 4:
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

    def start_run(self, project, command, adapter, *, exclusive=False):
        run_id = uuid4().hex
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if exclusive and db.execute("SELECT 1 FROM runs WHERE project=? AND status='running'", (project,)).fetchone():
                raise FileExistsError("이 프로젝트에 실행 중이거나 종료 확인이 필요한 작업이 있습니다.")
            db.execute("""INSERT INTO runs(id,project,command,adapter,status,started_at)
                VALUES (?,?,?,?, 'running',?)""", (run_id, project, command.model_dump_json(), adapter, now()))
            db.execute("INSERT INTO messages VALUES (?,?,?,?,?,?)",
                       (run_id, project, command.task.strip(), command.raw_text or command.text, now(), run_id))
            db.execute('INSERT INTO run_events(run_id,kind,text,created_at) VALUES (?,?,?,?)',
                       (run_id, 'status', f'{adapter} 실행 시작', now()))
        return run_id

    def add_message(self, project, text, task):
        message_id = uuid4().hex
        with self.connect() as db:
            db.execute("INSERT INTO messages VALUES (?,?,?,?,?,NULL)",
                       (message_id, project, task.strip(), text, now()))
        return message_id

    def attach_native_thread(self, project, task, cwd, session_id):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute("SELECT 1 FROM runs WHERE project=? AND status='running'", (project,)).fetchone():
                raise FileExistsError('실행 중이거나 종료 확인이 필요한 작업이 있습니다.')
            if db.execute('SELECT 1 FROM messages WHERE project=? AND task=?', (project, task)).fetchone():
                raise FileExistsError('같은 이름의 채팅이 있습니다. 다른 이름을 사용하세요.')
            db.execute('INSERT INTO client_sessions VALUES (?,?,?,?,?,?)',
                       (project, task, 'codex', cwd, 'read-only', session_id))
            db.execute('INSERT INTO messages VALUES (?,?,?,?,?,NULL)',
                       (uuid4().hex, project, task, '기존 Codex 세션을 연결했습니다. 이전 대화는 네이티브 세션에 보관됩니다.', now()))
    def move_message(self, project, message_id, task):
        with self.connect() as db:
            old = db.execute("SELECT task FROM messages WHERE project=? AND id=?", (project,message_id)).fetchone()
            if db.execute("SELECT 1 FROM runs WHERE project=? AND status='running'", (project,)).fetchone():
                raise FileExistsError("실행이 끝난 뒤 메시지를 이동하세요.")
            if old:
                db.execute("DELETE FROM client_sessions WHERE project=? AND task IN (?,?)", (project,old['task'],task.strip()))
            result = db.execute("UPDATE messages SET task=? WHERE project=? AND id=?",
                                (task.strip(), project, message_id))
            if not result.rowcount:
                raise FileNotFoundError("메시지를 찾을 수 없습니다.")

    def tasks(self, project):
        with self.connect() as db:
            return [dict(row) for row in db.execute("""SELECT m.task, COUNT(*) AS count, COALESCE(s.status,'active') AS status
                FROM messages m LEFT JOIN task_states s ON s.project=m.project AND s.task=m.task
                WHERE m.project=? GROUP BY m.task ORDER BY MAX(m.created_at) DESC""", (project,))]

    def messages(self, project, task, limit, offset):
        where = "m.project=?"
        args = [project]
        if task is not None:
            where += " AND m.task=?"
            args.append(task)
        with self.connect() as db:
            rows = db.execute(f"""SELECT m.*, r.adapter, r.status, r.output, r.error, r.metadata
                FROM messages m LEFT JOIN runs r ON r.id=m.run_id
                WHERE {where} ORDER BY m.created_at DESC,m.id DESC LIMIT ? OFFSET ?""",
                (*args, limit, offset)).fetchall()
        return [dict(row) for row in rows]

    def finish_run(self, run_id, status, *, output=None, error=None, adapter=None, metadata=None):
        with self.connect() as db:
            db.execute("""UPDATE runs SET status=?, finished_at=?, output=?, error=?,
                adapter=COALESCE(?,adapter), metadata=COALESCE(?,metadata) WHERE id=?""",
                (status, now(), output, error, adapter, json.dumps(metadata,ensure_ascii=False) if metadata is not None else None, run_id))
            db.execute('INSERT INTO run_events(run_id,kind,text,created_at) VALUES (?,?,?,?)',
                       (run_id, 'status', status, now()))

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

    def session(self, project, task, client, cwd, mode):
        if not task:
            return None
        with self.connect() as db:
            row = db.execute("SELECT session_id FROM client_sessions WHERE project=? AND task=? AND client=? AND cwd=? AND mode=?",
                (project,task,client,cwd,mode)).fetchone()
        return row[0] if row else None

    def save_session(self, project, task, client, cwd, mode, session_id):
        if task and session_id:
            with self.connect() as db:
                db.execute("INSERT OR REPLACE INTO client_sessions VALUES (?,?,?,?,?,?)", (project,task,client,cwd,mode,session_id))

    def forget_session(self, project, task, client, cwd, mode):
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

    def update_task(self, project, task, title=None, status=None):
        task = task.strip()
        title = title.strip() if title else task
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM runs WHERE project=? AND status='running'", (project,)).fetchone():
                raise FileExistsError("실행이 끝난 뒤 작업을 변경하세요.")
            if not db.execute("SELECT 1 FROM messages WHERE project=? AND task=?", (project,task)).fetchone():
                raise FileNotFoundError("작업을 찾을 수 없습니다.")
            old = db.execute("SELECT status FROM task_states WHERE project=? AND task=?", (project,task)).fetchone()
            if title != task:
                db.execute("UPDATE messages SET task=? WHERE project=? AND task=?", (title,project,task))
                db.execute("DELETE FROM client_sessions WHERE project=? AND task IN (?,?)", (project,task,title))
                db.execute("DELETE FROM task_states WHERE project=? AND task=?", (project,task))
            db.execute("INSERT OR REPLACE INTO task_states VALUES (?,?,?)", (project,title,status or (old[0] if old else 'active')))

    def set_task_status(self, project, task, status):
        # Notes can change the backlog status without modifying a live native session.
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO task_states VALUES (?,?,?)', (project,task,status))
