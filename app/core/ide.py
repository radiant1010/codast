"""Discover local IDE launchers and request a file open without a command shell."""
import os
from pathlib import Path
import shutil
import subprocess
import time


LABELS = {'vscode': 'VS Code', 'intellij': 'IntelliJ IDEA'}


def label(ide):
    if ide not in LABELS:
        raise ValueError('지원하지 않는 IDE입니다.')
    return LABELS[ide]


def executable(ide, value):
    label(ide)
    names = {'vscode': ('code.exe',), 'intellij': ('idea64.exe',)} if os.name == 'nt' else {
        'vscode': ('code',), 'intellij': ('idea', 'idea.sh')}
    path = Path(value)
    # Linux launchers such as /snap/bin/code depend on their symlink name.
    path = path.resolve() if os.name == 'nt' else path.absolute()
    name = path.name.lower() if os.name == 'nt' else path.name
    if name not in names[ide] or not path.is_file():
        raise ValueError(f'{label(ide)}의 실행 파일을 지정하세요.')
    return str(path)


def installations(folder, prefix, filename):
    try:
        with os.scandir(folder) as entries:
            return [Path(entry.path) / 'bin' / filename for entry in entries
                    if entry.name.startswith(prefix) and entry.is_dir()]
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        return []


def version(path):
    # Install folders look like "IntelliJ IDEA 2025.3.2" or "idea-IU-253.28294.334".
    for word in reversed(Path(path).parent.parent.name.replace('-', ' ').split()):
        parts = word.split('.')
        if len(parts) > 1 and all(part.isdigit() for part in parts):
            return tuple(map(int, parts))
    return ()


def discover(ide):
    label(ide)
    candidates = []
    if os.name == 'nt':
        found = shutil.which('code' if ide == 'vscode' else 'idea64.exe')
        if found:
            path = Path(found)
            candidates.append(path.parent.parent / 'Code.exe' if ide == 'vscode' and path.name.lower() == 'code.cmd' else path)
        local, programs = os.environ.get('LOCALAPPDATA'), os.environ.get('ProgramFiles')
        if ide == 'vscode':
            if local:
                candidates.append(Path(local) / 'Programs' / 'Microsoft VS Code' / 'Code.exe')
            if programs:
                candidates.append(Path(programs) / 'Microsoft VS Code' / 'Code.exe')
        else:
            if programs:
                candidates.extend(installations(Path(programs) / 'JetBrains', 'IntelliJ IDEA', 'idea64.exe'))
            if local:
                candidates.extend(installations(Path(local) / 'Programs', 'IntelliJ IDEA', 'idea64.exe'))
    else:
        for command in (('code',) if ide == 'vscode' else ('idea', 'idea.sh')):
            if found := shutil.which(command):
                candidates.append(Path(found))
        if ide == 'vscode':
            candidates.append(Path('/snap/bin/code'))
        else:
            candidates.extend(installations('/opt', 'idea', 'idea.sh'))
            scripts = Path.home() / '.local/share/JetBrains/Toolbox/scripts'
            candidates.extend(scripts / name for name in ('idea', 'idea.sh'))
    found = {}
    for candidate in candidates:
        try:
            path = executable(ide, candidate)
        except ValueError:
            continue
        found[Path(path)] = path
    paths = list(found.values())
    if ide == 'intellij':
        paths.sort(key=version, reverse=True)
    return paths


def status(storage, ide):
    name = label(ide)
    candidates = discover(ide)
    saved = storage.client_path(ide)
    path = None
    if saved:
        try:
            path = executable(ide, saved)
        except ValueError:
            if len(candidates) == 1:
                path = candidates[0]
                storage.save_client_path(ide, path)
    if path:
        state = 'configured'
    elif len(candidates) == 1:
        state, path = 'detected', candidates[0]
    else:
        state = 'multiple' if candidates else 'missing'
    return {'ide': ide, 'label': name, 'path': path, 'state': state, 'candidates': candidates}


def open_file(storage, ide, root, path, line=None, column=None):
    if not path.exists():
        raise FileNotFoundError('파일을 찾을 수 없습니다.')
    if not path.is_file():
        raise ValueError('IDE에서 열 파일을 선택하세요.')
    row = status(storage, ide)
    if row['state'] == 'missing':
        raise FileNotFoundError(f'{label(ide)} 실행 파일을 찾지 못했습니다. IDE 연결에서 경로를 지정하세요.')
    if row['state'] == 'multiple':
        raise ValueError('IDE 연결에서 실행 파일을 고르세요.')
    if row['state'] == 'detected':
        storage.save_client_path(ide, row['path'])
    args = [row['path'], str(root)]
    if ide == 'vscode':
        target = str(path)
        if line is not None:
            args.append('--goto')
            target += f':{line}'
            if column is not None:
                target += f':{column}'
        args.append(target)
    else:
        if line is not None:
            args.extend(['--line', str(line)])
        if column is not None:
            args.extend(['--column', str(column - 1)])
        args.append(str(path))
    env = os.environ.copy()
    env.pop('ELECTRON_RUN_AS_NODE', None)
    detached = {'creationflags': subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session': True}
    try:
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, env=env, **detached)
    except OSError as exc:
        raise ValueError('IDE를 실행하지 못했습니다. IDE 연결에서 실행 파일을 확인하세요.') from exc
    # ponytail: 5초 안의 종료만 관찰하며, 이후 결과 확인은 IDE별 통신 API가 필요하다.
    deadline = time.monotonic() + 5
    while True:
        code = process.poll()
        if code is not None:
            if code != 0:
                raise ValueError(f'IDE 실행에 실패했습니다(종료 코드 {code}). 앱에서 코드를 확인하세요.')
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(0.05, remaining))
    return {'state': 'requested'}
