"""Security and admission contracts for the private staging pipeline."""
import pathlib
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
        privacy = next(step for step in data['jobs']['build']['steps'] if step.get('name') == 'Verify private package visibility')
        self.assertIn('visibility == "private"', privacy['run'])

    def test_notifier_never_executes_product_content(self):
        data = workflow('private-staging-notify.yml')
        self.assertEqual(data['on']['push']['branches'], ['master'])
        self.assertEqual(data['permissions'], {'contents': 'read'})
        for job in data['jobs'].values():
            self.assertIn("vars.STAGING_RELEASE_ENABLED == 'true'", job['if'])
            for step in job['steps']:
                self.assertNotIn('actions/checkout', step.get('uses', ''))
                self.assertNotIn('download-artifact', step.get('uses', ''))

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
