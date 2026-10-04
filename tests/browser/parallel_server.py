import asyncio,json,os
from pathlib import Path
from app.main import create_app
from app.models.schemas import AgentResult
import app.core.orchestrator as runtime
runtime.executable=lambda *args:'fake-cli'
async def execute(self,context,cwd,mode,session=None):
    data=json.loads(context)
    assert mode=='read-only' and session is None
    design='역할: 설계 작성' in data['task']
    if design and os.getenv('HARNESS_TEST_HOLD_DESIGN')=='1':
        await asyncio.sleep(60)
    if design and '사용자 답변 또는 수정 의견:\n텍스트' not in data['task']:
        await asyncio.sleep(.4)
        return AgentResult(adapter='codex',output='```codast-question\n{"question":"저장 형식은?","choices":["텍스트"]}\n```')
    await asyncio.sleep(2 if not design else .2)
    return AgentResult(adapter='codex',output=('설계 결과 REQ-001' if design else 'TC-001 REQ-001, API 미확정')+'\n<script>unsafe</script>',session_id='fake-design' if design else 'fake-tests')
runtime.CliAdapter.execute=execute
root=Path(os.getenv('HARNESS_PARALLEL_TEST_ROOT','work/parallel-browser'))
app=create_app(root/'projects',db_path=root/'runs.sqlite3')
