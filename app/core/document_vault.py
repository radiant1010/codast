"""Local document history: immutable objects, one atomic catalog, no database dependency."""
from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import re
from threading import RLock
from uuid import uuid4

from app.guards.filesystem import confined


LOCK = RLock()
MAX_FILE = 2 * 1024 * 1024
MAX_TEXT = 200_000
MAX_DOCUMENTS = 100
MAX_REVIEWS = 100


def now():
    return datetime.now(timezone.utc).isoformat()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def checked_path(value):
    path = Path(value)
    if not path.is_absolute() or path == Path(path.anchor):
        raise ValueError('드라이브 전체가 아닌 폴더의 전체 경로를 입력하세요.')
    for part in (path, *path.parents):
        if part.is_symlink() or part.is_junction():
            raise PermissionError('링크 폴더는 문서함으로 사용할 수 없습니다.')
    if any(p.lower() in ('.git', '.codex', '.claude') for p in path.parts):
        raise PermissionError('인증 또는 Git 내부 폴더는 사용할 수 없습니다.')
    return path.resolve()


def read_json(path):
    try:
        if path.stat().st_size > MAX_FILE:
            raise ValueError('문서함 파일 크기 한도를 초과했습니다.')
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f'문서함 파일이 없거나 손상되었습니다: {path.name}. 백업을 확인하세요.') from exc


def atomic_write(path, value):
    """Publish a complete file; a pre-replace failure leaves the previous file intact."""
    data = encoded(value)
    if len(data) > MAX_FILE:
        raise ValueError('문서함 파일 크기 한도를 초과했습니다.')
    tmp = path.with_name('.pending-' + uuid4().hex)
    try:
        with tmp.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    except OSError as exc:
        raise ValueError('문서함 저장에 실패했습니다. 저장 공간과 권한을 확인한 뒤 문서함을 다시 읽으세요.') from exc
    finally:
        tmp.unlink(missing_ok=True)


@contextmanager
def vault_lock(root):
    # Kernel locks are released on process exit. The lock file is never deleted.
    path = confined(root, '.lock')
    with path.open('a+b') as stream:
        if path.stat().st_size == 0:
            stream.write(b'0')
            stream.flush()
        stream.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise FileExistsError('다른 작업이 문서함을 사용 중입니다. 잠시 후 다시 시도하세요.') from exc
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == 'nt':
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


class DocumentVault:
    def __init__(self, projects):
        self.projects = projects

    def binding_path(self, name):
        return confined(self.projects.entry(name), '.harness/document-vault.json')

    def binding(self, name):
        path = self.binding_path(name)
        if not path.exists():
            return None
        value = read_json(path)
        if not isinstance(value, dict) or not isinstance(value.get('path'), str) or not isinstance(value.get('vault_id'), str) or not isinstance(value.get('connection_id'), str):
            raise ValueError('문서함 연결 정보가 손상되었습니다.')
        return value

    def settings(self, name):
        with LOCK:
            binding = self.binding(name)
            suggested = str(self.projects.entry(name) / '.harness' / '.codast-documents')
            return {'binding': binding, 'suggested_path': suggested,
                    'suggested_base_path': str(self.projects.root / '.harness' / 'artifacts')}

    def catalog(self, root):
        value = read_json(confined(root, 'catalog.json'))
        if not isinstance(value, dict) or value.get('schema') != 1 or not re.fullmatch(r'[a-f0-9]{32}', str(value.get('vault_id', ''))):
            raise ValueError('지원하지 않거나 손상된 문서함입니다.')
        workflows = value.get('workflows', {})
        if not isinstance(workflows, dict) or len(workflows) > 100 or any(not re.fullmatch(r'CDS-WF-[a-f0-9]{32}', key) for key in workflows):
            raise ValueError('워크플로 목록이 손상되었습니다.')
        docs = value.get('documents')
        if not isinstance(docs, dict) or len(docs) > MAX_DOCUMENTS or any(not re.fullmatch(r'CDS-DOC-\d{3,}', key) for key in docs):
            raise ValueError('문서 목록이 손상되었습니다.')
        if type(value.get('next_number')) is not int or value['next_number'] < 1:
            raise ValueError('문서 번호 정보가 손상되었습니다.')
        if docs and value['next_number'] <= max(int(key.rsplit('-', 1)[1]) for key in docs):
            raise ValueError('문서 번호가 기존 번호와 충돌합니다.')
        return value

    def connect(self, name, path, mode, expected_connection_id, layout='direct'):
        with LOCK:
            previous = self.binding(name)
            if (previous or {}).get('connection_id') != expected_connection_id:
                raise FileExistsError('문서함 연결이 바뀌었습니다. 새로고침 후 다시 선택하세요.')
            base = checked_path(path)
            grouped = layout == 'project' and not (mode == 'connect' and base.name == '.codast-documents')
            root = checked_path(base / name / '.codast-documents') if grouped else base
            exports = checked_path(base / name / 'exports') if grouped else None
            if exports and exports.exists() and not exports.is_dir():
                raise ValueError('exports 위치에 파일이 있습니다. 다른 보관함을 선택하세요.')
            if root.name != '.codast-documents':
                raise ValueError('전용 하위 폴더 .codast-documents를 저장 위치로 지정하세요.')
            for other in self.projects.list() + self.projects.list(deleted=True):
                descriptor = confined(self.projects.entry(other, include_deleted=True), '.harness/document-vault.json')
                if other != name and descriptor.exists() and read_json(descriptor).get('path') == str(root):
                    raise FileExistsError('다른 프로젝트에 연결된 문서함입니다.')
            if mode == 'create':
                if root.exists():
                    raise FileExistsError('이미 있는 폴더입니다. 기존 문서함 연결을 선택하세요.')
                root.mkdir(parents=True)
                with vault_lock(root):
                    catalog = {'schema': 1, 'vault_id': uuid4().hex, 'created_at': now(), 'next_number': 1, 'documents': {}}
                    confined(root, 'objects').mkdir()
                    atomic_write(confined(root, 'catalog.json'), catalog)
            elif mode == 'connect':
                if not root.is_dir():
                    raise FileNotFoundError('기존 문서함 폴더를 찾을 수 없습니다.')
                with vault_lock(root):
                    catalog = self.catalog(root)
                    self.inspect(root, catalog)  # Reject damaged references before changing the binding.
            else:
                raise ValueError('문서함 생성 또는 연결을 선택하세요.')
            if exports:
                exports.mkdir(parents=True, exist_ok=True)
            binding = {'path': str(root), 'vault_id': catalog['vault_id'], 'connection_id': uuid4().hex}
            if grouped:
                binding.update(base_path=str(base), project_path=str(root.parent), exports_path=str(exports))
            dest = self.binding_path(name)
            dest.parent.mkdir(exist_ok=True)
            atomic_write(dest, binding)
            return {'binding': binding, 'suggested_path': str(root)}

    @contextmanager
    def opened(self, name, connection_id):
        with LOCK:
            binding = self.binding(name)
            if not binding:
                raise ValueError('먼저 산출물 저장 위치를 설정하세요.')
            if binding['connection_id'] != connection_id:
                raise FileExistsError('문서함 연결이 바뀌었습니다. 새로고침하세요.')
            root = checked_path(binding['path'])
            if not root.is_dir():
                raise FileNotFoundError('문서함을 찾을 수 없습니다. 저장 위치를 확인하세요.')
            with vault_lock(root):
                catalog = self.catalog(root)
                if catalog['vault_id'] != binding['vault_id']:
                    raise FileExistsError('연결한 문서함과 실제 폴더가 다릅니다.')
                yield root, catalog

    def put_object(self, root, value):
        digest = sha256(encoded(value)).hexdigest()
        path = confined(root, f'objects/{digest}.json')
        if path.exists():
            self.get_object(root, digest)
        else:
            atomic_write(path, value)
        return digest

    def get_object(self, root, digest):
        if not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise ValueError('문서함 참조가 손상되었습니다.')
        value = read_json(confined(root, f'objects/{digest}.json'))
        if sha256(encoded(value)).hexdigest() != digest:
            raise ValueError('문서함 내용 검증에 실패했습니다. 백업을 확인하세요.')
        return value

    def workflow(self, root, digest):
        state = self.get_object(root, digest)
        def payload(refs):
            if not isinstance(refs, list) or not refs or len(refs) > 4096:
                raise ValueError('워크플로 상세 참조가 손상되었습니다.')
            try:
                value = json.loads(''.join(self.get_object(root, ref)['text'] for ref in refs))
                if not isinstance(value, dict):
                    raise ValueError('워크플로 상세 내용이 손상되었습니다.')
                return value
            except (KeyError, TypeError, json.JSONDecodeError) as exc:
                raise ValueError('워크플로 상세 내용이 손상되었습니다.') from exc
        if 'source_refs' in state:
            state['source'] = payload(state.pop('source_refs'))
        for step in state['steps']:
            for index, attempt in enumerate(step['attempts']):
                if 'payload_refs' in attempt:
                    value = payload(attempt['payload_refs'])
                    if value.get('run_id') != attempt['run_id'] or value.get('version') != attempt['version']:
                        raise ValueError('워크플로 실행 참조가 일치하지 않습니다.')
                    step['attempts'][index] = value
                step['attempts'][index].setdefault('storage_status', 'pending' if step['attempts'][index].get('status') == 'running' else 'saved')
        return state

    def document(self, root, catalog, identity):
        if identity not in catalog['documents']:
            raise FileNotFoundError('문서를 찾을 수 없습니다.')
        state = self.get_object(root, catalog['documents'][identity])
        try:
            assert state['id'] == identity and type(state['revision']) is int and state['revision'] >= 1
            assert isinstance(state['title'], str) and isinstance(state['content'], str)
            assert isinstance(state['reviews'], list) and len(state['reviews']) <= MAX_REVIEWS
            assert isinstance(state['history'], list) and isinstance(state['updated_at'], str)
            assert state['pending'] is None or 1 <= state['pending'] <= len(state['reviews'])
            assert state['approved'] is None or 1 <= state['approved'] <= len(state['reviews'])
            for number, review in enumerate(state['reviews'], 1):
                assert review['number'] == number and review['decision'] in ('pending', 'approved', 'rejected')
                assert isinstance(review['reason'], str) and isinstance(review['submitted_at'], str)
                assert re.fullmatch(r'[a-f0-9]{64}', review['snapshot'])
                assert review['base'] is None or type(review['base']) is int and 1 <= review['base'] < number
                assert isinstance(review['comment'], str)
                assert review['decided_at'] is None or isinstance(review['decided_at'], str)
            assert [r['number'] for r in state['reviews'] if r['decision'] == 'pending'] == ([state['pending']] if state['pending'] else [])
            if state['pending']:
                assert state['reviews'][state['pending'] - 1]['decision'] == 'pending'
            if state['approved']:
                assert state['reviews'][state['approved'] - 1]['decision'] == 'approved'
        except (AssertionError, KeyError, TypeError, IndexError) as exc:
            raise ValueError('문서 상태가 손상되었습니다.') from exc
        return state

    def snapshot(self, root, review):
        value = self.get_object(root, review['snapshot'])
        if not isinstance(value, dict) or not isinstance(value.get('title'), str) or not isinstance(value.get('content'), str):
            raise ValueError('문서 보존본이 손상되었습니다.')
        return value

    def inspect(self, root, catalog):
        states = []
        for identity in catalog['documents']:
            state = self.document(root, catalog, identity)
            for review in state['reviews']:
                self.snapshot(root, review)
            states.append(state)
        for digest in catalog.get('workflows', {}).values():
            self.workflow(root, digest)
        return states

    @staticmethod
    def summary(state):
        return {key: state[key] for key in ('id', 'title', 'revision', 'pending', 'approved', 'updated_at')}

    def list(self, name, connection_id):
        with self.opened(name, connection_id) as (root, catalog):
            rows, issues = [], []
            for identity in catalog['documents']:
                try:
                    state = self.document(root, catalog, identity)
                    for review in state['reviews']:
                        self.snapshot(root, review)
                    rows.append(self.summary(state))
                except (ValueError, PermissionError) as exc:
                    issues.append({'id': identity, 'message': str(exc)})
            return {'documents': rows, 'issues': issues, 'vault_id': catalog['vault_id']}

    def read(self, name, connection_id, identity):
        with self.opened(name, connection_id) as (root, catalog):
            state = self.document(root, catalog, identity)
            for review in state['reviews']:
                self.snapshot(root, review)
            return state

    def read_review(self, name, connection_id, identity, number):
        with self.opened(name, connection_id) as (root, catalog):
            state = self.document(root, catalog, identity)
            if number < 1 or number > len(state['reviews']):
                raise FileNotFoundError('검토 버전을 찾을 수 없습니다.')
            review = state['reviews'][number - 1]
            before = {'title': '', 'content': ''}
            if review['base']:
                before = self.snapshot(root, state['reviews'][review['base'] - 1])
            return {'review': review, 'before': before, 'after': self.snapshot(root, review)}

    def publish(self, root, catalog, state, action):
        state['updated_at'] = now()
        state['history'].append({'action': action, 'revision': state['revision'], 'at': state['updated_at'], 'actor': 'local-user'})
        catalog['documents'][state['id']] = self.put_object(root, state)
        # Only this atomic replacement commits the operation. Unreferenced objects are not history.
        atomic_write(confined(root, 'catalog.json'), catalog)

    @staticmethod
    def validate_text(title, content):
        if not title.strip() or len(title) > 120 or len(content) > MAX_TEXT:
            raise ValueError('제목은 1~120자, 본문은 200,000자 이하로 입력하세요.')

    def create(self, name, connection_id, title, content):
        self.validate_text(title, content)
        with self.opened(name, connection_id) as (root, catalog):
            if len(catalog['documents']) >= MAX_DOCUMENTS:
                raise ValueError('첫 버전은 문서함당 문서 100개까지 지원합니다.')
            identity = f"CDS-DOC-{catalog['next_number']:03d}"
            catalog['next_number'] += 1
            state = {'id': identity, 'title': title.strip(), 'content': content, 'revision': 1,
                     'approved': None, 'pending': None, 'reviews': [], 'history': []}
            self.publish(root, catalog, state, 'created')
            return state

    def change(self, name, connection_id, identity, expected_revision, action, **values):
        with self.opened(name, connection_id) as (root, catalog):
            state = self.document(root, catalog, identity)
            for review in state['reviews']:
                self.snapshot(root, review)
            if state['revision'] != expected_revision:
                raise FileExistsError('다른 화면에서 문서가 변경되었습니다. 다시 불러온 후 검토하세요.')
            if action == 'saved':
                if state['pending']:
                    raise FileExistsError('검토 중인 버전은 수정할 수 없습니다. 먼저 승인하거나 반려하세요.')
                self.validate_text(values['title'], values['content'])
                if (state['title'], state['content']) == (values['title'].strip(), values['content']):
                    return state
                state.update(title=values['title'].strip(), content=values['content'])
            elif action == 'submitted':
                if state['pending']:
                    raise FileExistsError('이미 검토 중입니다.')
                if not values['reason'].strip():
                    raise ValueError('변경 이유를 입력하세요.')
                if len(state['reviews']) >= MAX_REVIEWS:
                    raise ValueError('첫 버전은 문서당 검토 버전 100개까지 지원합니다.')
                number = len(state['reviews']) + 1
                snapshot = {'title': state['title'], 'content': state['content']}
                if state['approved'] and snapshot == self.snapshot(root, state['reviews'][state['approved'] - 1]):
                    raise ValueError('승인본과 동일합니다. 문서를 수정한 후 검토를 요청하세요.')
                state['reviews'].append({'number': number, 'snapshot': self.put_object(root, snapshot),
                                         'base': state['approved'], 'reason': values['reason'].strip(),
                                         'submitted_at': now(), 'decision': 'pending', 'comment': '', 'decided_at': None})
                state['pending'] = number
            elif action in ('approved', 'rejected'):
                if state['pending'] != values['number']:
                    raise FileExistsError('현재 검토 중인 버전이 아닙니다. 다시 불러오세요.')
                if not values['comment'].strip():
                    raise ValueError('검토 결과를 입력하세요.')
                review = state['reviews'][state['pending'] - 1]
                review.update(decision=action, comment=values['comment'].strip(), decided_at=now(), reviewer='local-user')
                if action == 'approved':
                    state['approved'] = state['pending']
                state['pending'] = None
            else:
                raise ValueError('지원하지 않는 문서 작업입니다.')
            state['revision'] += 1
            self.publish(root, catalog, state, action)
            return state
