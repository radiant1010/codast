"""Manage installed plugins through native CLIs; never edit their settings files."""
import asyncio
import hashlib
from itertools import islice
import json
import os
from pathlib import Path
import re
import shutil
from urllib.parse import urlsplit

from app.llm import cli


SELECTOR = r'^[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9][A-Za-z0-9._-]*)?$'


def matches_repository(source, repo):
    if not isinstance(source, str):
        return False
    source, repo = source.lower(), repo.lower()
    if source == repo:
        return True
    if source.startswith('git@github.com:'):
        source = 'ssh://git@github.com/' + source.partition(':')[2]
    try:
        url = urlsplit(source)
        transport = (url.scheme == 'https' and url.username is None and url.port in (None, 443) or
                     url.scheme == 'ssh' and url.username == 'git' and url.port in (None, 22))
        return (transport and url.hostname == 'github.com' and not url.password and not url.query and not url.fragment
                and url.path.rstrip('/').removesuffix('.git') == '/' + repo)
    except ValueError:
        return False


def metadata(folder):
    result = {'description': '', 'components': {key: [] for key in ('skills', 'agents', 'commands', 'mcp', 'hooks')}}
    if not folder or not isinstance(folder, str):
        return result
    root = Path(folder).resolve()

    def read(relative):
        path = (root/relative).resolve()
        if not path.is_relative_to(root):
            return {}
        try:
            with path.open(encoding='utf-8') as stream:
                value = stream.read(131073)
            data = json.loads(value) if len(value) <= 131072 else {}
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    for location in ('.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'plugin.json'):
        manifest = read(location)
        if manifest:
            if isinstance(manifest.get('description'), str):
                result['description'] = manifest['description'][:1500]
            break
    for kind, pattern in (('skills', 'skills/*/SKILL.md'), ('agents', 'agents/*.md'), ('commands', 'commands/*.md')):
        try:
            result['components'][kind] = sorted({(path.parent.name if kind == 'skills' else path.stem)[:120]
                for path in islice(root.glob(pattern), 100) if path.resolve().is_relative_to(root)})
        except OSError:
            pass
    servers = read('.mcp.json')
    servers = servers.get('mcpServers', servers)
    hooks = read('hooks/hooks.json').get('hooks', {})
    for kind, values in (('mcp', servers), ('hooks', hooks)):
        if isinstance(values, dict):
            result['components'][kind] = sorted(str(key)[:120] for key in list(values)[:100])
    return result


def normalize(client, data, cwd):
    rows = data.get('installed') if client == 'codex' and isinstance(data, dict) else data
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError('플러그인 목록 형식을 확인하지 못했습니다. CLI 버전과 연결을 확인하세요.')
    result = []
    for row in rows:
        identity = row.get('pluginId') if client == 'codex' else row.get('id')
        if not isinstance(identity, str) or not identity:
            raise ValueError('플러그인 식별자가 없는 목록입니다. CLI 연결을 확인하세요.')
        scope = 'cli' if client == 'codex' else row.get('scope', 'unknown')
        if scope in ('project', 'local') and row.get('projectPath') and Path(row['projectPath']).resolve() != cwd:
            continue
        enabled = row.get('enabled') if isinstance(row.get('enabled'), bool) else None
        supported = bool(re.fullmatch(SELECTOR, identity))
        editable = supported and (row.get('installPolicy') == 'AVAILABLE' if client == 'codex' else scope in ('user', 'project', 'local'))
        actions = {'enable': False, 'disable': False, 'update': False, 'remove': editable}
        reason = '' if editable else '관리 정책이나 설치 범위 때문에 이 화면에서 변경할 수 없습니다.'
        if client == 'claude' and editable:
            actions.update(enable=enabled is not None, disable=enabled is not None, update=True)
            if identity.endswith('@synced'):
                actions.update(update=False, remove=False)
                reason = '계정에서 동기화된 플러그인의 업데이트와 제거는 Claude에서 관리하세요.'
        if client == 'codex':
            reason = reason or '현재 Codex CLI는 개별 플러그인의 켜기/끄기와 업데이트 명령을 제공하지 않습니다.'
        source = row.get('source')
        folder = source.get('path') if client == 'codex' and isinstance(source, dict) else row.get('installPath')
        item = {'id': identity, 'name': str(row.get('name') or identity.split('@')[0])[:200],
                'version': str(row.get('version') or '확인 불가')[:100], 'scope': str(scope), 'enabled': enabled,
                'marketplace': str(row.get('marketplaceName') or identity.partition('@')[2])[:200],
                'actions': actions, 'reason': reason,
                'revision': hashlib.sha256(json.dumps([str(cwd), row], sort_keys=True).encode()).hexdigest()}
        item.update(metadata(folder))
        result.append(item)
    return result


class Plugins:
    def __init__(self):
        self.locks = {client: asyncio.Lock() for client in ('codex', 'claude')}

    async def run(self, path, args, cwd, timeout=25):
        try:
            code, output, _ = await cli.ProcessRunner().run([path, 'plugin', *args], cwd, timeout=timeout,
                env={**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GCM_INTERACTIVE': '0'})
        except (OSError, TimeoutError, RuntimeError) as exc:
            raise ValueError('플러그인 명령이 완료되지 않았습니다. 목록을 새로고침해 상태를 확인하세요.') from exc
        if code:
            raise ValueError('CLI가 플러그인 명령을 완료하지 못했습니다. 연결, 관리 정책, 의존 플러그인을 확인하세요. 추가 승인이 필요한 업데이트는 원래 CLI에서 진행하세요.')
        return output

    async def marketplaces(self, path, client, cwd):
        try:
            data = json.loads(await self.run(path, ['marketplace', 'list', '--json'], cwd))
            rows = data.get('marketplaces') if client == 'codex' and isinstance(data, dict) else data
            if not isinstance(rows, list) or any(not isinstance(row, dict) or not isinstance(row.get('name'), str) for row in rows):
                raise ValueError()
            return rows
        except ValueError as exc:
            raise ValueError('마켓플레이스 목록을 확인하지 못했습니다. CLI 버전과 연결을 확인하세요.') from exc

    async def verify_marketplace(self, row, repo, cwd):
        source = row.get('repo') if row.get('source') == 'github' else None
        if row.get('source') == 'git':
            source = row.get('url')
        declared = row.get('marketplaceSource')
        if isinstance(declared, dict):
            source = declared.get('source') if declared.get('sourceType') in ('git', 'github') else ''
        if source is None and row.get('root'):
            git = shutil.which('git')
            if git:
                try:
                    code, output, _ = await cli.ProcessRunner().run(
                        [git, '-C', row['root'], 'config', '--get', 'remote.origin.url'], cwd, timeout=10)
                    if code == 0:
                        source = output.strip()
                except (OSError, ValueError, RuntimeError, TimeoutError):
                    pass
        if not matches_repository(source, repo):
            raise ValueError('같은 이름의 마켓플레이스 출처가 기본 목록과 다르거나 확인되지 않습니다. 기존 설정은 유지했습니다. 원래 CLI에서 출처를 확인하세요.')

    async def install(self, path, client, cwd, specification):
        """Called under the provider lock, only with a repository-owned catalog entry."""
        identity, repo = specification['id'], specification['repo']
        if not re.fullmatch(SELECTOR, identity) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
            raise ValueError('기본 플러그인 목록의 설치 출처가 올바르지 않습니다.')
        action = 'add' if client == 'codex' else 'install'
        help_text = await self.run(path, [action, '--help'], cwd)
        required = ['--json'] + (['--scope'] if client == 'claude' else [])
        if any(flag not in help_text for flag in required):
            raise ValueError('이 CLI 버전은 자동 설치 명령을 지원하지 않습니다. CLI를 업데이트한 뒤 다시 시도하세요.')
        market = identity.split('@')[-1]
        rows = await self.marketplaces(path, client, cwd)
        matches = [row for row in rows if row['name'] == market]
        if not matches:
            flags = ['--json'] if client == 'codex' else ['--scope', 'user']
            help_text = await self.run(path, ['marketplace', 'add', '--help'], cwd)
            if flags[0] not in help_text:
                raise ValueError('이 CLI 버전은 마켓플레이스 자동 등록을 지원하지 않습니다.')
            await self.run(path, ['marketplace', 'add', f'https://github.com/{repo}.git', *flags], cwd, timeout=120)
            matches = [row for row in await self.marketplaces(path, client, cwd) if row['name'] == market]
        if len(matches) != 1:
            raise ValueError('마켓플레이스 등록 결과를 확인하지 못했습니다. 원래 CLI에서 확인하세요.')
        await self.verify_marketplace(matches[0], repo, cwd)
        args = [action, identity] + (['--scope', 'user'] if client == 'claude' else []) + ['--json']
        await self.run(path, args, cwd, timeout=180)

    async def inventory(self, client, path, cwd):
        output = await self.run(path, ['list', '--json'], cwd)
        try:
            data = json.loads(output)
        except ValueError as exc:
            raise ValueError('플러그인 목록을 읽지 못했습니다. CLI 버전과 연결을 확인하세요.') from exc
        return {'client': client, 'plugins': await asyncio.to_thread(normalize, client, data, cwd),
                'source': 'native_cli', 'note': '현재 프로젝트에서 CLI가 조회한 설치 상태입니다. 데스크톱 앱의 연결 목록과 다를 수 있습니다.'}

    async def read(self, client, configured, cwd):
        path = await asyncio.to_thread(cli.executable, client, configured)
        async with self.locks[client]:
            return await self.inventory(client, path, cwd)

    async def change(self, client, configured, cwd, body):
        from fastapi import HTTPException
        path = await asyncio.to_thread(cli.executable, client, configured)
        async with self.locks[client]:
            before = await self.inventory(client, path, cwd)
            matches = [row for row in before['plugins'] if row['id'] == body.id and row['scope'] == body.scope]
            if len(matches) != 1:
                raise FileNotFoundError('해당 설치 항목을 찾지 못했습니다. 목록을 새로고침하세요.')
            item = matches[0]
            if item['revision'] != body.revision:
                raise HTTPException(409, '플러그인 상태가 변경됐습니다. 새로고침 후 다시 선택하세요.')
            if not item['actions'][body.action]:
                raise PermissionError(item['reason'] or '이 플러그인은 해당 동작을 지원하지 않습니다.')
            action = ('uninstall' if client == 'claude' else 'remove') if body.action == 'remove' else body.action
            help_text = await self.run(path, [action, '--help'], cwd)
            flags = ['--json'] + (['--scope'] if client == 'claude' else [])
            if client == 'claude' and body.action == 'remove':
                flags.append('--keep-data')
            if any(flag not in help_text for flag in flags):
                raise ValueError('설치된 CLI에서 이 관리 동작을 지원하지 않습니다. CLI를 업데이트하거나 원래 관리 화면을 이용하세요.')
            args = [action, item['id']]
            if client == 'claude':
                args += ['--scope', item['scope']]
            args += ['--json']
            if client == 'claude' and body.action == 'remove':
                args.append('--keep-data')
            await self.run(path, args, cwd, timeout=90)
            try:
                after = await self.inventory(client, path, cwd)
            except ValueError as exc:
                raise HTTPException(409, '변경 명령은 끝났지만 상태를 다시 확인하지 못했습니다. 같은 동작을 반복하기 전에 새로고침하세요.') from exc
            current = next((row for row in after['plugins'] if row['id'] == item['id'] and row['scope'] == item['scope']), None)
            verified = (current is None if body.action == 'remove' else
                        current is not None and (body.action == 'update' or current['enabled'] is (body.action == 'enable')))
            if not verified:
                raise HTTPException(409, '요청한 상태가 확인되지 않았습니다. 다른 범위의 설정이나 관리 정책을 확인하고 새로고침하세요.')
            after['message'] = '현재 버전을 확인했습니다.' if body.action == 'update' and current['version'] == item['version'] else '변경된 설치 상태를 확인했습니다.'
            after['message'] += ' 실행 중인 작업은 유지되며, 다음 새 실행부터 적용됩니다.'
            return after
