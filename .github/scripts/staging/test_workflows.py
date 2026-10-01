"""Security and admission contracts for the private staging pipeline."""
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[3]

def workflow(name):
    return yaml.load((ROOT / '.github/workflows' / name).read_text(), Loader=yaml.BaseLoader)

class StagingWorkflowContracts(unittest.TestCase):
    def test_private_checks_target_staging_and_do_not_skip_private_prs(self):
        for name in ['type-check.yml', 'unit-tests.yml', 'code-quality.yml', 'security.yml', 'changeset-check.yml', 'dco.yml', 'migration-safety.yml', 'temporal-replay-pr-check.yml', 'temporal-replay-validation.yml', 'db-integration.yml', 'knip.yml', 'docker-build-check.yml']:
            with self.subTest(name=name):
                data = workflow(name)
                event = 'pull_request_target' if name == 'temporal-replay-validation.yml' else 'pull_request'
                self.assertIn('staging', data['on'][event]['branches'])
                for job in data['jobs'].values():
                    self.assertNotIn("github.repository != 'Fabric-Pro/fabric-dev'", job.get('if', ''))

    def test_private_snapshots_are_gated_and_never_use_public_registry(self):
        data = workflow('private-staging-images.yml')
        self.assertEqual(data['on']['push']['branches'], ['staging', 'promotion/**'])
        for job in data['jobs'].values():
            self.assertIn("vars.STAGING_RELEASE_ENABLED == 'true'", job['if'])
            self.assertIn("github.repository == 'Fabric-Pro/fabric-dev'", job['if'])
        text = (ROOT / '.github/workflows/private-staging-images.yml').read_text()
        self.assertNotIn('fabric-oss-snapshots', text)
        self.assertNotIn('fabric-oss-buildcache', text)
        build = data['jobs']['build']
        steps = build['steps']
        helper = 'node .github/actions/oss-snapshot/package-registry-manifest.mjs'
        privacy_steps = [step for step in steps if helper in step.get('run', '')]
        self.assertEqual(len(privacy_steps), 1)
        privacy = privacy_steps[0]
        expected_env = {
            'GH_TOKEN': '${{ github.token }}',
            'COMPONENT': '${{ matrix.component }}',
            'PRIVATE_STAGING_PACKAGE_BINDINGS': '${{ vars.PRIVATE_STAGING_PACKAGE_BINDINGS }}',
            'SOURCE_REPOSITORY': '${{ github.repository }}',
            'SOURCE_REPOSITORY_ID': '${{ github.repository_id }}',
        }
        for key, value in expected_env.items():
            with self.subTest(env=key):
                self.assertEqual(privacy['env'].get(key), value)
        self.assertIn('set -euo pipefail', privacy['run'])
        self.assertIn('for namespace in fabric-dev-snapshots fabric-dev-buildcache; do', privacy['run'])
        self.assertIn('PACKAGE=$(gh api "orgs/Fabric-Pro/packages/container/${namespace}%2F${COMPONENT}")', privacy['run'])
        self.assertIn('"${namespace}/${COMPONENT}" <<<"$PACKAGE"', privacy['run'])
        self.assertNotIn('|| true', privacy['run'])
        self.assertNotIn('continue-on-error', privacy)
        self.assertNotIn('if', privacy)
        privacy_index = steps.index(privacy)
        login_index = next(index for index, step in enumerate(steps) if step.get('uses', '').startswith('docker/login-action@'))
        publish_index = next(index for index, step in enumerate(steps) if step.get('id') == 'build')
        self.assertLess(privacy_index, login_index)
        self.assertLess(privacy_index, publish_index)
        # The validator unit cases prove live private visibility and exact identity;
        # this contract proves that the publishing workflow runs those checks.
        self.assertEqual(build['needs'], 'policy-tests')
        self.assertTrue(any(step.get('run') == 'node --test .github/actions/oss-snapshot/*manifest.test.mjs' for step in data['jobs']['policy-tests']['steps']))

    def test_notifier_never_executes_product_content(self):
        data = workflow('private-staging-notify.yml')
        self.assertEqual(data['on']['push']['branches'], ['master'])
        self.assertEqual(data['permissions'], {'contents': 'read'})
        for job in data['jobs'].values():
            self.assertIn("vars.STAGING_RELEASE_ENABLED == 'true'", job['if'])
            for step in job['steps']:
                self.assertNotIn('actions/checkout', step.get('uses', ''))
                self.assertNotIn('download-artifact', step.get('uses', ''))

    def test_completed_snapshot_wake_uses_producer_sha_without_build_wait(self):
        data = workflow('private-staging-notify.yml')
        self.assertEqual(data['on']['workflow_run']['types'], ['completed'])
        self.assertEqual(data['on']['workflow_run']['workflows'], ['Private Staging Images'])
        self.assertIn("github.event.workflow_run.conclusion == 'success'", data['jobs']['notify']['if'])
        step = next(step for step in data['jobs']['notify']['steps'] if 'Dispatch private staging' in step.get('name', ''))
        producer_sha = 'a' * 40
        with tempfile.TemporaryDirectory() as directory:
            temp = pathlib.Path(directory)
            payload = temp / 'payload.json'
            arguments = temp / 'arguments.txt'
            gh = temp / 'gh'
            gh.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$DISPATCH_ARGUMENTS"\ncat > "$DISPATCH_PAYLOAD"\n')
            gh.chmod(0o755)
            result = subprocess.run(['bash', '-c', step['run']], env={
                'PATH': directory + os.pathsep + os.environ['PATH'],
                'GH_TOKEN': 'synthetic-dispatch-token',
                'EVENT_NAME': 'workflow_run',
                'EVENT_REF': 'refs/heads/master',
                'EVENT_SHA': 'b' * 40,
                'RUN_SHA': producer_sha,
                'DISPATCH_PAYLOAD': str(payload),
                'DISPATCH_ARGUMENTS': str(arguments),
            }, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(payload.read_text()), {
                'ref': 'ops', 'inputs': {
                    'sha': producer_sha, 'source_mode': 'private',
                    'source_ref': 'refs/heads/staging', 'promotion_id': '',
                    'wait': 'false',
                },
            })
            self.assertIn('repos/Fabric-Pro/fabric/actions/workflows/ops-reconcile-dev.yml/dispatches', arguments.read_text().splitlines())

    def test_public_version_pr_path_disabled_in_batch_mode(self):
        cut = workflow('scheduled-release-cut.yml')
        self.assertIn("vars.STAGING_RELEASE_ENABLED != 'true'", cut['jobs']['cut']['if'])
        release = workflow('release.yml')
        gate = next(step for step in release['jobs']['release']['steps'] if step.get('id') == 'batch-policy')
        self.assertIn('STAGING_RELEASE_ENABLED', gate['env'])
        self.assertIn('unexpected unconsumed changesets', gate['run'])
        changesets = next(step for step in release['jobs']['release']['steps'] if step.get('id') == 'changesets')
        self.assertEqual(changesets.get('if'), "vars.STAGING_RELEASE_ENABLED != 'true'")
        self.assertTrue(any(step.get('name') == 'Publish the approved versioned batch' for step in release['jobs']['release']['steps']))

if __name__ == '__main__':
    unittest.main()
