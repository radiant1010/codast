"""Run with .local/serena's Python after init; no AI turn or real project is used."""
import asyncio
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from app.core.toolchain import Toolchain
from app.llm.serena_server import READ_TOOLS


async def check():
    with TemporaryDirectory(prefix='mcp-smoke-', dir=ROOT / '.local') as directory:
        project = Path(directory)
        (project / 'sample.py').write_text('def greet(name: str) -> str:\n    return "Hello " + name\n', encoding='utf-8')
        (project / '.serena').mkdir()
        (project / '.serena/project.yml').write_text(
            'project_name: codast-smoke\nlanguages: [python]\n'
            'ignored_paths: ["!**/.harness/", "!**/.harness/**"]\n'
            'included_optional_tools: [execute_shell_command, replace_symbol_body]\n', encoding='utf-8')
        (project / '.harness').mkdir()
        (project / '.harness/private.py').write_text('def hidden_secret():\n    return "fixture-only"\n', encoding='utf-8')
        config = Toolchain().configuration(project)['codast-serena']
        config['env']['SERENA_HOME'] = str(project / 'isolated-serena-home')
        server = StdioServerParameters(**config, cwd=directory)
        with (ROOT / '.local/mcp-smoke.log').open('w', encoding='utf-8') as log:
            async with stdio_client(server, errlog=log) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    names = {tool.name for tool in (await session.list_tools()).tools}
                    assert names == set(READ_TOOLS), names
                    print('Serena initialize and tools/list: PASS (3 symbol tools)', flush=True)
                    rejected = await session.call_tool('execute_shell_command', {'command': 'echo forbidden'})
                    assert rejected.is_error, rejected
                    print('Unregistered command execution: rejected', flush=True)
                    symbols = await session.call_tool('get_symbols_overview', {'relative_path': 'sample.py'})
                    assert not symbols.is_error, symbols
                    assert 'greet' in str(symbols), symbols
                    print('Python symbol lookup: PASS', flush=True)
                    protected = await session.call_tool('get_symbols_overview', {'relative_path': '.harness/private.py'})
                    assert protected.is_error or 'ignored' in str(protected).lower(), protected
                    assert 'hidden_secret' not in str(protected), protected
                    print('Protected path with project negation: rejected', flush=True)


if __name__ == '__main__':
    asyncio.run(asyncio.wait_for(check(), timeout=180))
