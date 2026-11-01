"""Local-only fixture, using real storage/API and synthetic AI results."""
import asyncio
import json
import os
from pathlib import Path

from app.main import create_app
from app.models.schemas import AgentResult
import app.core.orchestrator as runtime

runtime.executable = lambda *args: 'fake-cli'


async def execute(self, context, cwd, mode, session=None):
    await asyncio.sleep(1.2)
    task = json.loads(context)['task']
    if task == '질문 사례':
        return AgentResult(adapter=self.client, output='```codast-question\n{"question":"어떤 입력을 검사할까요?","choices":[]}\n```')
    if task == '실패 사례':
        raise RuntimeError('가상 연결 오류, 재시도하세요.')
    return AgentResult(adapter=self.client, output='입력 검사를 확인했습니다.\n\n- 정상 입력: 통과\n- 빈 입력: 거부\n<script>unsafe</script>')


runtime.CliAdapter.execute = execute
root = Path(os.environ['HARNESS_WORK_ITEM_TEST_ROOT'])
app = create_app(root / 'projects', db_path=root / 'runs.sqlite3')
