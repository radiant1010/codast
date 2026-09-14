"""Explicit agent selection; these commands never invoke a shell."""
def parse_command(text):
    stripped = text.strip()
    if not stripped.startswith('/'):
        return None, text
    # Accept newlines and tabs between command and prompt as well.
    parts = stripped.split(maxsplit=1)
    command = parts[0]
    if command not in ('/codex', '/claude'):
        raise ValueError('지원하는 명령은 /codex 요청, /claude 요청입니다.')
    if len(parts) < 2 or not parts[1].strip():
        raise ValueError(f'{command} 뒤에 처리할 요청을 입력하세요.')
    return command[1:], parts[1].strip()
