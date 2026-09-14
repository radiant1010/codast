from pathlib import Path
from app.models.schemas import ContextPart

COMMON_GUIDE = Path(__file__).resolve().parents[2] / 'docs' / 'development-guide.md'
COMMON_GUIDE_LABEL = 'harness:development-guide.md'


class RuleLoader:
    def __init__(self, policy, files):
        self.policy, self.files = policy, files

    def load(self, root: Path, cwd: str = ".") -> list[ContextPart]:
        directory = self.policy.file_path(root, cwd)
        if not directory.is_dir():
            raise FileNotFoundError("작업 디렉터리를 찾을 수 없습니다.")
        chain = [root]
        current = root
        for part in directory.relative_to(root).parts:
            current /= part
            chain.append(current)
        rules = [ContextPart(path=COMMON_GUIDE_LABEL, content=self.files.read(COMMON_GUIDE))]
        for directory in chain:
            relative = (directory / "RULES.md").relative_to(root).as_posix()
            path = self.policy.file_path(root, relative)
            if path.is_file():
                rules.append(ContextPart(path=relative, content=self.files.read(path)))
        return rules
