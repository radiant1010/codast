"""Bounded, read-only Claude Code transcript previews, scoped by recorded cwd."""
import json
import os
from pathlib import Path
from uuid import UUID
from app.core.transcript import display_message


def transcript_root():
    return Path(os.environ.get('CLAUDE_CONFIG_DIR', str(Path.home() / '.claude'))) / 'projects'


def read_file(path, root):
    if path.is_symlink() or path.parent.is_symlink() or path.parent.is_junction():
        return None
    if path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError('Claude 세션이 16 MiB 조회 한도를 초과했습니다.')
    messages = []
    matched = False
    updated = None
    with path.open(encoding='utf-8') as source:
        for line in source:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if not isinstance(row, dict) or row.get('isSidechain'):
                continue
            if row.get('cwd'):
                if Path(row['cwd']).resolve() != Path(root).resolve():
                    return None
                matched = True
            if row.get('sessionId') and row['sessionId'] != path.stem:
                return None
            if row.get('type') not in ('user', 'assistant'):
                continue
            content = (row.get('message') or {}).get('content', [])
            if isinstance(content, list):
                content = '\n'.join(b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text')
            if isinstance(content, str) and content:
                messages.append(display_message(row['type'], content))
                messages = messages[-20:]
                updated = row.get('timestamp')
    if not matched:
        return None
    return {'id': path.stem, 'name': None, 'preview': messages[0]['text'][:100] if messages else '',
            'cwd': str(root), 'updatedAt': updated, 'messages': messages,
            'live_state': 'unknown', 'preview_scope': '최근 최대 20메시지, 메시지당 8000자 · Claude Code 로컬 기록'}


def candidates():
    base = transcript_root()
    if base.is_symlink() or base.is_junction():
        raise PermissionError('링크된 세션 저장소는 조회하지 않습니다.')
    files = []
    for path in base.glob('*/*.jsonl'):
        if len(files) >= 1000:
            raise ValueError('Claude 세션 조회 한도(1000개)를 초과했습니다.')
        try:
            UUID(path.stem)
        except ValueError:
            continue
        files.append(path)
    return sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)


def list_threads(root, configured='', cursor=None):
    offset = int(cursor or 0)
    if offset < 0 or offset > 1000:
        raise ValueError('잘못된 목록 위치입니다.')
    rows = []
    for path in candidates():
        row = read_file(path, root)
        if row:
            row.pop('messages')
            rows.append(row)
    return {'threads': rows[offset:offset+20], 'next_cursor': str(offset+20) if len(rows) > offset+20 else None}


def read_thread(root, identity, configured='', include_turns=True):
    identity = str(UUID(identity))
    for path in candidates():
        if path.stem == identity:
            row = read_file(path, root)
            if row:
                if not include_turns:
                    row.pop('messages')
                return row
    raise FileNotFoundError('이 프로젝트의 Claude Code 세션을 찾을 수 없습니다.')
