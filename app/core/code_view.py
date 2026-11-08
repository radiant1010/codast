"""Read-only code browsing with an in-memory project file index."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import os
from pathlib import Path, PureWindowsPath
from queue import Queue
from threading import Event, Lock, Thread
from time import monotonic


IGNORED_DIRECTORIES = {'.git', '.harness', '.codast-documents', '.venv', 'node_modules', '__pycache__', '.pytest_cache'}
RESERVED_NAMES = {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1, 10)), *(f'LPT{i}' for i in range(1, 10))}
MAX_FILES = 100_000


def protected(name):
    name = name.lower()
    return name in {'.git', '.harness', '.codast-documents', '.env'} or name.startswith('.env.')


@dataclass
class FileIndex:
    root: Path
    finished_at: str | None
    files: list[str] = field(default_factory=list)
    truncated: bool = False
    created_at: float = 0
    ready: Event = field(default_factory=Event)
    refresh: bool = False
    next_root: Path | None = None
    error: Exception | None = None


class CodeView:
    def __init__(self, harness):
        self.harness = harness
        self.cache = {}
        self.scans = {}
        # ponytail: 전역 잠금으로 캐시 전환만 직렬화한다. 경합이 커지면 프로젝트별 잠금으로 나눈다.
        self.lock = Lock()

    def tree(self, name, relative=''):
        root = self.harness.projects.select(name)
        path = self.harness.policy.file_path(root, relative)
        if not path.exists():
            raise FileNotFoundError('폴더를 찾을 수 없습니다.')
        if not path.is_dir():
            raise ValueError('폴더 경로를 지정하세요.')
        entries = []
        with os.scandir(path) as children:
            for entry in children:
                # Match confined's name rules without checking every ancestor for each entry.
                if (protected(entry.name) or entry.name.endswith(('.', ' '))
                        or entry.name.partition('.')[0].upper() in RESERVED_NAMES
                        or any(char in entry.name for char in (':', '\\', '\0'))
                        or entry.is_symlink() or entry.is_junction()):
                    continue
                try:
                    kind = 'dir' if entry.is_dir(follow_symlinks=False) else 'file'
                    if kind == 'file' and not entry.is_file(follow_symlinks=False):
                        continue
                except (PermissionError, FileNotFoundError):
                    continue
                entries.append({'name': entry.name, 'type': kind})
                if len(entries) > 5000:
                    break
        truncated = len(entries) > 5000
        entries = sorted(entries[:5000], key=lambda item: (item['type'] != 'dir', item['name'].lower(), item['name']))
        if path == root:
            self._index(name, root)
        return {'path': path.relative_to(root).as_posix() if path != root else '',
                'entries': entries, 'truncated': truncated}

    def read(self, name, relative):
        root = self.harness.projects.select(name)
        path = self.harness.policy.file_path(root, relative)
        if path.is_dir():
            raise ValueError('파일 경로를 지정하세요.')
        with path.open('rb') as stream:
            data = stream.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise ValueError('파일이 커서 앱에서 볼 수 없습니다. IDE에서 열기를 사용하세요.')
        if b'\0' in data[:8192]:
            raise ValueError('바이너리 파일은 볼 수 없습니다.')
        for encoding in ('utf-8-sig' if data.startswith(b'\xef\xbb\xbf') else 'utf-8', 'cp949'):
            try:
                content = data.decode(encoding)
                return {'path': path.relative_to(root).as_posix(), 'content': content,
                        'encoding': encoding, 'size': len(data)}
            except UnicodeDecodeError:
                continue
        raise ValueError('파일 인코딩을 알 수 없습니다.')

    def resolve(self, name, ref):
        root = self.harness.projects.select(name)
        if not ref or len(ref) > 1024:
            raise ValueError('파일 참조는 1자 이상 1024자 이하로 입력하세요.')
        ref = ref.replace('\\', '/')
        if Path(ref).is_absolute() or PureWindowsPath(ref).is_absolute():
            try:
                relative = Path(ref).relative_to(root).as_posix()
            except ValueError:
                raise PermissionError('Workspace 밖에 접근할 수 없습니다.') from None
            path = self.harness.policy.file_path(root, relative)
            if path.is_file():
                return {'path': path.relative_to(root).as_posix()}
            raise FileNotFoundError('파일을 찾을 수 없습니다.')

        cwd = self.harness.settings(name).cwd
        references = [ref, ref[2:]] if ref.startswith(('a/', 'b/')) else [ref]
        for relative in references:
            for candidate in (f'{cwd}/{relative}', relative):
                path = self.harness.policy.file_path(root, candidate)
                if path.is_file():
                    return {'path': path.relative_to(root).as_posix()}

        suffix = os.path.normcase(references[-1]).replace('\\', '/')
        deadline, retried = monotonic() + 10, False
        while True:
            index = self._index(name, root)
            if not index.ready.wait(max(0, deadline - monotonic())):
                return {'pending': True}
            if index.error:
                raise index.error
            if index.root != root or index.finished_at != self.harness.storage.latest_run_finished_at(name):
                if monotonic() >= deadline:
                    return {'pending': True}
                continue
            matches = []
            for relative in index.files:
                normalized = os.path.normcase(relative).replace('\\', '/')
                if normalized != suffix and not normalized.endswith('/' + suffix):
                    continue
                parts = relative.split('/')
                matches.append((any(part.startswith('.') for part in parts[:-1]), len(parts), relative))
            candidates = []
            for _, _, relative in sorted(matches):
                try:
                    path = self.harness.policy.file_path(root, relative)
                    if path.is_file():
                        candidates.append(path.relative_to(root).as_posix())
                except (PermissionError, FileNotFoundError):
                    continue
                if len(candidates) > 50:
                    break
            if len(candidates) == 1:
                return {'path': candidates[0]}
            if candidates:
                return {'candidates': candidates[:50], 'truncated': index.truncated or len(candidates) > 50}
            if not retried and monotonic() - index.created_at > 10:
                self._index(name, root, force=True)
                retried = True
                continue
            raise FileNotFoundError('파일을 찾을 수 없습니다.')

    def refresh(self, name):
        root = self.harness.projects.select(name)
        self.harness.policy.file_path(root, '')
        self._index(name, root, force=True)
        return {'started': True}

    def _index(self, name, root, *, force=False):
        with self.lock:
            if name in self.scans:
                index = self.scans[name]
                index.refresh |= force or index.root != root
                index.next_root = root
                return index
            finished_at = self.harness.storage.latest_run_finished_at(name)
            index = self.cache.get(name)
            if not force and index and index.root == root and index.finished_at == finished_at:
                return index
            self.cache.pop(name, None)
            index = FileIndex(root, finished_at)
            self.scans[name] = index
            Thread(target=self._build, args=(name, index), daemon=True).start()
            return index

    def _build(self, name, index):
        try:
            while True:
                files, truncated = self._scan(index.root)
                with self.lock:
                    if index.refresh:
                        index.refresh = False
                        index.root = index.next_root or index.root
                        index.finished_at = self.harness.storage.latest_run_finished_at(name)
                        files.clear()
                        continue
                    index.files, index.truncated = files, truncated
                    index.created_at = monotonic()
                    if len(self.cache) >= 8:
                        self.cache.clear()
                    self.cache[name] = index
                    del self.scans[name]
                    index.ready.set()
                    return
        except Exception as exc:
            with self.lock:
                index.error = exc
                del self.scans[name]
                index.ready.set()

    def _scan(self, root):
        directories = Queue()
        directories.put((os.fspath(self.harness.policy.file_path(root, '')), ''))
        files, errors = [], []
        lock, stopped = Lock(), Event()
        truncated = False

        def worker():
            nonlocal truncated
            while True:
                task = directories.get()
                relative = ''
                try:
                    if task is None:
                        return
                    if stopped.is_set():
                        continue
                    directory, relative = task
                    with os.scandir(directory) as children:
                        for entry in children:
                            if stopped.is_set():
                                break
                            if protected(entry.name) or entry.is_symlink() or entry.is_junction():
                                continue
                            child = f'{relative}/{entry.name}' if relative else entry.name
                            if entry.is_dir(follow_symlinks=False):
                                if entry.name.lower() not in IGNORED_DIRECTORIES:
                                    directories.put((entry.path, child))
                            elif entry.is_file(follow_symlinks=False):
                                with lock:
                                    # ponytail: 파일 10만 개에서 멈춘다. 더 큰 프로젝트는 범위를 나눠 인덱싱한다.
                                    if len(files) >= MAX_FILES:
                                        truncated = True
                                        stopped.set()
                                    else:
                                        files.append(child)
                except OSError as exc:
                    with lock:
                        if relative == '':
                            errors.append(exc)
                            stopped.set()
                except Exception as exc:
                    with lock:
                        errors.append(exc)
                        stopped.set()
                finally:
                    directories.task_done()

        # ponytail: 스캔 스레드는 최대 8개다. 저장 장치별 실측에서 이득이 있을 때만 늘린다.
        workers = min(8, os.cpu_count() or 1)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for _ in range(workers):
                pool.submit(worker)
            directories.join()
            for _ in range(workers):
                directories.put(None)
        if errors:
            raise errors[0]
        return sorted(files), truncated
