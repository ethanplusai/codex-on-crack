from __future__ import annotations
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'skill' / 'astra-flash-orchestrator' / 'scripts'
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(ROOT))
import install
from local_config import (
    ROUTE, ROLE, SKILL, SUPPORTED_ROUTES, SetupError, inspect, model_entries,
    resolve_worker_route,
)
from validate_plan import PlanError, validate


class SetupFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name).resolve()
        self.codex = self.home / '.codex'
        self.codex.mkdir()
        self.config = self.codex / 'config.toml'
        self.config.write_text(
            '# Preserve my exact config and comments.\n'
            'model = "fixture-astra-root"\nmodel_reasoning_effort = "medium"\n'
            'openai_base_url = "http://127.0.0.1:4202/_codex-router/TEST_PRIVATE_CAPABILITY/v1"\n'
            'model_catalog_json = "catalog.json"\n'
            '[model_providers.unused]\nexperimental_bearer_token = "TEST_SECRET_KEY"\n'
        )
        self.catalog = self.codex / 'catalog.json'
        self.catalog.write_text(json.dumps({'models': [{
            'slug': ROUTE, 'multi_agent_version': 'v2', 'default_reasoning_level': 'high',
            'supported_reasoning_levels': [{'effort': 'high'}, {'effort': 'max'}]
        }]}))
        self.policy = self.codex / 'AGENTS.md'
        self.policy.write_text('# Existing instructions\nUse one agent by default.\nPreserve my unrelated notes.\n')
        self.original_config = self.config.read_bytes()
        self.original_policy = self.policy.read_bytes()

    def tearDown(self):
        self.temp.cleanup()

    def cli(self, *args):
        return subprocess.run([sys.executable, str(ROOT / 'install.py'), '--home', str(self.home),
                               '--codex-home', str(self.codex), *args], capture_output=True, text=True)

    def report(self):
        return inspect(self.home, self.codex)[0]

    def set_catalog_route(self, route, multi_agent_version='v2'):
        payload = json.loads(self.catalog.read_text())
        payload['models'][0]['slug'] = route
        payload['models'][0]['multi_agent_version'] = multi_agent_version
        self.catalog.write_text(json.dumps(payload))

    def changes(self, **kwargs):
        return install.plan_changes(self.home, self.codex, self.report(), kwargs.get('policy', True), kwargs.get('replace', False))

    def apply(self):
        report = self.report()
        changes = install.plan_changes(self.home, self.codex, report, True, False)
        return install.apply_changes(changes, self.codex, report['input_hashes'])

    def test_dry_run_changes_nothing_and_redacts_secrets(self):
        before = {str(p): p.read_bytes() for p in self.home.rglob('*') if p.is_file()}
        result = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        after = {str(p): p.read_bytes() for p in self.home.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        self.assertNotIn('TEST_PRIVATE_CAPABILITY', result.stdout + result.stderr)
        self.assertNotIn('TEST_SECRET_KEY', result.stdout + result.stderr)

    def test_install_preserves_config_and_adds_narrow_policy(self):
        result = self.cli('--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_bytes(), self.original_config)
        self.assertTrue(self.policy.read_bytes().startswith(self.original_policy))
        self.assertIn(b'scoped exception', self.policy.read_bytes())
        role = tomllib.loads((self.codex / 'agents' / f'{ROLE}.toml').read_text())
        self.assertEqual(role['model'], ROUTE)
        self.assertEqual(role['model_reasoning_effort'], 'high')
        self.assertFalse(role['agents']['enabled'])
        self.assertNotIn('sandbox_mode', role)
        self.assertNotIn('model_provider', role)
        self.assertIn('No model request was made', result.stdout)

    def test_supported_worker_routes_are_selected_explicitly(self):
        for route, provider in SUPPORTED_ROUTES.items():
            with self.subTest(route=route):
                self.set_catalog_route(route)
                report, _ = inspect(self.home, self.codex, worker_route=route)
                self.assertEqual(report['worker_model'], route)
                self.assertEqual(report['worker_provider'], provider)

    def test_openrouter_route_is_pinned_in_role_and_routing_binding(self):
        route = 'openrouter/deepseek-v4.1-flash'
        self.set_catalog_route(route)
        result = self.cli('--worker-route', route, '--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        role = tomllib.loads((self.codex / 'agents' / f'{ROLE}.toml').read_text())
        self.assertEqual(role['model'], route)
        routing = json.loads(
            (self.home / '.agents' / 'skills' / SKILL / 'routing.json').read_text()
        )
        self.assertEqual(routing['worker_model'], route)
        self.assertEqual(routing['worker_provider'], 'OpenRouter')

    def test_existing_alternate_binding_is_reused_on_update(self):
        route = 'openrouter/deepseek-v4.1-flash'
        self.set_catalog_route(route)
        first = self.cli('--worker-route', route, '--apply')
        self.assertEqual(first.returncode, 0, first.stderr)
        second = self.cli('--apply')
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn('no changes needed', second.stdout)
        role = tomllib.loads((self.codex / 'agents' / f'{ROLE}.toml').read_text())
        self.assertEqual(role['model'], route)

    def test_default_route_does_not_fall_back_to_available_alternate(self):
        self.set_catalog_route('openrouter/deepseek-v4.1-flash')
        result = self.cli()
        self.assertEqual(result.returncode, 2)
        self.assertIn(ROUTE, result.stderr)
        self.assertIn('No provider was substituted', result.stderr)
        self.assertFalse((self.home / '.agents').exists())

    def test_unreviewed_worker_route_is_rejected(self):
        with self.assertRaisesRegex(SetupError, 'Unsupported worker route'):
            inspect(self.home, self.codex, worker_route='custom/deepseek-v4.1-flash')

    def test_planned_writes_never_include_config(self):
        self.assertNotIn(self.config, {change['path'] for change in self.changes()})

    def test_install_excludes_local_backup_and_cache_artifacts(self):
        source = self.home / 'synthetic-skill'
        source.mkdir()
        for name in ['SKILL.md', 'helper.py', 'helper.py.before-v1-compat', '.DS_Store', 'helper.pyc', 'helper.bak']:
            (source / name).write_text('fixture')
        with patch.object(install, 'SKILL_SOURCE', source):
            changes = self.changes()
        names = {change['path'].name for change in changes}
        self.assertIn('helper.py', names)
        self.assertFalse(names & {'helper.py.before-v1-compat', '.DS_Store', 'helper.pyc', 'helper.bak'})

    def test_install_is_idempotent(self):
        self.apply()
        before = {str(p): p.read_bytes() for p in self.home.rglob('*') if p.is_file()}
        result = self.cli('--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        after = {str(p): p.read_bytes() for p in self.home.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        self.assertIn('no changes needed', result.stdout)

    def test_no_policy_option(self):
        result = self.cli('--apply', '--no-policy')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.policy.read_bytes(), self.original_policy)

    def test_existing_override_file_is_the_policy_target(self):
        override = self.codex / 'AGENTS.override.md'
        override.write_text('Keep this active override.\n')
        self.apply()
        self.assertIn(install.BEGIN, override.read_bytes())
        self.assertEqual(self.policy.read_bytes(), self.original_policy)

    def test_install_does_not_require_global_subagent_default(self):
        result = self.cli('--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_bytes(), self.original_config)

    def test_different_global_subagent_default_is_ignored(self):
        self.config.write_text(self.config.read_text() + '\n[agents]\ndefault_subagent_model = "fixture-other-model"\n')
        original = self.config.read_bytes()
        result = self.cli('--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_bytes(), original)
        self.assertIn('global default_subagent_model is not used or changed', result.stdout)
        role = tomllib.loads((self.codex / 'agents' / f'{ROLE}.toml').read_text())
        self.assertEqual(role['model'], ROUTE)

    def test_missing_catalog_route_fails(self):
        self.catalog.write_text('{"models": []}')
        with self.assertRaises(SetupError):
            self.report()

    def test_non_spawnable_catalog_route_blocks_install(self):
        payload = json.loads(self.catalog.read_text())
        for value in ['v1', None]:
            with self.subTest(version=value):
                payload['models'][0]['multi_agent_version'] = value
                self.catalog.write_text(json.dumps(payload))
                result = self.cli('--apply')
                self.assertEqual(result.returncode, 2)
                self.assertIn('not advertised for native subagents', result.stderr)
                self.assertFalse((self.home / '.agents').exists())
                self.assertEqual(self.config.read_bytes(), self.original_config)

    def test_non_spawnable_alternate_route_blocks_install_without_paid_probe_advice(self):
        route = 'openrouter/deepseek-v4.1-flash'
        self.set_catalog_route(route, 'v1')
        result = self.cli('--worker-route', route, '--apply')
        self.assertEqual(result.returncode, 2)
        self.assertIn(route, result.stderr)
        self.assertIn('Do not run subagents certify', result.stderr)
        self.assertFalse((self.home / '.agents').exists())

    def test_flash_root_is_rejected_for_every_supported_provider(self):
        route = 'openrouter/deepseek-v4.1-flash'
        self.set_catalog_route(route)
        self.config.write_text(self.config.read_text().replace('fixture-astra-root', route))
        with self.assertRaisesRegex(SetupError, 'root model is Flash'):
            inspect(self.home, self.codex, worker_route=route)

    def test_non_loopback_route_fails_without_exposing_url(self):
        self.config.write_text(self.config.read_text().replace('127.0.0.1', 'private.remote.test'))
        result = self.cli()
        self.assertEqual(result.returncode, 2)
        self.assertNotIn('TEST_PRIVATE_CAPABILITY', result.stdout + result.stderr)

    def test_native_direct_v1_route_is_supported(self):
        self.config.write_text(self.config.read_text().replace('/_codex-router/TEST_PRIVATE_CAPABILITY/v1', '/v1'))
        original = self.config.read_bytes()
        self.assertEqual(self.report()['worker_model'], ROUTE)
        result = self.cli('--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_bytes(), original)

    def test_invalid_router_url_shapes_fail_closed(self):
        original = self.config.read_text()
        valid = 'http://127.0.0.1:4202/_codex-router/TEST_PRIVATE_CAPABILITY/v1'
        for url in ['http://example.invalid/v1', 'http://127.0.0.1:4202/arbitrary/v1',
                    'http://127.0.0.1:4202/v1?secret=TEST_PRIVATE_CAPABILITY',
                    'http://127.0.0.1:4202/v1#secret', 'http://user:secret@127.0.0.1:4202/v1',
                    'file:///v1', 'http://127.0.0.1:4202/_codex-router/a/extra/v1']:
            with self.subTest(url=url):
                self.config.write_text(original.replace(valid, url))
                with self.assertRaises(SetupError):
                    self.report()

    def test_existing_backup_directory_permissions_preserved(self):
        backup = self.codex / 'astra-flash-install-backups'
        backup.mkdir(mode=0o750)
        before = backup.stat().st_mode
        self.apply()
        self.assertEqual(backup.stat().st_mode, before)

    def test_malformed_toml_does_not_echo_secret(self):
        self.config.write_text('token = "TEST_SECRET_KEY\n')
        result = self.cli()
        self.assertEqual(result.returncode, 2)
        self.assertNotIn('TEST_SECRET_KEY', result.stdout + result.stderr)

    def test_disabled_subagents_fail_closed(self):
        self.config.write_text(self.config.read_text() + '\n[agents]\nenabled = false\n')
        with self.assertRaises(SetupError):
            self.report()

    def test_misplaced_top_level_setting_under_agents_gets_actionable_error(self):
        self.config.write_text(
            '# A misplaced table header makes the following URL part of agents.\n'
            '[agents]\ndefault_subagent_model = "fixture-other-model"\n'
            'openai_base_url = "http://127.0.0.1:4202/v1"\n'
            'model_catalog_json = "catalog.json"\n'
        )
        with self.assertRaisesRegex(SetupError, r'do not belong under \[agents\].*openai_base_url'):
            self.report()

    def test_absorbed_key_is_caught_by_shape_not_by_a_known_name_list(self):
        # Regression for a real incident: an agent satisfying an older installer
        # prerequisite appended [agents] to config.toml, which absorbed the two
        # top-level realtime keys that followed it. Codex refused to load the
        # config, taking down the host app and the CLI. Neither key is a
        # plausible member of a list of anticipated top-level names, so the
        # guard has to reject them on shape.
        self.config.write_text(
            'model = "fixture-astra-root"\n'
            'openai_base_url = "http://127.0.0.1:4202/v1"\n'
            'model_catalog_json = "catalog.json"\n'
            '[agents]\n'
            'default_subagent_model = "fixture-other-model"\n'
            'experimental_realtime_webrtc_call_base_url = "https://example.invalid/backend-api/codex"\n'
            'experimental_realtime_ws_base_url = "https://example.invalid/v1"\n'
        )
        with self.assertRaisesRegex(
            SetupError,
            r'experimental_realtime_webrtc_call_base_url, experimental_realtime_ws_base_url',
        ):
            self.report()

    def test_recognized_agent_settings_and_role_tables_are_accepted(self):
        # The guard must not fire on a legitimate [agents] table: Codex accepts
        # these scalars there, and any other key is an agent name owning a table.
        self.config.write_text(
            self.config.read_text()
            + '[agents]\n'
            'enabled = true\n'
            'default_subagent_model = "fixture-other-model"\n'
            'default_subagent_reasoning_effort = "high"\n'
            'max_concurrent_threads_per_session = 6\n'
            'max_depth = 2\n'
            'job_max_runtime_seconds = 600\n'
            f'[agents.{ROLE}]\n'
            'description = "fixture role"\n'
        )
        self.assertEqual(self.report()['status'], 'static-ready')

    def test_documented_interrupt_and_legacy_thread_settings_are_accepted(self):
        original = self.config.read_text()
        for setting in ('interrupt_message = false', 'max_threads = 4'):
            with self.subTest(setting=setting):
                self.config.write_text(original + f'[agents]\n{setting}\n')
                self.assertEqual(self.report()['status'], 'static-ready')

    def test_agent_name_holding_a_scalar_is_rejected(self):
        # An agent name must own a role table; a bare scalar is the exact shape
        # Codex rejects with "expected struct AgentRoleToml".
        self.config.write_text(
            self.config.read_text() + '[agents]\nastra_flash_builder = "not-a-table"\n'
        )
        with self.assertRaisesRegex(SetupError, r'do not belong under \[agents\].*astra_flash_builder'):
            self.report()

    def test_standalone_profile_is_read_without_modifying_it(self):
        profile = self.codex / 'work.config.toml'
        profile.write_text('model = "fixture-profile-astra"\nmodel_reasoning_effort = "high"\n')
        result, _ = inspect(self.home, self.codex, 'work')
        self.assertEqual(result['root_model_observed'], 'fixture-profile-astra')
        self.assertEqual(result['worker_model'], ROUTE)
        self.assertEqual(self.config.read_bytes(), self.original_config)

    def test_ambiguous_profiles_fail(self):
        self.config.write_text(self.config.read_text() + '\n[profiles.work]\nmodel = "fixture-old"\n')
        (self.codex / 'work.config.toml').write_text('model = "fixture-new"\n')
        with self.assertRaises(SetupError):
            inspect(self.home, self.codex, 'work')

    def test_global_worker_effort_is_ignored(self):
        self.config.write_text(self.config.read_text() + '\n[agents]\ndefault_subagent_reasoning_effort = "medium"\n')
        original = self.config.read_bytes()
        report = self.report()
        self.assertEqual(report['worker_effort'], 'high')
        self.assertEqual(self.config.read_bytes(), original)

    def test_existing_foreign_content_requires_explicit_replace(self):
        folder = self.home / '.agents' / 'skills' / SKILL
        folder.mkdir(parents=True)
        (folder / 'SKILL.md').write_text('My existing custom content\n')
        with self.assertRaises(SetupError):
            self.changes()
        self.assertTrue(self.changes(replace=True))

    def test_symlink_destination_is_refused(self):
        external = self.home / 'external'
        external.mkdir()
        (self.home / '.agents').symlink_to(external, target_is_directory=True)
        with self.assertRaises(SetupError):
            self.changes()

    def test_legacy_same_name_installation_is_detected(self):
        (self.codex / 'skills' / SKILL).mkdir(parents=True)
        with self.assertRaises(SetupError):
            self.changes()

    def test_undo_restores_original_policy_and_removes_new_files(self):
        receipt = self.apply()
        result = self.cli('--undo', str(receipt), '--apply')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.policy.read_bytes(), self.original_policy)
        self.assertEqual(self.config.read_bytes(), self.original_config)
        self.assertFalse((self.codex / 'agents' / f'{ROLE}.toml').exists())
        self.assertFalse((self.home / '.agents' / 'skills' / SKILL).exists())

    def test_undo_preserves_subsequent_user_edits_by_refusing(self):
        receipt = self.apply()
        self.policy.write_text(self.policy.read_text() + 'A later note.\n')
        changed = self.policy.read_bytes()
        result = self.cli('--undo', str(receipt), '--apply')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.policy.read_bytes(), changed)
        self.assertTrue((self.codex / 'agents' / f'{ROLE}.toml').exists())

    def test_install_rolls_back_completed_writes_on_error(self):
        report = self.report()
        changes = self.changes()
        target = changes[1]['path']
        real = install.atomic_write
        fired = False
        def failing_write(path, data, mode=0o600):
            nonlocal fired
            if path == target and not fired:
                fired = True
                raise OSError('Synthetic write failure')
            return real(path, data, mode)
        with patch.object(install, 'atomic_write', side_effect=failing_write):
            with self.assertRaises(OSError):
                install.apply_changes(changes, self.codex, report['input_hashes'])
        for change in changes:
            self.assertEqual(install.contents(change['path']), change['before'])
        self.assertEqual(self.config.read_bytes(), self.original_config)

    def test_receipt_path_traversal_is_refused(self):
        receipt = self.apply()
        record = json.loads(receipt.read_text())
        record['files'][0]['path'] = str(self.home / '.agents' / 'skills' / SKILL / '..' / '..' / '..' / '.codex' / 'config.toml')
        receipt.write_text(json.dumps(record))
        result = self.cli('--undo', str(receipt), '--apply')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(self.config.read_bytes(), self.original_config)

    def test_local_doctor_uses_only_models_get_without_exposing_capability(self):
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer
        seen = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.path)
                body = json.dumps({'data': [{'id': 'openrouter/deepseek-v4.1-flash'}]}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *args):
                pass
        server = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            route = 'openrouter/deepseek-v4.1-flash'
            self.set_catalog_route(route)
            self.config.write_text(self.config.read_text().replace(':4202/', f':{server.server_port}/'))
            result = subprocess.run([sys.executable, str(SCRIPTS / 'doctor.py'), '--home', str(self.home),
                                     '--codex-home', str(self.codex), '--worker-route', route,
                                     '--check-local-router'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(seen, ['/_codex-router/TEST_PRIVATE_CAPABILITY/v1/models'])
            self.assertNotIn('TEST_PRIVATE_CAPABILITY', result.stdout + result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report['worker_model'], route)
            self.assertFalse(report['runtime_verified'])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_config_changed_after_preflight_is_detected(self):
        report = self.report()
        changes = self.changes()
        self.config.write_text(self.config.read_text() + '# Changed by another process\n')
        with self.assertRaises(SetupError):
            install.apply_changes(changes, self.codex, report['input_hashes'])


class PolicyTests(unittest.TestCase):
    def test_worker_route_resolution_defaults_and_reuses_valid_binding(self):
        self.assertEqual(resolve_worker_route(), ROUTE)
        with tempfile.TemporaryDirectory() as directory:
            binding = Path(directory).resolve() / 'routing.json'
            route = 'openrouter/deepseek-v4.1-flash'
            binding.write_text(json.dumps({'worker_model': route}))
            self.assertEqual(resolve_worker_route(binding=binding), route)
            self.assertEqual(resolve_worker_route(ROUTE, binding), ROUTE)

    def test_worker_route_resolution_rejects_malformed_or_unreviewed_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            binding = Path(directory).resolve() / 'routing.json'
            binding.write_text('{broken')
            with self.assertRaises(SetupError):
                resolve_worker_route(binding=binding)
            binding.write_text(json.dumps({'worker_model': 'custom/deepseek-v4.1-flash'}))
            with self.assertRaisesRegex(SetupError, 'Unsupported worker route'):
                resolve_worker_route(binding=binding)

    def test_worker_route_resolution_refuses_symlinked_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            target = root / 'target.json'
            target.write_text(json.dumps({'worker_model': ROUTE}))
            binding = root / 'routing.json'
            binding.symlink_to(target)
            with self.assertRaisesRegex(SetupError, 'symlinked routing binding'):
                resolve_worker_route(binding=binding)

    def test_crlf_and_unrelated_text_are_preserved(self):
        block = install.BEGIN + b'\nnew\n' + install.END + b'\n'
        old = b'prefix\r\n' + install.BEGIN + b'\r\nold\r\n' + install.END + b'\r\nsuffix\r\n'
        updated = install.managed_policy(old, block)
        self.assertTrue(updated.startswith(b'prefix\r\n'))
        self.assertTrue(updated.endswith(b'suffix\r\n'))
        self.assertEqual(updated.count(install.BEGIN), 1)
        self.assertIn(b'new\r\n', updated)

    def test_malformed_markers_are_refused(self):
        with self.assertRaises(SetupError):
            install.managed_policy(install.BEGIN, b'new')

    def test_redirect_refused_before_forwarding(self):
        from doctor import NoRedirect
        with self.assertRaises(SetupError):
            NoRedirect().redirect_request(None, None, 302, 'Found', {}, 'https://example.invalid/secret')

    def test_catalog_shapes(self):
        for payload in ([{'id': ROUTE}], {'data': [{'id': ROUTE}]}, {'models': [{'slug': ROUTE}]}):
            self.assertEqual(len(model_entries(payload)), 1)
        with self.assertRaises(SetupError):
            model_entries({'not_models': []})


class PlanTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / 'tasks').mkdir()
        (self.root / 'spec.md').write_text('# Test specification')
        (self.root / 'tasks/T1.md').write_text('# Test task')
        self.plan = {'schema_version': 1, 'project': 'Plan validation fixture', 'spec': 'spec.md', 'max_flash_workers': 1, 'phases': [{'id': 'P1', 'goal': 'Validate scoped work', 'depends_on': [], 'integration_checks': [{'command': 'python3 -m unittest discover -s tests', 'expected': 'All repository tests pass in the hypothetical application'}]}], 'tasks': [{'id': 'T1', 'phase': 'P1', 'executor': 'flash', 'risk': 'normal', 'state': 'planned', 'depends_on': [], 'brief': 'tasks/T1.md', 'allowed_paths': ['src/items/filtering.py', 'tests/test_filtering.py'], 'acceptance': ['Matches the chosen status while preserving order', 'Invalid status raises ValueError', 'Input collection is not mutated'], 'checks': [{'command': 'python3 -m unittest', 'expected': 'Tests pass'}]}]}

    def test_fixture_is_structurally_valid(self):
        self.assertEqual(validate(self.plan, self.root)['status'], 'structure-valid')

    def test_placeholder_is_rejected(self):
        self.plan['tasks'][0]['acceptance'] = ['TODO']
        with self.assertRaises(PlanError):
            validate(self.plan, self.root)

    def test_missing_brief_is_rejected(self):
        self.plan['tasks'][0]['brief'] = 'missing.md'
        with self.assertRaises(PlanError):
            validate(self.plan, self.root)

    def test_unbounded_file_scope_is_rejected(self):
        for path in ['.', '../outside', '/absolute', 'src/**', '.git/config']:
            self.plan['tasks'][0]['allowed_paths'] = [path]
            with self.assertRaises(PlanError):
                validate(self.plan, self.root)

    def test_sensitive_task_cannot_be_assigned_to_flash(self):
        self.plan['tasks'][0]['risk'] = 'sensitive'
        with self.assertRaises(PlanError):
            validate(self.plan, self.root)

    def add_task(self):
        task = copy.deepcopy(self.plan['tasks'][0])
        task['id'] = 'T2'
        task['allowed_paths'] = ['src/other.py', 'tests/test_other.py']
        self.plan['tasks'].append(task)
        return task

    def test_dependency_cycle_is_rejected(self):
        second = self.add_task()
        second['depends_on'] = ['T1']
        self.plan['tasks'][0]['depends_on'] = ['T2']
        with self.assertRaises(PlanError):
            validate(self.plan, self.root)

    def test_duplicate_id_is_rejected(self):
        self.add_task()['id'] = 'T1'
        with self.assertRaises(PlanError):
            validate(self.plan, self.root)

    def test_parallel_independent_scopes_are_accepted(self):
        self.add_task()
        self.plan['max_flash_workers'] = 2
        for task in self.plan['tasks']:
            task['parallel_group'] = 'G1'
        validate(self.plan, self.root)

    def test_parallel_overlap_is_rejected(self):
        self.add_task()['allowed_paths'] = ['src/items/']
        self.plan['max_flash_workers'] = 2
        for task in self.plan['tasks']:
            task['parallel_group'] = 'G1'
        with self.assertRaises(PlanError):
            validate(self.plan, self.root)

    def test_parallel_dependency_is_rejected(self):
        self.add_task()['depends_on'] = ['T1']
        self.plan['max_flash_workers'] = 2
        for task in self.plan['tasks']:
            task['parallel_group'] = 'G1'
        with self.assertRaises(PlanError):
            validate(self.plan, self.root)

    def test_cross_phase_dependency_must_be_declared(self):
        second = self.add_task()
        self.plan['phases'].append({'id': 'P2', 'goal': 'Second milestone', 'depends_on': ['P1'],
                                  'integration_checks': [{'command': 'python3 -m unittest', 'expected': 'Tests pass'}]})
        second['phase'] = 'P2'
        self.plan['tasks'][0]['depends_on'] = ['T2']
        with self.assertRaises(PlanError):
            validate(self.plan, self.root)

    def test_excessive_parallelism_is_rejected(self):
        self.plan['max_flash_workers'] = 99
        with self.assertRaises(PlanError):
            validate(self.plan, self.root)


if __name__ == '__main__':
    unittest.main()
