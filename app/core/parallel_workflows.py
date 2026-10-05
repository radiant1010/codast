"""Two independent, read-only roles over one immutable approved input."""
from hashlib import sha256
import json
from uuid import uuid4

from app.core.document_vault import now
from app.models.schemas import Command, ContextPart

ROLES = (
    ('설계 작성', '승인된 요구사항의 설계를 작성하세요. 요구사항 ID, 구조와 동작, 선택 이유, 미확정 결정과 확인할 사항을 제출하세요.'),
    ('테스트케이스 정의', '요구사항 기반 테스트케이스를 정의하세요. 요구사항 ID, 테스트 ID, 전제, 절차, 기대 결과와 정상, 오류, 경계 조건을 제출하세요. 아직 나오지 않은 설계 결과에 의존하지 마세요. API 등 설계 결정이 필요한 조건은 미확정으로 표시하세요.'),
)


class ParallelWorkflows:
    def __init__(self, workflows):
        self.workflows = workflows
        self.vault, self.harness = workflows.vault, workflows.harness

    def source(self, root, catalog, ref):
        if ref['kind'] == 'document':
            state = self.vault.document(root, catalog, ref['identity'])
            version = ref['version']
            if version > len(state['reviews']) or state['reviews'][version-1]['decision'] != 'approved':
                raise FileExistsError('승인된 문서 버전을 선택하세요.')
            value = self.vault.snapshot(root, state['reviews'][version-1])
        else:
            state = self.workflows.load(root, catalog, ref['identity'])
            if state.get('kind') == 'parallel' or ref.get('step') is None or ref['step'] >= len(state['steps']):
                raise ValueError('승인된 순차 워크플로 단계를 선택하세요.')
            step = state['steps'][ref['step']]
            if step['approved'] != ref['version']:
                raise FileExistsError('승인된 단계 버전이 아닙니다.')
            value = {'title': step['title'], 'content': step['attempts'][ref['version']-1]['output']}
        digest = sha256(value['content'].encode('utf-8')).hexdigest()
        if state['revision'] != ref['expected_revision'] or digest != ref['sha256']:
            raise FileExistsError('입력 버전 또는 내용이 변경되었습니다. 다시 선택하세요.')
        if not value['content'].strip():
            raise ValueError('빈 승인 자료는 실행할 수 없습니다.')
        return dict(ref, **value)

    def create(self, name, connection_id, request_id, title, source):
        with self.vault.opened(name, connection_id) as (root, catalog):
            identity = 'CDS-WF-' + request_id
            creation = {'title': title, 'source': source}
            if identity in catalog.get('workflows', {}):
                existing = self.workflows.load(root, catalog, identity)
                if existing.get('kind') != 'parallel' or existing['creation'] != creation:
                    raise FileExistsError('동일 요청 번호의 설정이 다릅니다.')
                return existing
            if len(catalog.get('workflows', {})) >= 100:
                raise ValueError('문서함당 워크플로는 100개까지 지원합니다.')
            fixed = self.source(root, catalog, source)
            state = {'id': identity, 'kind': 'parallel', 'title': title, 'revision': 0, 'status': 'ready',
                     'creation': creation, 'source': fixed, 'fixed_at': None, 'materials': [],
                     'steps': [dict(title=t, instruction=i, client='codex', mode='read-only', model=None,
                                    status='ready', attempts=[], approved=None) for t, i in ROLES]}
            self.workflows.save(root, catalog, state)
            return state

    @staticmethod
    def aggregate(state):
        statuses = [s['status'] for s in state['steps']]
        state['status'] = ('running' if 'running' in statuses else 'done' if all(s['approved'] for s in state['steps'])
                           else 'review' if all(s in ('review', 'approved') for s in statuses)
                           else 'ready' if all(s == 'ready' for s in statuses) else 'partial')

    def change(self, name, connection_id, identity, expected_revision, action, role=None, comment=''):
        with self.vault.opened(name, connection_id) as (root, catalog):
            state = self.workflows.load(root, catalog, identity)
            if state.get('kind') != 'parallel':
                raise ValueError('병렬 워크플로가 아닙니다.')
            if state['revision'] != expected_revision:
                raise FileExistsError('다른 화면에서 변경되었습니다. 다시 불러오세요.')
            if action == 'start':
                if state['fixed_at'] is not None:
                    raise FileExistsError('이미 시작한 작업입니다. 필요한 작업만 다시 실행하세요.')
                self.source(root, catalog, state['creation']['source'])
                state['fixed_at'] = now()
                roles = (0, 1)
            else:
                if role not in (0, 1) or state['fixed_at'] is None:
                    raise ValueError('시작한 작업의 역할을 선택하세요.')
                step = state['steps'][role]
                if action == 'retry' and step['status'] == 'running' and self.workflows.missing_run(name, step):
                    step['status'] = 'failed'
                if action == 'approve':
                    if step['status'] != 'review':
                        raise FileExistsError('검토 가능한 결과가 없습니다.')
                    step['approved'] = len(step['attempts'])
                    step['status'] = 'approved'
                    step['attempts'][-1].update(approved_at=now(), approval_comment=comment)
                    self.aggregate(state)
                    self.workflows.save(root, catalog, state)
                    return state
                if action != 'retry' or step['status'] not in ('ready', 'failed', 'cancelled', 'question', 'review') or step['approved']:
                    raise FileExistsError('해당 작업은 다시 실행할 수 없습니다.')
                if step['status'] in ('question', 'review') and not comment.strip():
                    raise ValueError('질문 답변 또는 수정 의견을 입력하세요.')
                roles = (role,)
            for index in roles:
                self.launch(name, connection_id, root, catalog, state, index, comment)
            return state

    def launch(self, name, connection_id, root, catalog, state, role, comment):
        step = state['steps'][role]
        if len(step['attempts']) >= 20:
            raise ValueError('작업별 실행은 20회까지 지원합니다.')
        source = state['source']
        parts = [ContextPart(path=f"{source['identity']} / v{source['version']} / SHA-256 {source['sha256']} / 사용자 승인", content=source['content'])]
        previous = next((a for a in reversed(step['attempts']) if a.get('output')), None)
        if previous:
            parts.append(ContextPart(path='해당 역할의 이전 결과 또는 질문', content=previous['output']))
        text = (f"워크플로: {state['id']}\n역할: {step['title']}\n{step['instruction']}\n"
                f"사용자 답변 또는 수정 의견:\n{comment}\n"
                '파일 수정, 다른 에이전트 호출, 구현과 테스트 실행은 하지 마세요. 결과 본문과 근거, 미확정 사항을 제출하고 사용자 검토를 기다리세요.')
        try:
            chat = self.harness.storage.resolve_chat(name, state['id'] + ' / ' + str(role), step.get('chat_id'))
        except FileNotFoundError:
            # Vault-only recovery: a user-requested new attempt may create a new app chat.
            chat = self.harness.storage.resolve_chat(name, state['id'] + ' / ' + str(role))
        step['chat_id'] = chat['id']
        command = Command(text=text, task=chat['task'], chat_id=chat['id'], client='codex', mode='read-only', fresh=True)
        request_id = uuid4().hex
        run_id = sha256(json.dumps([name, request_id]).encode()).hexdigest()
        reply_to = step['attempts'][-1]['run_id'] if step['status'] == 'question' else None
        if reply_to:
            try:
                original = self.harness.storage.run(name, reply_to)
            except FileNotFoundError:
                reply_to = None  # The vault still supplies the question and this explicit answer.
            else:
                if original['command'].get('chat_id') != chat['id']:
                    reply_to = None
        attempt = {'version': len(step['attempts'])+1, 'run_id': run_id, 'instruction': step['instruction'], 'directive': text,
                   'comment': comment, 'client': 'codex', 'mode': 'read-only', 'inputs': [p.model_dump() for p in parts],
                   'status': 'running', 'created_at': now(), 'input_sha256': source['sha256']}
        step['attempts'].append(attempt)
        step['status'] = 'running'
        self.aggregate(state)
        # Intent is durable before dispatch; missing DB records never imply replay.
        self.workflows.save(root, catalog, state)
        try:
            self.harness.submit(name, command, request_id, reply_to=reply_to, extra_context=parts,
                                include_history=False, parallel_scope=(state['id'], role))
            task = self.harness.active.get(run_id)
            if task:
                task.add_done_callback(lambda _: self.workflows.capture(name, connection_id, state['id']))
        except Exception as exc:
            step['status'] = 'failed'
            attempt.update(status='failed', error=str(exc))
            self.aggregate(state)
            self.workflows.save(root, catalog, state)
