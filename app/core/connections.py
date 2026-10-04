"""Read-only connection checks; never registers candidates or starts a model turn."""
import asyncio
from datetime import datetime, timezone
from app.llm.cli import probe, executable


def login_instructions(client, configured):
    path = executable(client, configured)
    return {'client': client, 'state': 'user_action_required',
            'argv': [path, 'login'] if client == 'codex' else [path, 'auth', 'login'],
            'recheck': '/api/clients', 'credentials_stored_by': 'native_cli'}


async def check_connections(harness, environment, codex_status):
    clients = await asyncio.gather(*(probe(c, harness.storage.client_path(c)) for c in ('codex', 'claude')))
    projects = []
    for name in harness.projects.list():
        # ProjectManager lists names; resolve through its policy before querying tools.
        try:
            root = harness.projects.select(name)
            projects.append({'project': name, 'environment': await environment.read(root)})
        except (OSError, ValueError):
            projects.append({'project': name, 'state': 'unavailable', 'next_action': 'check_project_path'})
    codex = await asyncio.to_thread(codex_status.read, harness.storage.client_path('codex'))
    attention = []
    for row in clients:
        if row.get('auth') != 'ready':
            attention.append({'scope': row['client'], 'action': row.get('next_action', 'configure_cli')})
    for row in projects:
        if row.get('state') == 'unavailable':
            attention.append({'scope': row['project'], 'action': 'check_project_path'})
        for tool in ('git', 'docker'):
            state = row.get('environment', {}).get(tool, {}).get('state')
            if state and state != 'available':
                attention.append({'scope': row['project'], 'tool': tool, 'action': 'check_environment', 'state': state})
    return {'checked_at': datetime.now(timezone.utc).isoformat(), 'clients': clients,
            'projects': projects, 'codex': codex, 'attention': attention,
            'execution': 'not_started', 'configuration_changed': False}
