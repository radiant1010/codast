import logging

from app.main import create_app


def access(method, path, status):
    return logging.LogRecord('uvicorn.access', logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
                             ('127.0.0.1:5000', method, path, '1.1', status), None)


def test_successful_status_polls_are_hidden_but_failures_and_other_requests_remain(tmp_path):
    create_app(tmp_path / 'workspaces')
    create_app(tmp_path / 'workspaces')
    logger = logging.getLogger('uvicorn.access')
    assert len(logger.filters) == 1
    hidden = [
        ('GET', '/api/session-overview', 200),
        ('GET', '/api/notifications?after=12', 200),
        ('GET', '/api/clients', 200),
        ('GET', '/api/clients/claude/status', 200),
        ('GET', '/api/projects/%EB%8D%B0%EB%AA%A8/environment', 200),
        ('GET', '/api/projects/demo/work-items', 200),
        ('GET', '/api/projects/demo/work-items/w1', 304),
        ('GET', '/api/projects/demo/workflows/s1?connection_id=c1', 200),
    ]
    shown = [
        ('GET', '/api/session-overview', 500),
        ('GET', '/api/notifications?after=0', 404),
        ('GET', '/api/clients/claude/status', 503),
        ('POST', '/api/clients/claude/login', 200),
        ('GET', '/api/projects/demo/workflows', 200),
        ('GET', '/api/projects/demo/workflows/s1/export', 200),
        ('GET', '/api/projects/demo/messages', 200),
        ('GET', '/', 200),
    ]
    assert not any(logger.filter(access(*row)) for row in hidden)
    assert all(logger.filter(access(*row)) for row in shown)
    other = logging.LogRecord('uvicorn.access', logging.INFO, __file__, 1, 'plain message', None, None)
    assert logger.filter(other)
