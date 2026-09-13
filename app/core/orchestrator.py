from app.models.schemas import ContextPart
from app.llm.base import AgentAdapter
from app.core.context_builder import ContextBuilder
from app.core.rule_loader import RuleLoader


class Orchestrator:
    def __init__(self, projects, policy, files, agent: AgentAdapter):
        self.projects, self.policy, self.files, self.agent = projects, policy, files, agent
        self.rules = RuleLoader(policy, files)
        self.context = ContextBuilder()

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

    async def execute(self, name, command):
        root = self.projects.select(name)
        rules = self.rules.load(root, command.cwd)
        selected = [ContextPart(path=p, content=self.read_file(name, p)) for p in dict.fromkeys(command.context_paths)]
        return await self.agent.run(self.context.build(command, rules, selected))

