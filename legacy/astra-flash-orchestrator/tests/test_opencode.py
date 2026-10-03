from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import install
import install_opencode as opencode

MODEL = 'fixture-provider/vendor/flash-model:free'


class OpenCodeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.config = self.root / 'config'
        self.config.mkdir()
        self.builder = self.config / 'agents' / f'{opencode.BUILDER}.md'
        self.primary = self.config / 'agents' / f'{opencode.PRIMARY}.md'
        self.private = self.config / 'opencode.jsonc'
        self.private.write_text('// Preserve comments and configuration\n{"token":"TEST_SECRET"}\n')

    def tearDown(self):
        self.temp.cleanup()

    def cli(self, *args):
        return subprocess.run([sys.executable, '-B', str(ROOT / 'install_opencode.py'),
                               '--config-dir', str(self.config), *args], capture_output=True, text=True)

    def snapshot(self):
        return {str(p.relative_to(self.root)): p.read_bytes()
                for p in self.root.rglob('*') if p.is_file()}

    def apply(self):
        return install.apply_changes(opencode.plan_changes(self.config, MODEL, False), self.config, {})

    def test_preview_is_offline_and_changes_nothing(self):
        before = self.snapshot()
        result = self.cli('--worker-model', MODEL)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(before, self.snapshot())
        self.assertNotIn('TEST_SECRET', result.stdout + result.stderr)
        self.assertIn('Routing unverified', result.stdout)

    def test_first_install_requires_explicit_model(self):
        before = self.snapshot()
        result = self.cli('--apply')
        self.assertEqual(result.returncode, 2)
        self.assertIn('--worker-model', result.stderr)
        self.assertEqual(before, self.snapshot())

    def test_install_preserves_settings_and_renders_native_agents(self):
        original = self.private.read_bytes()
        result = self.cli('--worker-model', MODEL, '--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(original, self.private.read_bytes())
        primary = self.primary.read_text()
        worker = self.builder.read_text()
        self.assertIn('mode: primary', primary)
        self.assertNotIn('\nmodel:', primary.split('---')[1])
        self.assertIn('"*": deny\n    astra_flash_builder: allow', primary)
        self.assertIn('mode: subagent', worker)
        self.assertIn('model: ' + json.dumps(MODEL), worker)
        self.assertIn('  task: deny', worker)
        self.assertIn('You are the implementation worker', worker)
        self.assertNotIn('{{', worker)
        self.assertFalse((self.config / 'AGENTS.md').exists())
        self.assertIn('No model request was made', result.stdout)

    def test_repeat_install_reuses_route_and_is_idempotent(self):
        self.apply()
        before = self.snapshot()
        result = self.cli('--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('no changes needed', result.stdout)
        self.assertEqual(before, self.snapshot())

    def test_replacement_requires_flag_and_undo_restores_previous_model(self):
        self.apply()
        previous = self.builder.read_bytes()
        result = self.cli('--worker-model', 'other-provider/flash', '--apply')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(previous, self.builder.read_bytes())
        changes = opencode.plan_changes(self.config, 'other-provider/flash', True)
        receipt = install.apply_changes(changes, self.config, {})
        result = self.cli('--undo', str(receipt), '--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(previous, self.builder.read_bytes())

    def test_undo_preview_then_remove_only_owned_files(self):
        receipt = self.apply()
        unrelated = self.config / 'agents' / 'other.md'
        unrelated.write_text('user agent')
        before = self.snapshot()
        result = self.cli('--undo', str(receipt))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(before, self.snapshot())
        result = self.cli('--undo', str(receipt), '--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.builder.exists())
        self.assertFalse(self.primary.exists())
        self.assertEqual('user agent', unrelated.read_text())
        self.assertTrue(self.private.exists())

    def test_undo_refuses_later_edits_without_partial_restore(self):
        receipt = self.apply()
        self.builder.write_text(self.builder.read_text() + '\nMy edits\n')
        before = self.snapshot()
        result = self.cli('--undo', str(receipt), '--apply')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(before, self.snapshot())

    def test_undo_refuses_receipt_target_outside_exact_agents(self):
        receipt = self.apply()
        record = json.loads(receipt.read_text())
        record['files'][0]['path'] = str(self.private)
        record['files'][0]['after_hash'] = install.digest(self.private.read_bytes())
        receipt.write_text(json.dumps(record))
        before = self.snapshot()
        result = self.cli('--undo', str(receipt), '--apply')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(before, self.snapshot())

    def test_symlinked_agent_directory_is_rejected(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (self.config / 'agents').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(install.SetupError):
            opencode.plan_changes(self.config, MODEL, False)
        self.assertEqual([], list(outside.iterdir()))

    def test_location_precedence(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(Path, 'home', return_value=self.root):
            self.assertEqual(opencode.config_directory(None, None), self.root / '.config' / 'opencode')
            with patch.dict(os.environ, {'XDG_CONFIG_HOME': str(self.root / 'xdg')}):
                self.assertEqual(opencode.config_directory(None, None), self.root / 'xdg' / 'opencode')
                with patch.dict(os.environ, {'OPENCODE_CONFIG_DIR': str(self.root / 'custom')}):
                    self.assertEqual(opencode.config_directory(None, None), self.root / 'custom')
                    self.assertEqual(opencode.config_directory(None, str(self.config)), self.config)
                    self.assertEqual(opencode.config_directory(str(self.root / 'repo'), None),
                                     self.root / 'repo' / '.opencode')

    def test_project_install_and_undo_use_project_location(self):
        project = self.root / 'project'
        command = [sys.executable, '-B', str(ROOT / 'install_opencode.py'), '--project', str(project)]
        result = subprocess.run(command + ['--worker-model', MODEL, '--apply'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt, = (project / '.opencode' / 'astra-flash-install-backups').glob('*/receipt.json')
        result = subprocess.run(command + ['--undo', str(receipt), '--apply'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([], list((project / '.opencode' / 'agents').iterdir()))

    def test_invalid_model_input_does_not_change_files(self):
        before = self.snapshot()
        for model in ('bare-name', 'https://host/model', 'provider/model\npermission: allow',
                      'provider/model key', 'provider/../model', 'provider//model', 'provider/key@host'):
            with self.subTest(model=model), self.assertRaises(install.SetupError):
                opencode.plan_changes(self.config, model, False)
        self.assertEqual(before, self.snapshot())

    def test_apply_rolls_back_when_second_agent_write_fails(self):
        changes = opencode.plan_changes(self.config, MODEL, False)
        original_write = install.atomic_write

        def failing_write(path, data, mode=0o600):
            if path == self.builder:
                raise OSError('synthetic write failure')
            return original_write(path, data, mode)

        with patch.object(install, 'atomic_write', side_effect=failing_write), self.assertRaises(OSError):
            install.apply_changes(changes, self.config, {})
        self.assertFalse(self.primary.exists())
        self.assertFalse(self.builder.exists())
        receipt, = (self.config / 'astra-flash-install-backups').glob('*/receipt.json')
        self.assertEqual(json.loads(receipt.read_text())['status'], 'rolled-back')


if __name__ == '__main__':
    unittest.main()
