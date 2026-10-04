"""Persist setup progress without copying native authentication credentials."""
import asyncio
from app.llm.cli import probe


class Onboarding:
    def __init__(self, harness):
        self.harness = harness
        self.lock = asyncio.Lock()

    def read(self):
        return self.harness.storage.onboarding()

    async def select(self, selection):
        async with self.lock:
            if selection.project:
                self.harness.projects.select(selection.project)
            step = 'client' if not selection.client else 'authentication'
            return self.harness.storage.save_onboarding('deferred' if selection.deferred else 'in_progress',
                                                       selection.project, selection.client, step)

    async def check(self):
        async with self.lock:
            state = self.read()
            project, client = state['project'], state['client']
            step, observation = 'client', None
            if client:
                observation = await probe(client, self.harness.storage.client_path(client))
                if observation['state'] == 'installed':
                    step = 'project' if observation.get('auth') == 'ready' else 'authentication'
            if step == 'project' and project:
                try:
                    self.harness.projects.select(project)
                    step = 'complete'
                except (OSError, ValueError):
                    pass
            result = self.harness.storage.save_onboarding('completed' if step == 'complete' else 'in_progress', project, client, step)
            return {**result, 'connection': observation, 'execution_state': 'not_verified'}
