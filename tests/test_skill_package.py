"""Synthetic clean-install archive test, no network or user data."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('package_skill', Path(__file__).resolve().parents[1] / 'scripts' / 'package_skill.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class PackageTests(unittest.TestCase):
    def test_reproducible_and_only_skill(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            skill = root / 'skills' / 'douyin-hotspot-game-creation'
            skill.mkdir(parents=True)
            (skill / 'SKILL.md').write_text('---\nname: demo\n---\n', encoding='utf-8')
            (root / '.env').write_text('SECRET=not-for-distribution')
            (root / 'data').mkdir()
            (root / 'data' / 'credentials.json').write_text('private')
            first = module.package(root)
            second = module.package(root)
            self.assertEqual(first['sha256'], second['sha256'])
            with zipfile.ZipFile(first['archive']) as archive:
                self.assertEqual(archive.namelist(), ['douyin-hotspot-game-creation/SKILL.md'])
                self.assertNotIn(b'not-for-distribution', archive.read(archive.namelist()[0]))

    def test_unexpected_or_linked_resources_reject(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            skill = root / 'skills' / 'douyin-hotspot-game-creation'
            skill.mkdir(parents=True)
            (skill / 'SKILL.md').write_text('skill')
            (skill / 'secret.env').write_text('secret')
            with self.assertRaises(ValueError):
                module.package(root)
            (skill / 'secret.env').unlink()
            target = root / 'outside.md'
            target.write_text('private')
            try:
                (skill / 'linked.md').symlink_to(target)
            except OSError:
                return  # platform does not grant symlink rights
            with self.assertRaises(ValueError):
                module.package(root)

if __name__ == '__main__':
    unittest.main()
