"""Opt-in native install smoke test, using disposable CLI homes and no model calls."""
import asyncio
import json
import os
from pathlib import Path
import tempfile

from app.core.tool_catalog import ToolCatalog
from app.core.toolchain import ROOT
from app.llm.cli import executable


async def main():
    paths = {client: executable(client) for client in ('codex', 'claude')}
    home = Path(tempfile.mkdtemp(prefix='plugin-bootstrap-', dir=ROOT / '.local'))
    # Keep downloaded fixtures local for inspection; never copy credentials.
    os.environ['CODEX_HOME'] = str(home / 'codex')
    os.environ['CLAUDE_CONFIG_DIR'] = str(home / 'claude')
    for path in ('codex', 'claude'):
        (home / path).mkdir()
    service = ToolCatalog()
    before = {client: (await service.plugins.read(client, paths[client], ROOT))['plugins'] for client in paths}
    assert all(not rows for rows in before.values()), 'Expected isolated plugin homes'
    errors = await service.install_plugins(paths)
    print(json.dumps({'errors': errors}, ensure_ascii=False), flush=True)
    assert not errors
    first = {client: (await service.plugins.read(client, paths[client], ROOT))['plugins'] for client in paths}
    assert all(len(rows) == 2 for rows in first.values())
    assert not await service.install_plugins(paths)
    second = {client: (await service.plugins.read(client, paths[client], ROOT))['plugins'] for client in paths}
    assert first == second, 'Repeated setup changed installed plugins'
    print('PASS: both native clients installed two missing plugins and reused the same versions on repeat init.')


if __name__ == '__main__':
    asyncio.run(main())
