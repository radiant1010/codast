"""Isolated browser fixture: real storage/API, synthetic CLI and catalog fault."""
import asyncio
import json
import os
from pathlib import Path
from fastapi import Body
from app.main import create_app
from app.models.schemas import AgentResult
import app.core.orchestrator as runtime
import app.core.workflows as workflows

runtime.executable = lambda *args: 'fake-cli'
async def execute(self, context, cwd, mode, session=None):
    await asyncio.sleep(.15)
    design = '역할: 설계 작성' in json.loads(context)['task']
    return AgentResult(adapter='codex', output=('설계 REQ-001' if design else 'TC-001 REQ-001')+'\n<script>unsafe</script>')
runtime.CliAdapter.execute = execute
root = Path(os.getenv('HARNESS_RECOVERY_TEST_ROOT', 'work/recovery-browser'))
app = create_app(root/'projects', db_path=root/'runs.sqlite3')
fault = {'enabled': True}
write = workflows.atomic_write
def catalog_write(path, value):
    for digest in value.get('workflows', {}).values():
        state = app.state.document_vault.get_object(path.parent, digest)
        if fault['enabled'] and state.get('kind') == 'parallel' and state['steps'][0]['status'] == 'review':
            raise ValueError('가상 보관 실패')
    return write(path, value)
workflows.atomic_write = catalog_write
@app.post('/test/capture-fault')
def configure(value: dict = Body()):
    fault['enabled'] = bool(value['enabled'])
    return fault
