import asyncio
from pathlib import Path
from app.core.environment import EnvironmentStatus


def test_scoped_queries_and_cache(monkeypatch, tmp_path):
    monkeypatch.setattr('app.core.environment.shutil.which', lambda name: name)
    calls = []
    class Runner:
        async def run(self, argv, cwd, timeout):
            calls.append(argv)
            if argv[0] == 'git':
                return 0, '# branch.head main\n1 .M something\n? new.txt\n', ''
            assert 'label=com.docker.compose.project.working_dir='+str(tmp_path.resolve()) in argv
            return 0, '{"Names":"web","State":"running","Ports":"127.0.0.1:3000->80/tcp"}\n', ''
    async def check():
        service = EnvironmentStatus(Runner())
        first = await service.read(tmp_path)
        assert first == await service.read(tmp_path)
        assert first['git']['changed_entries'] == 2
        assert first['docker']['containers'][0]['name'] == 'web'
        assert first['ports']['host_state'] == 'not_collected'
        assert len(calls) == 2
    asyncio.run(check())


def test_missing_and_failed_tools(monkeypatch, tmp_path):
    monkeypatch.setattr('app.core.environment.shutil.which', lambda name: None)
    result = asyncio.run(EnvironmentStatus().read(tmp_path))
    assert result['git']['state'] == result['docker']['state'] == 'not_installed'
    monkeypatch.setattr('app.core.environment.shutil.which', lambda name: name)
    class Runner:
        async def run(self, argv, cwd, timeout):
            return 1, '', 'fatal: not a git repository' if argv[0] == 'git' else 'private engine error'
    result = asyncio.run(EnvironmentStatus(Runner()).read(tmp_path))
    assert result['git']['state'] == 'not_repository'
    assert result['docker']['state'] == 'unavailable'
    assert 'private' not in str(result)
