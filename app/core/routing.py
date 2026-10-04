"""Local task routing. No model calls, network requests, or implicit execution."""
import re

TOPICS = {
    '로그인': ('로그인', '인증', 'login', 'auth', '로그아웃', '회원가입'),
    'DB': ('db', '데이터베이스', 'sqlite', 'sql', '스키마', '마이그레이션'),
    '대시보드': ('대시보드', 'dashboard'),
    '결제': ('결제', 'payment', 'checkout'),
    '플러그인': ('플러그인', 'plugin', '스킬'),
    '세션': ('세션', 'session', '통합채팅', '통합 채팅'),
    '배포': ('배포', 'deploy', 'hosting'),
}
STOP = {'해줘', '해주세요', '만들어줘', '구현', '수정', '검토', '추가', '기능', '작업', '그리고', '아까', '좀', '그럼', '다음', '이거', '그거', '클로드', '코덱스', 'codex', 'claude', 'please', 'the', 'this', 'that', 'fix', 'review', 'make'}


def tokens(text):
    result = set()
    for token in re.findall(r'[a-z0-9_]+|[가-힣]+', text.lower()):
        token = re.sub(r'(에서는|에서|으로|까지|에도|은|는|을|를|이|가|도)$', '', token)
        if len(token) > 1 and token not in STOP:
            result.add(token)
    return result


def topics(text):
    lower = text.lower()
    return {name for name, words in TOPICS.items() if any(
        re.search(r'\b'+re.escape(word)+r'\b', lower) if word.isascii() else word in lower
        for word in words)}


class TaskRouter:
    def __init__(self, storage):
        self.storage = storage

    def route(self, project, text):
        explicit = re.match(r'^\s*\[([^\]\n]{1,120})\]', text)
        if explicit and explicit[1].strip():
            return self.result(explicit[1].strip(), '명시한 작업 이름', 'explicit')
        groups = [g for g in self.storage.tasks(project) if g['task'] and g['status'] != 'done']
        history = self.storage.messages(project, None, 60, 0)
        query_tokens, query_topics = tokens(text), topics(text)
        scored = []
        for group in groups:
            title = group['task']
            recent = [m['text'] for m in history if m['task'] == title][:3]
            vocabulary = tokens(title + ' ' + ' '.join(recent))
            group_topics = topics(title + ' ' + ' '.join(recent))
            score = len(query_tokens & vocabulary) + 3 * len(query_topics & group_topics)
            if query_topics and group_topics and not query_topics & group_topics:
                score = 0
            if title.lower() in text.lower():
                score += 10
            if score:
                scored.append((score, title))
        scored.sort(reverse=True)
        if scored and (len(scored) == 1 or scored[0][0] >= scored[1][0] + 2):
            return self.result(scored[0][1], '기존 작업의 주제·최근 대화와 일치', 'matched')
        if scored:
            return self.result('', '여러 작업과 관련되어 작업 선택이 필요합니다.', 'ambiguous', [t for _, t in scored[:5]])
        followup = re.search(r'아까|이거|그거|그건|그럼|그러면|계속|이어서|다음.*(스텝|단계)|continue|that|this', text, re.I)
        if followup and not query_topics:
            active = list(dict.fromkeys(m['task'] for m in history[:6] if m['task'] and any(g['task'] == m['task'] for g in groups)))
            if len(active) == 1:
                return self.result(active[0], '최근 대화의 후속 요청', 'followup')
            return self.result('', '어떤 작업의 후속인지 선택해 주세요.', 'ambiguous', active[:5])
        if len(query_topics) > 1:
            return self.result('', '여러 주제가 포함되어 있습니다. 기록 후 작업을 나누거나 대상을 선택하세요.', 'ambiguous', [])
        if query_topics:
            title = next(iter(query_topics))
        else:
            title = re.sub(r'\s+', ' ', text).strip()[:60]
            if not query_tokens:
                return self.result('', '작업 주제가 불분명하여 미분류로 보관합니다.', 'ambiguous')
        # Do not silently reopen a completed task under an identical key.
        existing = {g['task'] for g in self.storage.tasks(project)}
        candidate, suffix = title, 2
        while candidate in existing:
            candidate = f'{title} ({suffix})'
            suffix += 1
        return self.result(candidate, '새 주제로 작업 생성', 'new')

    @staticmethod
    def result(task, reason, kind, candidates=None):
        return {'task': task, 'reason': reason, 'kind': kind, 'candidates': candidates or [], 'engine': 'local'}
