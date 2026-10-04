from pathlib import Path


def confined(root: Path, relative: str) -> Path:
    """Reject traversal, Windows device/ADS names, and links (including junctions)."""
    p = Path(relative)
    if p.is_absolute() or p.drive or any(c in relative for c in (":", "\\", "\x00")):
        raise PermissionError("Workspace 상대 경로만 사용할 수 있습니다.")
    reserved = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
    current = root
    for part in p.parts:
        if part == ".." or part.endswith((".", " ")) or part.split(".")[0].upper() in reserved:
            raise PermissionError("허용하지 않는 경로입니다.")
        current = current / part
        if current.is_symlink() or current.is_junction():
            raise PermissionError("링크 경로는 지원하지 않습니다.")
    resolved = current.resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise PermissionError("Workspace 밖에 접근할 수 없습니다.")
    return resolved

