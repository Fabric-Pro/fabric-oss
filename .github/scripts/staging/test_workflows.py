"""Security and admission contracts for the private staging pipeline."""
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
import yaml
from types import SimpleNamespace

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

    def test_private_snapshot_queue_coalesces_only_automatic_staging_pushes(self):
        data = workflow('private-staging-images.yml')
        self.assertIn('concurrency', data, 'automatic staging builds need one active and one pending run')
        concurrency = data['concurrency']
        self.assertEqual(concurrency['cancel-in-progress'], 'false')
        self.assertEqual(concurrency.get('queue', 'single'), 'single')
        expression = concurrency['group']
        self.assertTrue(expression.startswith('${{') and expression.endswith('}}'))
        # Evaluate the actual routing expression, rather than duplicating its
        # condition. This bounded adapter covers its GHA logical operators and
        # format(); actionlint validates the expression against the GHA grammar.
        expression = expression[3:-2].strip().replace('&&', ' and ').replace('||', ' or ')
        def group(event, ref, run_id, sha):
            return eval(expression, {'__builtins__': {}}, {
                'github': SimpleNamespace(event_name=event, ref=ref, run_id=str(run_id), sha=sha),
                'format': lambda pattern, *values: pattern.format(*values),
            })
        automatic = [group('push', 'refs/heads/staging', 101, 'a' * 40),
                     group('push', 'refs/heads/staging', 102, 'b' * 40)]
        self.assertEqual(automatic[0], automatic[1])
        self.assertTrue(automatic[0])
        pinned = []
        for index, (event, ref) in enumerate([('push', 'refs/heads/promotion/example-cycle'),
                           ('workflow_dispatch', 'refs/heads/staging'),
                           ('workflow_dispatch', 'refs/heads/promotion/example-cycle')]):
            for run_id in [201 + 2 * index, 202 + 2 * index]:
                pinned.append(group(event, ref, run_id, 'a' * 40))
        self.assertEqual(len(set(pinned)), len(pinned))
        self.assertNotIn(automatic[0], pinned)
        for job in data['jobs'].values():
            self.assertNotIn('concurrency', job, 'do not serialize matrix components within a run')
        self.assertEqual(len(data['jobs']['build']['strategy']['matrix']['include']), 14)
        self.assertEqual(data['jobs']['aggregate']['needs'], ['policy-tests', 'build'])

    def test_promotion_build_admission_uses_exact_tree_and_preserves_recovery(self):
        data = workflow('private-staging-images.yml')
        policy = data['jobs']['policy-tests']
        admission = next((step for step in policy['steps'] if step.get('id') == 'build-admission'), None)
        self.assertIsNotNone(admission, 'raw promotion pushes must be gated before matrix builds')
        self.assertEqual(policy['outputs']['build'], '${{ steps.build-admission.outputs.build }}')
        self.assertEqual(admission['env']['EVENT_NAME'], '${{ github.event_name }}')
        self.assertEqual(admission['env']['SOURCE_REF'], '${{ github.ref }}')
        self.assertEqual(policy['steps'][0]['with']['ref'], '${{ github.sha }}')
        self.assertEqual(policy['steps'][0]['with']['persist-credentials'], 'false')
        self.assertEqual(policy['steps'][1], admission)
        self.assertEqual(policy['permissions'], {'contents': 'read'})
        self.assertNotIn('node ', admission['run'])
        self.assertNotIn('pnpm ', admission['run'])
        with tempfile.TemporaryDirectory() as directory:
            repo = pathlib.Path(directory)
            def git(*args):
                return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-C', directory, *args], text=True).strip()
            git('init', '-q')
            git('config', 'user.name', 'Example')
            git('config', 'user.email', 'dev@example.com')
            changesets = repo / '.changeset'
            changesets.mkdir()
            (changesets / 'README.md').write_text('Example release instructions.\n')
            (changesets / 'config.json').write_text('{}\n')
            for index in range(12):
                (changesets / f'example-release-{index}.md').write_text('Example release entry.\n')
            git('add', '.')
            git('commit', '-qm', 'Synthetic raw candidate')
            raw = git('rev-parse', 'HEAD')
            for entry in changesets.glob('example-release-*.md'):
                entry.unlink()
            git('add', '.')
            git('commit', '-qm', 'Synthetic consumed candidate')
            final = git('rev-parse', 'HEAD')
            output = repo / 'output'
            def run(event, ref, sha):
                output.write_text('')
                return subprocess.run(['bash', '-c', admission['run']], cwd=directory, env={
                    'PATH': os.environ['PATH'], 'EVENT_NAME': event, 'SOURCE_REF': ref,
                    'GITHUB_SHA': sha, 'GITHUB_OUTPUT': str(output), 'RUNNER_TEMP': directory,
                }, capture_output=True, text=True, timeout=10)
            cases = [
                ('push', 'refs/heads/promotion/example-cycle', raw, 'false'),
                ('push', 'refs/heads/promotion/example-cycle', final, 'false'),
                ('push', 'refs/heads/staging', raw, 'true'),
                ('workflow_dispatch', 'refs/heads/promotion/example-cycle', raw, 'true'),
                ('workflow_dispatch', 'refs/heads/promotion/example-cycle', final, 'true'),
            ]
            for event, ref, sha, expected in cases:
                with self.subTest(event=event, ref=ref, expected=expected):
                    git('checkout', '-q', '--detach', sha)
                    # A worktree-only release entry must not affect an exact-tree decision.
                    (changesets / 'untracked-example.md').write_text('Untracked fixture.\n')
                    result = run(event, ref, sha)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(output.read_text(), f'build={expected}\n')
            git('checkout', '-q', '--detach', final)
            for sha in [raw, 'a' * 40, 'invalid-sha']:
                with self.subTest(invalid_or_mismatched_sha=sha):
                    result = run('push', 'refs/heads/promotion/example-cycle', sha)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn('build=true', output.read_text())
            output.write_text('')
            result = subprocess.run(['bash', '-c', admission['run']], cwd=directory, env={
                'PATH': os.environ['PATH'], 'EVENT_NAME': 'workflow_dispatch',
                'SOURCE_REF': 'refs/heads/promotion/example-cycle', 'GITHUB_SHA': final,
                'EXPECTED_SHA': raw, 'GITHUB_OUTPUT': str(output), 'RUNNER_TEMP': directory,
            }, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0, 'a moved manually dispatched ref must refuse the expected source SHA')
            self.assertNotIn('build=true', output.read_text())
            fake_bin = repo / 'bin'
            fake_bin.mkdir()
            fake_git = fake_bin / 'git'
            fake_git.write_text('#!/bin/sh\nif [ "$1" = ls-tree ]; then exit 1; fi\nexec "$REAL_GIT" "$@"\n')
            fake_git.chmod(0o755)
            real_git = subprocess.check_output(['which', 'git'], text=True).strip()
            output.write_text('')
            result = subprocess.run(['bash', '-c', admission['run']], cwd=directory, env={
                'PATH': str(fake_bin) + os.pathsep + os.environ['PATH'], 'REAL_GIT': real_git,
                'EVENT_NAME': 'push', 'SOURCE_REF': 'refs/heads/promotion/example-cycle',
                'GITHUB_SHA': final, 'GITHUB_OUTPUT': str(output), 'RUNNER_TEMP': directory,
            }, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0, 'Git enumeration failure must fail closed')
            self.assertNotIn('build=true', output.read_text())
            (changesets / 'untracked-example.md').unlink()
            git('rm', '-qr', '.changeset')
            changesets.write_text('Invalid changeset directory fixture.\n')
            git('add', '.changeset')
            git('commit', '-qm', 'Synthetic invalid changeset tree')
            invalid_tree = git('rev-parse', 'HEAD')
            result = run('push', 'refs/heads/promotion/example-cycle', invalid_tree)
            self.assertNotEqual(result.returncode, 0, 'A non-tree changeset path must fail closed')
            self.assertNotIn('build=true', output.read_text())

    def test_matrix_and_aggregate_require_positive_build_admission(self):
        data = workflow('private-staging-images.yml')
        for name in ['build', 'aggregate']:
            job = data['jobs'][name]
            self.assertIn("needs.policy-tests.outputs.build == 'true'", job['if'])
            expression = job['if'].replace('&&', ' and ').replace('||', ' or ').replace('policy-tests', 'policy_tests')
            for output, expected in [('true', True), ('false', False), ('', False)]:
                with self.subTest(job=name, output=output):
                    admitted = eval(expression, {'__builtins__': {}}, {
                        'github': SimpleNamespace(repository='Fabric-Pro/fabric-dev', ref='refs/heads/promotion/example-cycle'),
                        'vars': SimpleNamespace(STAGING_RELEASE_ENABLED='true'),
                        'needs': SimpleNamespace(policy_tests=SimpleNamespace(outputs=SimpleNamespace(build=output))),
                        'startsWith': lambda value, prefix: value.startswith(prefix),
                    })
                    self.assertEqual(admitted, expected)
        self.assertEqual(data['jobs']['aggregate']['needs'], ['policy-tests', 'build'])
        self.assertIn("github.event.workflow_run.head_branch == 'staging'", workflow('private-staging-notify.yml')['jobs']['notify']['if'])

    def test_promotion_classifier_is_trusted_and_contract_checks_exact_head(self):
        policy = workflow('private-promotion-policy.yml')['jobs']['classify']
        checkout = next(step for step in policy['steps'] if step.get('uses', '').startswith('actions/checkout@'))
        self.assertEqual(checkout['with']['ref'], 'staging', 'identity code must come from protected staging, never a PR head')
        self.assertEqual(checkout['with']['persist-credentials'], 'false')
        contract = workflow('private-promotion-contract.yml')['jobs']['contract']
        self.assertEqual(contract['if'], "needs.promotion_policy.outputs.reduced == 'true'")
        checkout = next(step for step in contract['steps'] if step.get('uses', '').startswith('actions/checkout@'))
        self.assertEqual(checkout['with']['ref'], '${{ github.event.pull_request.head.sha }}')
        self.assertEqual(checkout['with']['persist-credentials'], 'false')
        self.assertEqual(contract['name'], 'Private promotion contract')
        self.assertNotIn('environment', contract)
        self.assertNotIn('secrets.', str(contract))

    def test_cancelled_initialized_replay_publishes_terminal_failure(self):
        data = workflow('temporal-replay-validation.yml')
        job = data['jobs']['publish_outcome']
        condition = job['if'].replace('&&', ' and ').replace('||', ' or ').replace('!cancelled()', 'not cancelled()')
        needs = SimpleNamespace(
            promotion_policy=SimpleNamespace(result='success', outputs=SimpleNamespace(reduced='false')),
            authorize=SimpleNamespace(result='success', outputs=SimpleNamespace(workflows='true', secret_eligible='true')),
            initialize_status=SimpleNamespace(result='success'), replay=SimpleNamespace(result='cancelled'))
        context = {'needs': needs, 'github': SimpleNamespace(event_name='pull_request_target'),
                   'always': lambda: True, 'cancelled': lambda: True}
        self.assertTrue(eval(condition, {'__builtins__': {}}, context), 'initialized pending status must reach cancellation cleanup')
        needs.promotion_policy.outputs.reduced = 'true'
        self.assertFalse(eval(condition, {'__builtins__': {}}, context), 'authenticated reduction must never initialize or publish replay statuses')
        for name in ['publish_outcome', 'publish_denial']:
            self.assertNotIn('!cancelled()', data['jobs'][name]['if'], 'terminal status writers retain baseline always cleanup')
        with tempfile.TemporaryDirectory(prefix='example-replay-cleanup-') as directory:
            path = pathlib.Path(directory); trace = path / 'trace'; gh = path / 'gh'
            gh.write_text('#!/bin/sh\nprintf "%s\\n" "$@" >>"$TRACE_PATH"\n')
            gh.chmod(0o755)
            sha = 'a' * 40
            env = {**os.environ, 'PATH': str(path) + os.pathsep + os.environ['PATH'],
                   'TRACE_PATH': str(trace), 'INITIAL_STATUS_RESULT': 'success', 'GATE_RESULT': 'success',
                   'SECRET_ELIGIBLE': 'true', 'REPLAY_RESULT': 'cancelled', 'EVENT_NAME': 'pull_request_target',
                   'PR_HEAD_SHA': sha, 'REPOSITORY': 'example/source', 'RUN_URL': 'https://example.com/run',
                   'GH_TOKEN': ''}
            result = subprocess.run(['bash', '-c', job['steps'][0]['run']], env=env, text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0, 'cancelled replay remains a blocking verdict')
            args = trace.read_text().splitlines()
            self.assertIn('state=failure', args)
            self.assertIn('repos/example/source/statuses/' + sha, args)
            self.assertIn('context=replay-validation', args)

    def test_reduced_promotion_routes_all_duplicate_jobs_without_pending_replay(self):
        names = ['type-check', 'unit-tests', 'code-quality', 'security', 'db-integration',
                 'migration-safety', 'knip', 'docker-build-check',
                 'temporal-replay-validation', 'temporal-replay-pr-check']
        for name in names:
            data = workflow(name + '.yml')
            policy = data['jobs']['promotion_policy']
            self.assertEqual(policy['uses'], './.github/workflows/private-promotion-policy.yml')
            self.assertIn("github.repository == 'Fabric-Pro/fabric-dev'", policy['if'])
            self.assertIn("vars.STAGING_RELEASE_ENABLED == 'true'", policy['if'])
            for key, job in data['jobs'].items():
                if key == 'promotion_policy':
                    continue
                with self.subTest(workflow=name, job=key):
                    self.assertIn('promotion_policy', job['needs'])
                    condition = job['if']
                    marker = "(needs.promotion_policy.result != 'success' || needs.promotion_policy.outputs.reduced != 'true') && "
                    self.assertIn(marker, condition)
                    expression = condition.replace('&&', ' and ').replace('||', ' or ').replace('!cancelled()', 'not cancelled()')
                    expression = __import__('re').sub(r'needs\.([a-zA-Z0-9_-]+)', lambda m: 'needs.' + m[1].replace('-', '_'), expression)
                    expression = ' '.join(expression.split())
                    suffix = expression.split("(needs.promotion_policy.result != 'success' or needs.promotion_policy.outputs.reduced != 'true') and ", 1)[1]
                    outputs = SimpleNamespace(has_shards='true', code='true', workflows='true',
                        secret_eligible='true', migrations='true', db='true', temporal='true', reason='')
                    needs = SimpleNamespace(**{dependency.replace('-', '_'): SimpleNamespace(result='success', outputs=outputs)
                        for dependency in job['needs'] if dependency != 'promotion_policy'})
                    context = {
                        'github': SimpleNamespace(event_name='pull_request', repository='Fabric-Pro/fabric-dev'),
                        'needs': needs, 'always': lambda: True, 'cancelled': lambda: False,
                        'success': lambda: True, 'failure': lambda: False, 'true': True, 'false': False,
                    }
                    for result, reduced in [('skipped', ''), ('success', 'false'), ('success', ''), ('failure', ''), ('failure', 'true')]:
                        needs.promotion_policy = SimpleNamespace(result=result, outputs=SimpleNamespace(reduced=reduced))
                        self.assertEqual(eval(expression, {'__builtins__': {}}, context), eval(suffix, {'__builtins__': {}}, context))
                    needs.promotion_policy = SimpleNamespace(result='success', outputs=SimpleNamespace(reduced='true'))
                    self.assertFalse(eval(expression, {'__builtins__': {}}, context), 'authenticated promotions must not start duplicate suites or replay status producers')
                    context['success'] = lambda: False
                    context['failure'] = lambda: True
                    needs.promotion_policy = SimpleNamespace(result='failure', outputs=SimpleNamespace(reduced=''))
                    self.assertEqual(eval(expression, {'__builtins__': {}}, context), eval(suffix, {'__builtins__': {}}, context), 'classifier failure must retain full-path dependency and aggregate semantics')
                    if (name, key) in [('type-check', 'type-check'), ('unit-tests', 'unit-tests'), ('code-quality', 'biome'), ('security', 'security')]:
                        self.assertTrue(eval(expression, {'__builtins__': {}}, context), 'classifier failure must execute stable required contexts')
                    for dependency in job['needs']:
                        if dependency == 'promotion_policy':
                            continue
                        sibling = getattr(needs, dependency.replace('-', '_'))
                        sibling.result = 'failure'
                        self.assertEqual(eval(expression, {'__builtins__': {}}, context), eval(suffix, {'__builtins__': {}}, context), 'failure fallback preserves original plan/shard/aggregate dependencies')
                        sibling.result = 'success'


class _Null:
    """GitHub's null: any property of it is null, and it is falsy."""
    def __getattr__(self, name):
        return self
    def __eq__(self, other):
        return isinstance(other, _Null)
    def __ne__(self, other):
        return not self.__eq__(other)
    def __bool__(self):
        return False
    def __hash__(self):
        return 0


NULL = _Null()


class _Obj(SimpleNamespace):
    def __getattr__(self, name):
        return NULL


def _ns(value):
    if isinstance(value, dict):
        return _Obj(**{k: _ns(v) for k, v in value.items()})
    return value


def gha_eval(expression, github, needs=None, variables=None):
    """Evaluates the subset of GitHub expression syntax these jobs use."""
    import re
    e = expression.strip()
    if e.startswith('${{'):
        e = e[3:-2]
    e = e.replace('labels.*.name', 'labels_star_name')
    e = re.sub(r'!(?!=)', ' not ', e).replace('&&', ' and ').replace('||', ' or ')
    e = re.sub(r'needs\.([a-zA-Z0-9_-]+)', lambda m: 'needs.' + m[1].replace('-', '_'), e)
    e = ' '.join(e.split())
    context = {
        'github': _ns(github), 'needs': _ns(needs or {}), 'vars': _ns(variables or {}),
        'always': lambda: True, 'cancelled': lambda: False, 'success': lambda: True, 'failure': lambda: False,
        'contains': lambda haystack, needle: isinstance(haystack, (list, tuple)) and needle in haystack,
        'startsWith': lambda value, prefix: isinstance(value, str) and value.startswith(prefix),
        'true': True, 'false': False, 'null': NULL,
    }
    return eval(e, {'__builtins__': {}}, context)


class PullRequestContracts(unittest.TestCase):
    def test_pr_metadata_steps_keep_their_credentials_boundary(self):
        for name, key in [('dco.yml', 'check'), ('changeset-check.yml', 'check'),
                          ('temporal-replay-pr-check.yml', 'replay_check')]:
            with self.subTest(workflow=name):
                job = workflow(name)['jobs'][key]
                for step in job['steps']:
                    condition = step.get('if')
                    if name == 'changeset-check.yml':
                        self.assertTrue(condition.startswith("github.event_name == 'pull_request'"), step.get('name', step.get('uses')))
                    else:
                        self.assertEqual(condition, "github.event_name == 'pull_request'", step.get('name', step.get('uses')))
                self.assertNotIn('environment', job)
                self.assertNotIn('secrets.', json.dumps(job))
                if name == 'changeset-check.yml':
                    self.assertEqual(job['needs'], 'classify-relay-batch')
                    classifier = workflow(name)['jobs']['classify-relay-batch']
                    self.assertEqual(classifier['permissions'], {'contents': 'read', 'pull-requests': 'read'})
                    self.assertIn("github.repository == 'Fabric-Pro/fabric-oss'", classifier['if'])
                    self.assertIn("startsWith(github.event.pull_request.head.ref, 'relay/staging-pr-')", classifier['if'])
                    checkout = classifier['steps'][0]
                    self.assertEqual(checkout['with']['ref'], '${{ github.event.pull_request.head.sha }}')
                    self.assertEqual(checkout['with']['persist-credentials'], 'false')
                    self.assertEqual(classifier['steps'][1]['run'], 'node .github/scripts/staging/public-relay-changeset.mjs')
                    self.assertIn('needs.classify-relay-batch.outputs.relay_batch', job['steps'][1]['if'])

    def test_pr_metadata_job_conditions_preserve_exemptions(self):
        exempt = {'login': 'dependabot[bot]'}
        variables = {'STAGING_RELEASE_ENABLED': 'true', 'OSS_RELAY_APP_LOGIN': 'example-relay[bot]', 'RELEASE_APP_LOGIN': 'example-release[bot]'}
        prs = [
            {'user': {'login': 'example-dev'}, 'head': {'ref': 'feature/example', 'repo': {'full_name': 'Fabric-Pro/fabric-dev'}}, 'base': {'ref': 'staging'}, 'labels_star_name': []},
            {'user': {'login': 'example-dev'}, 'head': {'ref': 'feature/example', 'repo': {'full_name': 'Fabric-Pro/fabric-dev'}}, 'base': {'ref': 'staging'}, 'labels_star_name': ['skip-changeset']},
            {'user': exempt, 'head': {'ref': 'dependabot/npm/example', 'repo': {'full_name': 'Fabric-Pro/fabric-dev'}}, 'base': {'ref': 'staging'}, 'labels_star_name': []},
            {'user': {'login': 'example-relay[bot]'}, 'head': {'ref': 'promotion/example', 'repo': {'full_name': 'Fabric-Pro/fabric-dev'}}, 'base': {'ref': 'master'}, 'labels_star_name': []},
            {'user': {'login': 'example-relay[bot]'}, 'head': {'ref': 'backport/example', 'repo': {'full_name': 'Fabric-Pro/fabric-dev'}}, 'base': {'ref': 'staging'}, 'labels_star_name': []},
        ]
        expected = {'dco.yml': [True, True, False, False, False],
                    'changeset-check.yml': [True, False, True, False, True]}
        for name in expected:
            condition = workflow(name)['jobs']['check']['if']
            for pr, should_run in zip(prs, expected[name]):
                with self.subTest(workflow=name, pr=pr['user']['login'], labels=pr['labels_star_name']):
                    github = {'event_name': 'pull_request', 'repository': 'Fabric-Pro/fabric-dev', 'event': {'pull_request': pr}}
                    self.assertEqual(bool(gha_eval(condition, github, variables=variables)), should_run)

    def test_unit_tests_aggregate_requires_checks_for_relevant_pr_changes(self):
        job = workflow('unit-tests.yml')['jobs']['unit-tests']
        script = job['steps'][0]['run']
        def run(**overrides):
            env = {'PATH': os.environ['PATH'], 'GH_TOKEN': '', 'GITHUB_REPOSITORY': 'example/source',
                   'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1', 'EVENT_NAME': 'pull_request',
                   'CHANGES_RESULT': 'success', 'CODE_CHANGED': 'false', 'PLAN_RESULT': 'skipped',
                   'HAS_SHARDS': '', 'VITEST_RESULT': 'skipped', 'BROWSER_SECURITY_RESULT': 'skipped',
                   'MIGRATIONS_CHANGED': 'false', 'MIGRATION_DRIFT_RESULT': 'skipped', **overrides}
            return subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True, timeout=10).returncode
        self.assertEqual(run(), 0, 'PR without migration changes needs no drift run')
        self.assertNotEqual(run(MIGRATIONS_CHANGED='true', MIGRATION_DRIFT_RESULT='failure'), 0)
        self.assertNotEqual(run(MIGRATIONS_CHANGED='true'), 0, 'migration changes require drift')
        self.assertEqual(run(MIGRATIONS_CHANGED='true', MIGRATION_DRIFT_RESULT='success'), 0)
        self.assertNotEqual(run(CODE_CHANGED='true'), 0, 'code changes require browser and test checks')
        self.assertEqual(run(CODE_CHANGED='true', BROWSER_SECURITY_RESULT='success', PLAN_RESULT='success', HAS_SHARDS='true', VITEST_RESULT='success'), 0)
        self.assertNotEqual(run(CHANGES_RESULT='failure'), 0)

if __name__ == '__main__':
    unittest.main()
