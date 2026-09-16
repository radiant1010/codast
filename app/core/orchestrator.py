import asyncio
import json
import hashlib
import time
from app.models.schemas import ContextPart, ProjectSettings
from app.llm.base import AgentAdapter
from app.core.context_builder import ContextBuilder
from app.core.rule_loader import RuleLoader
from app.core.routing import TaskRouter
from app.llm.cli import CliAdapter, executable


class Orchestrator:
    def __init__(self, projects, policy, files, agent: AgentAdapter, storage):
        self.projects, self.policy, self.files, self.agent = projects, policy, files, agent
        self.rules = RuleLoader(policy, files)
        self.context = ContextBuilder()
        self.storage = storage
        self.router = TaskRouter(storage)
        self.active = {}

    def settings(self, name):
        self.projects.select(name)
        return ProjectSettings(**self.storage.settings(name))

    def save_settings(self, name, settings):
        root = self.projects.select(name)
        cwd = self.policy.file_path(root, settings.cwd)
        if not cwd.is_dir():
            raise FileNotFoundError("작업 디렉터리를 찾을 수 없습니다.")
        for path in settings.context_paths:
            self.policy.file_path(root, path)
        self.storage.save_settings(name, settings.model_dump())
        return settings

    def list_files(self, name):
        root = self.projects.select(name)
        result = []
        for relative in self.files.list_candidates(root):
            try:
                self.policy.file_path(root, relative)
                result.append(relative)
            except PermissionError:
                continue
        return result

    def read_file(self, name, relative):
        return self.files.read(self.policy.file_path(self.projects.select(name), relative))

    def write_file(self, name, relative, content):
        self.files.write(self.policy.file_path(self.projects.select(name), relative, write=True), content)

    def prepare(self, name, command):
        root = self.projects.select(name)
        cwd = self.policy.file_path(root, command.cwd)
        if not cwd.is_dir():
            raise FileNotFoundError('작업 디렉터리를 찾을 수 없습니다.')
        command = command.model_copy(update={'task': command.task.strip()})
        rules = self.rules.load(root, command.cwd)
        selected = [ContextPart(path=p, content=self.read_file(name, p)) for p in dict.fromkeys(command.context_paths)]
        context = self.context.build(command, rules, selected)
        adapter = self.agent if command.client == 'mock' else CliAdapter(command.client, executable(command.client, self.storage.client_path(command.client)))
        if command.client != 'mock':
            adapter.model = command.model
        session = None if command.fresh else self.storage.session(name, command.task, command.client, str(cwd), command.mode)
        rows = self.storage.messages(name, command.task, 30, 0) if command.task else []
        history = []
        for row in rows:
            # On resume, the native client already holds its previous successful turn.
            prior_metadata = json.loads(row['metadata'] or '{}')
            if session and row['adapter'] == command.client and row['status'] == 'completed' and prior_metadata.get('session_id') == session:
                break
            history.append({'user': row['text'][:4000], 'client': row['adapter'],
                            'result': (row['output'] or row['error'] or '')[:6000]})
        context.history = list(reversed(history))
        while context.history and len(context.model_dump_json()) > self.context.max_chars:
            context.history.pop(0)
        run_id = self.storage.start_run(name, command, command.client, exclusive=True)
        if command.fresh:
            self.storage.forget_session(name, command.task, command.client, str(cwd), command.mode)
        return run_id, command, context, cwd, adapter, session

    async def perform(self, name, prepared):
        run_id, command, context, cwd, adapter, session = prepared
        started = time.monotonic()
        metadata = {'client': command.client, 'mode': command.mode, 'resumed': bool(session),
                    'requested_model': command.model,
                    'history_count': len(context.history),
                    'rules': [{'path': rule.path, 'sha256': hashlib.sha256(rule.content.encode('utf-8')).hexdigest()}
                              for rule in context.rules]}
        try:
            if command.client == 'mock':
                result = await adapter.run(context)
            else:
                adapter.on_event = lambda kind, text: self.storage.append_event(run_id, kind, text)
                result = await adapter.execute(context.model_dump_json(), str(cwd), command.mode, session)
        except asyncio.CancelledError:
            self.storage.forget_session(name, command.task, command.client, str(cwd), command.mode)
            self.storage.finish_run(run_id, "interrupted", error="실행이 취소되었습니다.", metadata=metadata)
            raise
        except Exception as exc:
            # A failed native turn may have partially changed its own conversation.
            self.storage.forget_session(name, command.task, command.client, str(cwd), command.mode)
            self.storage.finish_run(run_id, "failed", error=str(exc), metadata=metadata)
            raise
        native_session = result.session_id or session
        self.storage.save_session(name, command.task, command.client, str(cwd), command.mode, native_session)
        metadata.update(session_id=native_session, usage=result.usage, execution_model=result.execution_model, elapsed_seconds=round(time.monotonic()-started, 2))
        self.storage.finish_run(run_id, "completed", output=result.output, adapter=result.adapter, metadata=metadata)
        return result.model_copy(update={"run_id": run_id})

    async def execute(self, name, command):
        prepared = self.prepare(name, command)
        run_id = prepared[0]
        self.active[run_id] = asyncio.current_task()
        try:
            return await self.perform(name, prepared)
        finally:
            self.active.pop(run_id, None)

    def submit(self, name, command):
        prepared = self.prepare(name, command)
        run_id = prepared[0]

        async def work():
            try:
                await self.perform(name, prepared)
            except Exception:
                pass  # Failure is persisted and retrieved by run ID.

        task = asyncio.create_task(work())
        self.active[run_id] = task
        def finished(_):
            self.active.pop(run_id, None)
            if self.storage.run(name, run_id)['status'] == 'running':
                self.storage.finish_run(run_id, 'interrupted', error='서버가 실행을 종료했습니다.')
        task.add_done_callback(finished)
        return run_id

    async def cancel(self, name, run_id):
        record = self.storage.run(name, run_id)
        if record['status'] != 'running':
            return
        task = self.active.get(run_id)
        if not task:
            raise FileExistsError('현재 서버가 실행한 프로세스가 아닙니다. 종료 확인 후 기록을 정리하세요.')
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        if self.storage.run(name, run_id)['status'] == 'running':
            self.storage.finish_run(run_id, 'interrupted', error='시작 전에 취소되었습니다.')

    async def shutdown(self):
        tasks = list(self.active.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
