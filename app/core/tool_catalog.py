"""Reconcile the shared development baseline without launching authentication."""
import asyncio
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil

from app.core.toolchain import Toolchain
from app.llm import cli
from app.llm.plugins import Plugins

CATALOG = json.loads((Path(__file__).resolve().parents[1] / 'defaults/tool-catalog.json').read_text(encoding='utf-8'))


@contextmanager
def installation_lock(root):
    path = root / '.local/toolchain.lock'
    if not path.resolve().is_relative_to(root):
        raise ValueError('도구 설치 경로가 CODAST 폴더 밖을 가리킵니다.')
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as stream:
        if stream.tell() == 0:
            stream.write(b'0')
            stream.flush()
        stream.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise FileExistsError('다른 요청에서 기본 도구를 설치 중입니다. 완료 후 새로고침하세요.') from exc
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == 'nt':
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def installed(tool, client, rows):
    available = {row['id']: row for row in rows if row['scope'] in ('user', 'cli', 'managed')}
    groups = tool['clients'][client]['reuse']
    found = max(([available[key] for key in group if key in available] for group in groups), key=len)
    complete = any(all(key in available for key in group) for group in groups)
    state = ('disabled' if any(row['enabled'] is False for row in found) else 'installed') if complete else 'partial' if found else 'missing'
    return {'state': state, 'versions': [row['version'] for row in found], 'ids': [row['id'] for row in found]}


class ToolCatalog:
    def __init__(self, plugins=None, chain=None):
        self.plugins = plugins or Plugins()
        self.chain = chain or Toolchain()
        self.lock = asyncio.Lock()

    async def read(self, paths):
        clients, inventories = {}, {}
        for client in ('codex', 'claude'):
            observed = await cli.probe(client, paths.get(client, ''))
            clients[client] = {key: observed[key] for key in ('state', 'auth') if key in observed}
            try:
                inventories[client] = (await self.plugins.read(client, paths.get(client, ''), self.chain.root))['plugins']
            except (OSError, ValueError):
                inventories[client] = None
        runtime = self.chain.status()['state']
        tools = []
        for item in CATALOG['tools']:
            row = {key: item[key] for key in ('id', 'name', 'default', 'kind', 'description', 'url')}
            row['clients'] = {}
            for client in clients:
                if item['kind'] == 'mcp':
                    status = {'state': 'configured' if runtime == 'ready' else runtime}
                elif inventories[client] is None:
                    status = {'state': 'unknown'}
                else:
                    status = installed(item, client, inventories[client])
                status['connection'] = 'not_verified' if item.get('account') or item['kind'] == 'mcp' else 'not_required'
                status['guide'] = item.get('guide') or item['clients'][client]['guide']
                row['clients'][client] = status
            tools.append(row)
        return {'catalog_version': CATALOG['version'], 'clients': clients, 'tools': tools,
                'installing': self.lock.locked(), 'execution': 'not_verified'}

    async def install_plugins(self, paths):
        errors = []
        for client in ('codex', 'claude'):
            try:
                path = await asyncio.to_thread(cli.executable, client, paths.get(client, ''))
                async with self.plugins.locks[client]:
                    rows = (await self.plugins.inventory(client, path, self.chain.root))['plugins']
                    for item in CATALOG['tools']:
                        if not item.get('install') or not item['default']:
                            continue
                        if installed(item, client, rows)['state'] != 'missing':
                            continue
                        try:
                            await self.plugins.install(path, client, self.chain.root, item['install'])
                            rows = (await self.plugins.inventory(client, path, self.chain.root))['plugins']
                            if installed(item, client, rows)['state'] == 'missing':
                                raise ValueError('설치 명령 후 등록을 확인하지 못했습니다. 새로고침 후 다시 확인하세요.')
                        except (OSError, ValueError) as exc:
                            errors.append({'client': client, 'tool': item['id'], 'message': str(exc)})
            except (OSError, ValueError):
                errors.append({'client': client, 'tool': 'plugins', 'message': 'CLI 설치와 플러그인 목록을 확인하지 못했습니다. 에이전트 연결 설정을 확인하세요.'})
        return errors

    async def initialize(self, paths, uv=None):
        if self.lock.locked():
            raise FileExistsError('기본 도구 설치가 진행 중입니다. 잠시 후 새로고침하세요.')
        async with self.lock:
            with installation_lock(self.chain.root):
                return await self._initialize(paths, uv)

    async def _initialize(self, paths, uv):
        errors = []
        try:
            if uv is None:
                local_uv = self.chain.local / 'uv' / ('uv.exe' if os.name == 'nt' else 'uv')
                uv = str(local_uv) if local_uv.is_file() else shutil.which('uv')
            if not uv:
                raise ValueError('uv를 찾지 못했습니다. 터미널에서 codast init을 실행하세요.')
            await self.chain.initialize(uv)
        except (OSError, ValueError) as exc:
            errors.append({'client': 'shared', 'tool': 'mcp', 'message': str(exc)})
        errors.extend(await self.install_plugins(paths))
        result = await self.read(paths)
        result.update(installing=False, errors=errors)
        return result
