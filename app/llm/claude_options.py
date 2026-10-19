"""Documented model choices, gated by the installed CLI, without an inference call."""
import os
import re
import subprocess


def claude_version(path):
    flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    try:
        result = subprocess.run([path, '--version'], capture_output=True, encoding='utf-8', errors='replace', timeout=8, **flags)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError('Claude Code 버전을 확인하지 못했습니다. CLI 연결을 확인하고 다시 시도하세요.') from exc
    match = re.search(r'\b(\d+)\.(\d+)\.(\d+)\b', result.stdout) if result.returncode == 0 else None
    return match[0] if match else None


def claude_options(path):
    installed = claude_version(path)
    version = tuple(map(int, installed.split('.'))) if installed else (0, 0, 0)
    # shortcut: Claude has no read-only model/list endpoint; update this documented catalog as models change.
    catalog = [
        ('claude-opus-5-5', 'Opus 5.5', (2, 1, 280), ['low', 'medium', 'high', 'xhigh', 'max']),
        ('claude-sonnet-5-5', 'Sonnet 5.5', (2, 1, 284), ['low', 'medium', 'high', 'xhigh', 'max']),
        ('claude-haiku-5-5', 'Haiku 5.5', (2, 1, 293), ['low', 'medium', 'high', 'xhigh', 'max']),
        ('claude-opus-5', 'Opus 5', (2, 1, 219), ['low', 'medium', 'high', 'xhigh', 'max']),
        ('claude-sonnet-4-6', 'Sonnet 4.6', (2, 1, 45), ['low', 'medium', 'high', 'max']),
        ('opus', 'Opus, CLI 별칭', (0, 0, 0), []),
        ('sonnet', 'Sonnet, CLI 별칭', (0, 0, 0), []),
        ('haiku', 'Haiku, CLI 별칭', (0, 0, 0), []),
    ]
    return {'version': installed, 'ultracode': version >= (2, 1, 284),
            'models': [{'model': model, 'displayName': label, 'available': bool(installed) and version >= minimum,
                        'minimumVersion': '.'.join(map(str, minimum)),
                        'supportedReasoningEfforts': [{'reasoningEffort': effort} for effort in efforts]}
                       for model, label, minimum, efforts in catalog]}
