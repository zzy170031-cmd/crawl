"""Reproducible WorkBuddy upload archive; only repository Skill resources."""
import hashlib
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent

def package(root=ROOT):
    root = Path(root).resolve()
    skill = root / 'skills' / 'douyin-hotspot-game-creation'
    files = sorted(skill.rglob('*'))
    if not (skill / 'SKILL.md').is_file():
        raise ValueError('Missing Skill entry')
    entries = []
    for file in files:
        if file.is_symlink():
            raise ValueError('Symlinks are not distributable')
        if not file.is_file():
            continue
        if file.suffix not in {'.md', '.yaml', '.mjs', '.py'} or any(p.startswith('.') for p in file.relative_to(skill).parts):
            raise ValueError('Unexpected file in Skill package')
        entries.append((file.relative_to(skill.parent).as_posix(), file.read_bytes()))
    output = root / 'dist' / 'douyin-hotspot-game-creation-workbuddy.zip'
    output.parent.mkdir(exist_ok=True)
    temporary = output.with_suffix('.tmp')
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, body in entries:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, body)
    temporary.replace(output)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix('.zip.sha256').write_text(digest + '  ' + output.name + '\n', encoding='utf-8')
    return {'archive': str(output), 'files': len(entries), 'sha256': digest}

if __name__ == '__main__':
    import json
    print(json.dumps(package(), ensure_ascii=False))
