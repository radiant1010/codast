"""Rebuildable local conversation index. No model turns or transcript writes."""
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
from threading import Event, Lock

from app.core import claude_threads, native_threads
from app.core.storage import now


def digest(value):
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


class SessionSearch:
    def __init__(self, storage):
        self.storage = storage
        self.path = storage.path.with_name(storage.path.stem+'-session-search.sqlite3')
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='session-search')
        self.lock = Lock()
        self.closed = Event()
        self.states = {}
        with self.connect() as db:
            if db.execute('PRAGMA user_version').fetchone()[0] == 0:
                db.executescript('DROP TABLE IF EXISTS entries; DROP TABLE IF EXISTS sessions;')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS sessions (
                    key TEXT PRIMARY KEY, project TEXT, root TEXT, source TEXT, identity TEXT,
                    title TEXT, updated TEXT, fingerprint TEXT, indexed_at TEXT);
                CREATE INDEX IF NOT EXISTS session_scope ON sessions(project,root,source);
                CREATE TABLE IF NOT EXISTS entries (
                    id INTEGER PRIMARY KEY, key TEXT UNIQUE, session_key TEXT, ordinal INTEGER,
                    message_id TEXT, role TEXT, body TEXT);
                CREATE INDEX IF NOT EXISTS entry_session ON entries(session_key,ordinal);
                CREATE VIRTUAL TABLE IF NOT EXISTS entry_text USING fts5(
                    body, content='entries', content_rowid='id', tokenize='trigram');
                CREATE TRIGGER IF NOT EXISTS entry_insert AFTER INSERT ON entries BEGIN
                    INSERT INTO entry_text(rowid,body) VALUES (new.id,new.body);
                END;
                CREATE TRIGGER IF NOT EXISTS entry_delete AFTER DELETE ON entries BEGIN
                    INSERT INTO entry_text(entry_text,rowid,body) VALUES ('delete',old.id,old.body);
                END;
                PRAGMA user_version=1;
            ''')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def close(self):
        self.closed.set()
        self.executor.shutdown(wait=True, cancel_futures=True)

    def status(self, project, root):
        scope = (project, str(Path(root).resolve()))
        with self.lock:
            state = self.states.get(scope, {'indexing': False, 'errors': []}).copy()
        with self.connect() as db:
            row = db.execute('SELECT COUNT(*) AS sessions, MAX(indexed_at) AS updated_at FROM sessions '
                             'WHERE project=? AND root=?', scope).fetchone()
        return {**state, **dict(row)}

    def refresh(self, project, root):
        scope = (project, str(Path(root).resolve()))
        with self.lock:
            if not self.states.get(scope, {}).get('indexing'):
                self.states[scope] = {'indexing': True, 'errors': []}
                self.executor.submit(self.rebuild, project, root)
        return self.status(project, root)

    def rebuild(self, project, root):
        root = Path(root).resolve()
        scope = (project, str(root))
        errors = []
        with self.lock:
            self.states[scope] = {'indexing': True, 'errors': []}
        try:
            for source, collect in [('codast', self.local), ('codex', self.codex), ('claude', self.claude)]:
                if self.closed.is_set():
                    break
                seen = set()
                try:
                    for identity, fingerprint, read in collect(project, root):
                        if self.closed.is_set():
                            return
                        key = digest([*scope, source, identity])
                        seen.add(key)
                        with self.connect() as db:
                            old = db.execute('SELECT fingerprint FROM sessions WHERE key=?', (key,)).fetchone()
                        if fingerprint and old and old['fingerprint'] == fingerprint:
                            continue
                        try:
                            thread = read()
                            if thread is None:
                                self.remove(key)
                            else:
                                self.replace(project, root, source, identity, key, fingerprint, thread)
                        except (FileNotFoundError, PermissionError):
                            self.remove(key)
                            errors.append({'source': source, 'message': '일부 세션이 삭제되었거나 프로젝트 경로가 달라 제외했습니다.'})
                        except native_threads.ResponseLimitError as exc:
                            errors.append({'source': source, 'message': str(exc)})
                        except Exception:
                            errors.append({'source': source, 'message': '일부 세션을 읽지 못했습니다. 기존 색인이 있으면 유지합니다.'})
                    with self.connect() as db:
                        old_keys = [r[0] for r in db.execute('SELECT key FROM sessions WHERE project=? AND root=? AND source=?', (*scope, source))]
                    for key in set(old_keys)-seen:
                        self.remove(key)
                except Exception:
                    errors.append({'source': source, 'message': '기록 조회에 실패했습니다. 설치, 연결 상태와 로컬 기록 접근 권한을 확인하세요. 기존 색인이 있으면 유지합니다.'})
        finally:
            unique_errors = []
            for error in errors:
                if error not in unique_errors:
                    unique_errors.append(error)
            with self.lock:
                self.states[scope] = {'indexing': False, 'errors': unique_errors}

    def remove(self, key):
        with self.connect() as db:
            db.execute('DELETE FROM entries WHERE session_key=?', (key,))
            db.execute('DELETE FROM sessions WHERE key=?', (key,))

    def replace(self, project, root, source, identity, key, fingerprint, thread):
        messages = [m for m in thread.get('messages', []) if m['role'] in ('user', 'assistant') and m['text']]
        fingerprint = fingerprint or digest(thread)
        title = (thread.get('name') or thread.get('preview') or '이름 없는 세션')[:200]
        updated = thread.get('updatedAt') or ''
        if isinstance(updated, (int, float)):
            updated = datetime.fromtimestamp(updated, timezone.utc).isoformat()
        with self.connect() as db:
            db.execute('DELETE FROM entries WHERE session_key=?', (key,))
            db.execute('INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?,?,?,?,?)',
                       (key, project, str(root), source, identity, title, updated, fingerprint, now()))
            db.executemany('INSERT INTO entries(key,session_key,ordinal,message_id,role,body) VALUES (?,?,?,?,?,?)',
                           [(digest([key, fingerprint, i]), key, i, m.get('message_id'), m['role'], m['text'])
                            for i, m in enumerate(messages)])

    def local(self, project, root):
        with self.storage.connect() as db:
            rows = db.execute('''SELECT m.*,r.output FROM messages m LEFT JOIN runs r ON r.id=m.run_id
                                 WHERE m.project=? ORDER BY m.created_at,m.id''', (project,)).fetchall()
        groups = defaultdict(list)
        for row in rows:
            groups[row['chat_id'] or row['task']].append(dict(row))
        for identity, rows in groups.items():
            messages = []
            for row in rows:
                messages.append({'role': 'user', 'text': row['text'], 'message_id': row['id']})
                if row['output']:
                    messages.append({'role': 'assistant', 'text': row['output'], 'message_id': row['id']})
            thread = {'name': rows[-1]['task'] or '미분류', 'updatedAt': rows[-1]['created_at'], 'messages': messages}
            yield identity, digest(thread), lambda thread=thread: thread

    def codex(self, project, root):
        configured = self.storage.client_path('codex')
        identities = set()
        for archived in (False, True):
            cursor = None
            cursors = set()
            while True:
                page = native_threads.list_threads(root, configured, cursor, archived=archived)
                for thread in page['threads']:
                    identity = thread['id']
                    if identity in identities:
                        continue
                    identities.add(identity)
                    updated = thread.get('updatedAt')
                    fingerprint = digest([updated, thread.get('name'), thread.get('preview')]) if updated else None
                    # Codex timestamps have second precision; re-read recently changing sessions.
                    if isinstance(updated, (int, float)) and updated > datetime.now(timezone.utc).timestamp()-30:
                        fingerprint = None
                    yield identity, fingerprint, lambda identity=identity: native_threads.read_thread(root, identity, configured, full=True)
                cursor = page.get('next_cursor')
                if not cursor:
                    break
                if cursor in cursors:
                    raise ValueError('Codex 세션 목록을 끝까지 읽지 못했습니다.')
                cursors.add(cursor)

    def claude(self, project, root):
        for path in claude_threads.candidates(limit=None):
            stat = path.stat()
            yield path.stem, digest([str(path), stat.st_mtime_ns, stat.st_size]), lambda path=path: claude_threads.read_file(path, root, full=True)

    def search(self, project, root, query, offset=0, limit=40):
        terms = list(dict.fromkeys(query.lower().split()))
        status = self.status(project, root)
        if not terms:
            return {'results': [], 'has_more': False, 'status': status}
        where = ['s.project=?', 's.root=?']
        args = [project, str(Path(root).resolve())]
        long_terms = [term for term in terms if len(term) >= 3]
        if long_terms:
            where.append('e.id IN (SELECT rowid FROM entry_text WHERE entry_text MATCH ?)')
            args.append(' AND '.join('"'+term.replace('"', '""')+'"' for term in long_terms))
        # Two-character Korean words use a literal scan of the local cache, never the original logs.
        for term in terms:
            where.append('instr(lower(e.body),?)>0')
            args.append(term)
        with self.connect() as db:
            rows = db.execute('SELECT e.*,s.source,s.identity,s.title,s.updated FROM entries e '
                              'JOIN sessions s ON s.key=e.session_key WHERE '+' AND '.join(where)+
                              ' ORDER BY s.updated DESC,s.key,e.ordinal LIMIT ? OFFSET ?', (*args, limit+1, offset)).fetchall()
        results = []
        for row in rows[:limit]:
            result = dict(row)
            body = result.pop('body')
            position = min(body.lower().find(term) for term in terms)
            start = max(0, position-60)
            result['snippet'] = ('…' if start else '')+body[start:start+240]+('…' if len(body)>start+240 else '')
            results.append(result)
        return {'results': results, 'has_more': len(rows)>limit, 'status': status}

    def context(self, project, root, key, offset=None):
        with self.connect() as db:
            db.execute('BEGIN')
            hit = db.execute('SELECT e.*,s.source,s.identity,s.title FROM entries e JOIN sessions s ON s.key=e.session_key '
                             'WHERE e.key=? AND s.project=? AND s.root=?', (key, project, str(Path(root).resolve()))).fetchone()
            if not hit:
                raise FileNotFoundError('검색 기록이 변경되었습니다. 다시 검색하세요.')
            start = max(0, int(hit['ordinal'])//20*20) if offset is None else offset
            rows = db.execute('SELECT ordinal,role,body AS text FROM entries WHERE session_key=? ORDER BY ordinal LIMIT 21 OFFSET ?',
                              (hit['session_key'], start)).fetchall()
        destination = None
        if hit['source'] == 'codast':
            with self.storage.connect() as db:
                message = db.execute('SELECT * FROM messages WHERE project=? AND id=?', (project, hit['message_id'])).fetchone()
                if not message:
                    raise FileNotFoundError('원본 메시지가 삭제되었습니다. 기록을 다시 읽어 주세요.')
                rank = db.execute('SELECT COUNT(*) FROM messages WHERE project=? AND chat_id=? '
                                  'AND (created_at>? OR (created_at=? AND id>?))',
                                  (project, message['chat_id'], message['created_at'], message['created_at'], message['id'])).fetchone()[0]
                destination = {'task': message['task'], 'chat_id': message['chat_id'], 'message_id': message['id'], 'offset': rank//20*20}
        return {'source': hit['source'], 'identity': hit['identity'], 'title': hit['title'],
                'ordinal': hit['ordinal'], 'messages': [dict(row) for row in rows[:20]],
                'offset': start, 'has_more': len(rows)>20, 'destination': destination}
