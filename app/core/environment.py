"""Project-scoped, read-only Git and Docker observations."""
import asyncio
import json
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from app.llm.cli import ProcessRunner


class EnvironmentStatus:
    def __init__(self, runner=None):
        self.runner = runner or ProcessRunner()
        self.cache = {}
        self.lock = asyncio.Lock()

    async def read(self, root):
        root = Path(root).resolve()
        async with self.lock:
            cached = self.cache.get(str(root))
            if cached and cached[0] > time.monotonic():
                return cached[1]
            git, docker = await asyncio.gather(self.git(root), self.docker(root))
            result = {'git': git, 'docker': docker, 'checked_at': datetime.now(timezone.utc).isoformat(),
                      'ports': {'source': 'project Docker published ports', 'host_state': 'not_collected',
                                'state': docker['state'], 'values': docker.get('ports', [])}}
            if len(self.cache) >= 64:
                self.cache.clear()
            self.cache[str(root)] = (time.monotonic() + 15, result)
            return result

    async def git(self, root):
        tool = shutil.which('git')
        if not tool:
            return {'state': 'not_installed'}
        try:
            code, out, err = await self.runner.run([tool, '--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal', '--', '.'], str(root), timeout=8)
            if code:
                return {'state': 'not_repository' if 'not a git repository' in err.lower() else 'error'}
            lines = out.splitlines()
            branch = next((line.removeprefix('# branch.head ') for line in lines if line.startswith('# branch.head ')), None)
            return {'state': 'available', 'branch': branch, 'changed_entries': sum(line.startswith(('1 ', '2 ', 'u ', '? ')) for line in lines)}
        except (OSError, ValueError, RuntimeError, TimeoutError):
            return {'state': 'error'}

    async def docker(self, root):
        tool = shutil.which('docker')
        if not tool:
            return {'state': 'not_installed'}
        try:
            # The exact Compose working-directory label is our association evidence.
            code, out, _ = await self.runner.run([tool, 'ps', '-a', '--filter',
                'label=com.docker.compose.project.working_dir=' + str(root), '--format', '{{json .}}'], str(root), timeout=8)
            if code:
                return {'state': 'unavailable'}
            containers = []
            ports = []
            for line in out.splitlines():
                row = json.loads(line)
                containers.append({'name': row.get('Names'), 'state': row.get('State')})
                if row.get('Ports') and row.get('State') == 'running':
                    ports.append(row['Ports'])
            return {'state': 'available', 'containers': containers, 'ports': ports,
                    'association': 'compose working_dir exact match'}
        except (OSError, ValueError, RuntimeError, TimeoutError):
            return {'state': 'error'}
