from pathlib import Path
import importlib.util
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('release', Path(__file__).resolve().parents[1] / 'scripts/release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_opencode_adapter_is_in_distribution(self):
        names = {p.relative_to(release.ROOT).as_posix() for p in release.selected()}
        self.assertTrue({'install_opencode.py', 'INSTALL-IN-OPENCODE.md',
                         'opencode/agents/astra-flash-orchestrator.md',
                         'opencode/agents/astra_flash_builder.md'}.issubset(names))

    def test_private_and_backup_files_are_excluded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = ['README.md', 'docs/assets/benchmark.svg', 'skill/tool.py', 'skill/tool.py.before-v1-compat',
                     'skill/routing.json', 'skill/.env', '.git/config', 'dist/old.zip',
                     'skill/__pycache__/cache.py', 'auth.json', 'tests/test_synthetic.py']
            for name in paths:
                p = root / name
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text('fixture')
            names = {p.relative_to(root).as_posix() for p in release.selected(root)}
            self.assertEqual(names, {'README.md', 'docs/assets/benchmark.svg', 'skill/tool.py', 'tests/test_synthetic.py'})

    def test_symlinked_distribution_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'outside.txt').write_text('private')
            (root / 'README.md').symlink_to(root / 'outside.txt')
            with self.assertRaises(ValueError):
                release.selected(root)

    def test_inventory_changes_with_content(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            p = root / 'README.md'
            p.write_text('one')
            before = release.inventory(root)
            p.write_text('two')
            self.assertNotEqual(before, release.inventory(root))
