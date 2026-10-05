"""Sequential, human-approved work. Immutable vault objects are the source of truth."""
from copy import deepcopy
from hashlib import sha256
import json
import io
import logging
from zipfile import ZipFile, ZIP_DEFLATED
from uuid import uuid4

from app.core.document_vault import atomic_write, now
from app.guards.filesystem import confined
from app.models.schemas import Command, ContextPart


class Workflows:
    def __init__(self, vault, harness):
        self.vault, self.harness = vault, harness
        from app.core.parallel_workflows import ParallelWorkflows
        self.parallel = ParallelWorkflows(self)

    def reply(self, name, run_id, answer, request_id):
        record = self.harness.storage.run(name, run_id)
        metadata = record['metadata']
        if metadata.get('workflow_id') or metadata.get('parallel_group'):
            raise FileExistsError('워크플로 화면에서 해당 작업의 질문에 답변하세요.')
        task = record['command'].get('task', '')
        legacy_prefix = '워크플로: '+task.partition(' / ')[0]+'\n단계: '
        if task.startswith('CDS-WF-') and record['command'].get('text', '').startswith(legacy_prefix):
            binding = self.vault.binding(name)
            if not binding:
                raise FileExistsError('워크플로 연결을 확인한 뒤 해당 화면에서 답변하세요.')
            with self.vault.opened(name, binding['connection_id']) as (root, catalog):
                for identity in catalog.get('workflows', {}):
                    state = self.load(root, catalog, identity)
                    if any(a.get('run_id') == run_id for step in state['steps'] for a in step['attempts']):
                        raise FileExistsError('워크플로 화면에서 해당 작업의 질문에 답변하세요.')
            raise FileExistsError('이 질문의 원래 문서함을 다시 연결하고 워크플로 화면에서 답변하세요.')
        return self.harness.reply(name, run_id, answer, request_id)

    def load(self, root, catalog, identity):
        digest = catalog.get('workflows', {}).get(identity)
        if not digest:
            raise FileNotFoundError('워크플로를 찾을 수 없습니다.')
        return self.vault.workflow(root, digest)

    def payload_refs(self, root, value):
        # Bound each existing JSON object even for escaped text and large input copies.
        text = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
        return [self.vault.put_object(root, {'text': text[i:i+128_000]})
                for i in range(0, len(text), 128_000)]

    def save(self, root, catalog, state):
        stored = deepcopy(state)
        stored.pop('cancellable', None)
        for step in stored['steps']:
            step.pop('cancellable', None)
            step['attempts'] = [dict(run_id=a['run_id'], version=a.get('version'),
                                     payload_refs=self.payload_refs(root, a)) for a in step['attempts']]
        if 'source' in stored:
            stored['source_refs'] = self.payload_refs(root, stored.pop('source'))
        stored['revision'] += 1
        stored['updated_at'] = now()
        updated = deepcopy(catalog)
        updated.setdefault('workflows', {})[state['id']] = self.vault.put_object(root, stored)
        atomic_write(confined(root, 'catalog.json'), updated)
        # Publish the revision only after the catalog commit succeeds.
        catalog.clear()
        catalog.update(updated)
        state.update(revision=stored['revision'], updated_at=stored['updated_at'])

    def list(self, name, connection_id):
        with self.vault.opened(name, connection_id) as (root, catalog):
            rows = []
            for identity in list(catalog.get('workflows', {})):
                state = self.load(root, catalog, identity)
                self.sync(name, root, catalog, state)
                rows.append({k: state[k] for k in ('id', 'title', 'status')})
            return rows

    def export(self, name, connection_id, identity):
        state = self.read(name, connection_id, identity)
        if state['status'] != 'done':
            raise FileExistsError('모든 단계의 결과를 승인한 후 내려받을 수 있습니다.')
        output = io.BytesIO()
        with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
            manifest = {'id': identity, 'title': state['title'], 'revision': state['revision'], 'steps': []}
            for index, step in enumerate(state['steps'], 1):
                attempt = step['attempts'][step['approved'] - 1]
                filename = f"{index:02d}-v{step['approved']}.md"
                content = attempt['output'].encode('utf-8')
                archive.writestr(filename, content)
                manifest['steps'].append({'title': step['title'], 'file': filename,
                    'version': step['approved'], 'sha256': sha256(content).hexdigest(),
                    'client': attempt['client'], 'model': attempt.get('model'),
                    'run_id': attempt['run_id'], 'approved_at': attempt['approved_at']})
            archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
            archive.writestr('history.json', json.dumps(state, ensure_ascii=False, indent=2))
        return output.getvalue()

    def capture(self, name, connection_id, identity):
        # Capture with the browser closed; failed writes require an explicit recapture.
        try:
            self.read(name, connection_id, identity)
        except Exception:
            logging.getLogger(__name__).exception('Workflow result capture failed: %s', identity)

    def create(self, name, connection_id, title, steps, materials, request_id):
        with self.vault.opened(name, connection_id) as (root, catalog):
            identity = 'CDS-WF-' + request_id
            if identity in catalog.get('workflows', {}):
                existing = self.load(root, catalog, identity)
                if existing.get('kind') == 'parallel':
                    raise FileExistsError('동일 요청 번호의 작업 유형이 다릅니다.')
                creation = dict(existing['creation'])
                creation['steps'] = [dict(s, mode=s.get('mode', 'read-only')) for s in creation['steps']]
                requested = {'title': title, 'steps': [dict(s, mode=s.get('mode', 'read-only')) for s in steps], 'materials': materials}
                if creation != requested:
                    raise FileExistsError('동일 요청 번호의 설정이 다릅니다.')
                return existing
            if len(catalog.get('workflows', {})) >= 100:
                raise ValueError('문서함당 워크플로는 100개까지 지원합니다.')
            if len({m['id'] for m in materials}) != len(materials):
                raise ValueError('같은 자료를 중복 등록할 수 없습니다.')
            self.harness.materials.selected(name, [m['id'] for m in materials])
            state = {'id': identity, 'title': title, 'revision': 0, 'status': 'ready', 'current': 0,
                     'creation': {'title': title, 'steps': steps, 'materials': materials},
                     'materials': materials, 'steps': [dict(s, attempts=[], approved=None) for s in steps]}
            self.save(root, catalog, state)
            return state

    def sync(self, name, root, catalog, state, retry_run_id=None):
        parallel = state.get('kind') == 'parallel'
        indexes = [i for i, step in enumerate(state['steps']) if step['status'] == 'running'] if parallel else [state['current']] if state['status'] == 'running' else []
        if not indexes:
            return
        durable = deepcopy(state)
        pending = {}
        for index in indexes:
            candidate = deepcopy(durable)
            step = candidate['steps'][index]
            attempt = step['attempts'][-1]
            try:
                record = self.harness.storage.run(name, attempt['run_id'])
            except FileNotFoundError:
                record = None
                attempt.update(status='failed', error='실행 기록이 없습니다. 자동 재실행하지 않았습니다.')
            else:
                if record['status'] == 'running':
                    continue
                status = ('cancelled' if record['status'] == 'interrupted' and parallel else
                          'question' if record['metadata'].get('question') else
                          'review' if record['status'] == 'completed' and record['output'] else 'failed')
                metadata = dict(record['metadata'])
                marker = metadata.pop('workflow_capture', {})
                attempt.update(status=status, output=record['output'] or '', error=record['error'] or '', metadata=metadata)
            attempt['storage_status'] = 'saved'
            attempt.pop('storage_error', None)
            if parallel:
                step['status'] = attempt['status']
                self.parallel.aggregate(candidate)
            else:
                candidate['status'] = attempt['status']
            if record is None and attempt['run_id'] != retry_run_id:
                attempt.update(storage_status='missing', storage_error=attempt['error'])
                pending[index] = attempt
                continue
            error = None
            if record and marker.get('vault_id') == catalog['vault_id'] and marker.get('status') == 'failed' and attempt['run_id'] != retry_run_id:
                error = marker['error']
            else:
                try:
                    self.save(root, catalog, candidate)
                except (ValueError, OSError) as exc:
                    error = str(exc)
                if record:
                    self.harness.storage.workflow_capture(name, attempt['run_id'],
                        {'vault_id': catalog['vault_id'], 'status': 'failed' if error else 'saved', 'error': error})
            if error:
                attempt.update(storage_status='failed', storage_error=error)
                pending[index] = attempt
            else:
                durable = candidate
        state.clear()
        state.update(durable)
        for index, attempt in pending.items():
            state['steps'][index]['attempts'][-1] = attempt
            if parallel:
                state['steps'][index]['status'] = attempt['status']
            else:
                state['status'] = attempt['status']
        if parallel:
            self.parallel.aggregate(state)

    def recapture(self, name, connection_id, identity, expected_revision, run_id):
        with self.vault.opened(name, connection_id) as (root, catalog):
            state = self.load(root, catalog, identity)
            if state['revision'] != expected_revision:
                raise FileExistsError('다른 화면에서 변경되었습니다. 다시 불러오세요.')
            matches = [s for s in state['steps'] if s['attempts'] and s['attempts'][-1]['run_id'] == run_id]
            if not matches:
                raise ValueError('이 워크플로의 현재 실행을 선택하세요.')
            try:
                record = self.harness.storage.run(name, run_id)
            except FileNotFoundError:
                record = None  # Explicitly archive the missing-run failure, never replay it.
            if record and record['status'] == 'running':
                raise FileExistsError('실행이 아직 끝나지 않았습니다.')
            self.sync(name, root, catalog, state, retry_run_id=run_id)
            return state

    def read(self, name, connection_id, identity):
        with self.vault.opened(name, connection_id) as (root, catalog):
            state = self.load(root, catalog, identity)
            self.sync(name, root, catalog, state)
            if state.get('kind') == 'parallel':
                for step in state['steps']:
                    step['cancellable'] = bool(step['attempts'] and step['attempts'][-1]['run_id'] in self.harness.active)
                return state
            if state['status'] == 'running':
                state['cancellable'] = state['steps'][state['current']]['attempts'][-1]['run_id'] in self.harness.active
            return state

    def missing_run(self, name, step):
        """Only an explicit new run may archive a missing dispatch alongside its intent."""
        if not step['attempts'] or step['attempts'][-1].get('status') != 'running':
            return False
        attempt = step['attempts'][-1]
        try:
            self.harness.storage.run(name, attempt['run_id'])
        except FileNotFoundError:
            attempt.update(status='failed', storage_status='saved',
                           error='실행 기록이 없습니다. 자동 재실행하지 않았습니다.')
            return True
        return False

    def change(self, name, connection_id, identity, expected_revision, action, **values):
        with self.vault.opened(name, connection_id) as (root, catalog):
            state = self.load(root, catalog, identity)
            if state.get('kind') == 'parallel':
                raise FileExistsError('병렬 작업 전용 실행 경로를 사용하세요.')
            if state['revision'] != expected_revision:
                raise FileExistsError('다른 화면에서 변경되었습니다. 다시 불러오세요.')
            if state['status'] == 'done':
                raise FileExistsError('이미 완료한 워크플로입니다.')
            step = state['steps'][state['current']]
            if action == 'run' and state['status'] == 'running' and self.missing_run(name, step):
                state['status'] = 'failed'
            if action == 'approve':
                if state['status'] != 'review':
                    raise FileExistsError('검토 가능한 결과가 없습니다.')
                step['approved'] = len(step['attempts'])
                step['attempts'][-1].update(approved_at=now(), approval_comment=values['comment'])
                state['current'] += 1
                state['status'] = 'done' if state['current'] == len(state['steps']) else 'ready'
                self.save(root, catalog, state)
                return state
            if action != 'run' or state['status'] not in ('ready', 'review', 'failed', 'question'):
                raise FileExistsError('현재 단계는 실행할 수 없습니다.')
            if len(step['attempts']) >= 20:
                raise ValueError('단계별 실행은 20회까지 지원합니다.')
            instruction = values['instruction'].strip()
            if state['status'] in ('review', 'question') and not values['comment'].strip():
                raise ValueError('수정 의견 또는 질문에 대한 답변을 입력하세요.')
            parts = []
            for previous in state['steps'][:state['current']]:
                if not previous['approved']:
                    raise FileExistsError('앞 단계의 승인이 필요합니다.')
                version = previous['approved']
                parts.append(ContextPart(path=f"{previous['title']} / v{version} / 사용자 승인",
                                         content=previous['attempts'][version-1]['output']))
            previous_result = next((a for a in reversed(step['attempts']) if a.get('output')), None)
            if previous_result:
                parts.append(ContextPart(path=f"수정 대상 이전 결과 / v{previous_result['version']}", content=previous_result['output']))
            selected, _ = self.harness.materials.selected(name, [m['id'] for m in state['materials']])
            request_id = uuid4().hex
            run_id = sha256(json.dumps([name, request_id]).encode()).hexdigest()
            text = (f"워크플로: {state['id']}\n단계: {state['current']+1}. {step['title']}\n"
                    f"작업 지시:\n{instruction}\n수정 의견 또는 답변:\n{values['comment']}\n"
                    '자료 용도:\n' + '\n'.join(m['role']+': '+part.path for m, part in zip(state['materials'], selected)) + '\n'
                    '결과 본문 전체와 변경 요약, 근거, 미확인 사항을 제출하세요. '
                    '다음 AI를 호출하거나 다음 단계를 수행하지 말고 사용자 검토를 기다리세요.')
            command = Command(text=text, task=state['id']+' / '+str(state['current']+1),
                              client=values['client'], model=values.get('model'), mode=values.get('mode', 'read-only'), fresh=True,
                              material_ids=[m['id'] for m in state['materials']])
            # Reserve intent first; a crash after launch can recover by deterministic run ID.
            attempt = {'version': len(step['attempts'])+1, 'run_id': run_id, 'instruction': instruction,
                       'comment': values['comment'], 'directive': text, 'client': command.client, 'model': command.model, 'mode': command.mode,
                       'inputs': [p.model_dump() for p in parts + selected], 'status': 'running', 'created_at': now()}
            step.update(client=command.client, model=command.model, instruction=instruction, mode=command.mode)
            step['attempts'].append(attempt)
            state['status'] = 'running'
            self.save(root, catalog, state)
            try:
                self.harness.submit(name, command, request_id=request_id, extra_context=parts, include_history=False, workflow_id=identity)
                task = self.harness.active.get(run_id)
                if task:
                    task.add_done_callback(lambda _: self.capture(name, connection_id, identity))
            except Exception as exc:
                state['status'] = 'failed'
                attempt.update(status='failed', error=str(exc))
                self.save(root, catalog, state)
            return state
