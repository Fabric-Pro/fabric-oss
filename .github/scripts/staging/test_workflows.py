"""Security and admission contracts for the private staging pipeline."""
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import time
import unittest
import yaml
from types import SimpleNamespace

ROOT = pathlib.Path(__file__).resolve().parents[3]

def workflow(name):
    return yaml.load((ROOT / '.github/workflows' / name).read_text(), Loader=yaml.BaseLoader)

class StagingWorkflowContracts(unittest.TestCase):
    def test_prisma_cache_producer_matches_both_consumers(self):
        unit = workflow('unit-tests.yml')
        warmer = unit['jobs']['warm-caches']
        producers = [step for step in warmer['steps']
                     if step.get('uses', '').startswith('actions/cache/save@')
                     and step.get('with', {}).get('path') == 'packages/database/prisma/generated']
        self.assertEqual(len(producers), 1, 'push warmer must publish the compiled client')
        producer = producers[0]
        consumers = [step for job in workflow('db-integration.yml')['jobs'].values()
                     for step in job.get('steps', []) if step.get('id') == 'prisma-client-cache']
        self.assertEqual(len(consumers), 2)
        expected_inputs = {
            'packages/database/prisma/schema.prisma',
            'packages/database/prisma/zod-generator.config.json',
            'packages/database/prisma/tsconfig.generated.json',
            'packages/database/scripts/generate-client.mts',
            'packages/database/scripts/fix-zod-imports.ts',
            'packages/database/tsconfig.json', 'packages/database/package.json',
            'tooling/typescript/base.json', 'tooling/typescript/package.json',
            'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml',
        }
        for step in [producer, *consumers]:
            with self.subTest(step=step['name']):
                self.assertEqual(step['with']['path'], 'packages/database/prisma/generated')
                self.assertNotIn('restore-keys', step['with'])
                self.assertEqual(step['with']['key'], producer['with']['key'])
                self.assertTrue(step['with']['key'].startswith('prisma-client-${{ runner.os }}-${{ hashFiles('))
                self.assertTrue(step['uses'].endswith('@55cc8345863c7cc4c66a329aec7e433d2d1c52a9'))
                hashed = step['with']['key'].split('hashFiles(', 1)[1].split(')', 1)[0]
                self.assertEqual(set(re.findall(r"'([^']+)'", hashed)), expected_inputs)
        # These jobs currently share the hosted Ubuntu x64 / Node 22 environment.
        for job in [warmer, *[job for job in workflow('db-integration.yml')['jobs'].values()
                             if any(step.get('id') == 'prisma-client-cache' for step in job.get('steps', []))]]:
            self.assertEqual(job['runs-on'], 'ubuntu-latest')
            node = next(step for step in job['steps'] if step.get('uses', '').startswith('actions/setup-node@'))
            self.assertEqual(node['with']['node-version'], '22')
        self.assertEqual(unit['on']['push']['branches'], ['master', 'staging'])
        condition = warmer['if'].replace('&&', ' and ').replace('||', ' or ')
        condition = re.sub(r'!(?!=)', ' not ', condition)
        for event in ['push', 'pull_request', 'workflow_dispatch']:
            admitted = eval(condition, {'__builtins__': {}}, {
                'always': lambda: True, 'cancelled': lambda: False,
                'needs': SimpleNamespace(promotion_policy=SimpleNamespace(
                    result='success', outputs=SimpleNamespace(reduced='false'))),
                'github': SimpleNamespace(event_name=event),
            })
            self.assertEqual(admitted, event == 'push', event)
        steps = warmer['steps']
        generation = next(step for step in steps if 'pnpm turbo run generate --filter=@repo/database' in step.get('run', ''))
        self.assertLess(steps.index(generation), steps.index(producer))
        self.assertNotIn('if', generation)
        self.assertNotIn('continue-on-error', generation)
        self.assertNotIn('continue-on-error', warmer)
        self.assertNotIn('if', producer)  # default success() gates publication
        self.assertNotIn('continue-on-error', producer)
        self.assertIn('git diff --exit-code --stat -- packages/database/prisma/zod', generation['run'])
        self.assertIn('exit 1', generation['run'])
        # Exercise the real shell gate: generation failures and Zod mismatches
        # must both leave the step failed, so the following save cannot run.
        with tempfile.TemporaryDirectory() as directory:
            temp = pathlib.Path(directory)
            for name, variable in [('pnpm', 'GENERATE_RESULT'), ('git', 'ZOD_DIFF_RESULT')]:
                command = temp / name
                command.write_text('#!/bin/sh\nexit "$' + variable + '"\n')
                command.chmod(0o755)
            for generate_result, diff_result in [(0, 0), (1, 0), (0, 1)]:
                result = subprocess.run(['bash', '-e', '-c', generation['run']], env={
                    'PATH': directory + os.pathsep + os.environ['PATH'],
                    'GENERATE_RESULT': str(generate_result), 'ZOD_DIFF_RESULT': str(diff_result),
                }, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode == 0, generate_result == diff_result == 0, result.stdout + result.stderr)

    def test_turbo_generation_tracks_compiler_and_install_configuration(self):
        # turbo.json uses full-line comments; keep URL strings intact.
        text = (ROOT / 'turbo.json').read_text()
        config = json.loads(re.sub(r'^\s*//[^\n]*', '', text, flags=re.MULTILINE))
        inputs = config['tasks']['generate']['inputs']
        for path in ['package.json', 'tsconfig.json', 'scripts/generate-client.mts',
                     'scripts/fix-zod-imports.ts', 'prisma/schema.prisma',
                     'prisma/zod-generator.config.json', 'prisma/tsconfig.generated.json',
                     '$TURBO_ROOT$/tooling/typescript/base.json',
                     '$TURBO_ROOT$/tooling/typescript/package.json',
                     '$TURBO_ROOT$/package.json', '$TURBO_ROOT$/pnpm-workspace.yaml',
                     '$TURBO_ROOT$/pnpm-lock.yaml']:
            with self.subTest(input=path):
                self.assertIn(path, inputs, 'Turbo must not restore an old client under a new direct-cache key')

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
        helper = 'node .github/actions/oss-snapshot/package-registry-manifest.mjs'
        expected_env = {
            'GH_TOKEN': '${{ github.token }}',
            'COMPONENT': '${{ matrix.component }}',
            'PRIVATE_STAGING_PACKAGE_BINDINGS': '${{ vars.PRIVATE_STAGING_PACKAGE_BINDINGS }}',
            'SOURCE_REPOSITORY': '${{ github.repository }}',
            'SOURCE_REPOSITORY_ID': '${{ github.repository_id }}',
        }
        # Both jobs that push tags or attestations into the private packages.
        # The reuse job checks every component of its chunk in turn.
        for name, publishes in [('build', lambda step: step.get('id') == 'build'),
                                ('reuse', lambda step: step.get('id') == 'verify')]:
            job = data['jobs'][name]
            steps = job['steps']
            privacy_steps = [step for step in steps if helper in step.get('run', '')]
            self.assertEqual(len(privacy_steps), 1, name)
            privacy = privacy_steps[0]
            env = dict(expected_env)
            if name == 'reuse':
                del env['COMPONENT']
                self.assertNotIn('COMPONENT', privacy['env'])
                self.assertIn('''COMPONENTS=$(jq -er '.[].component' <<<"$REUSED")''', privacy['run'])
                self.assertIn('for COMPONENT in $COMPONENTS; do', privacy['run'])
            for key, value in env.items():
                with self.subTest(job=name, env=key):
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
            publish_index = next(index for index, step in enumerate(steps) if publishes(step))
            self.assertLess(privacy_index, login_index)
            self.assertLess(privacy_index, publish_index)
            # The validator unit cases prove live private visibility and exact identity;
            # this contract proves that the publishing workflow runs those checks.
            self.assertEqual(job['needs'], ['policy-tests', 'plan'])
        self.assertTrue(any(step.get('run') == 'node --test .github/actions/oss-snapshot/*manifest.test.mjs .github/actions/oss-snapshot/snapshot-reuse.test.mjs'
                            for step in data['jobs']['policy-tests']['steps']))

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
        # The plan splits all 14 components between the two matrices; the
        # aggregate validator still requires every one of them.
        self.assertEqual(data['jobs']['build']['strategy']['matrix'], '${{ fromJSON(needs.plan.outputs.build) }}')
        self.assertEqual(data['jobs']['reuse']['strategy']['matrix'], '${{ fromJSON(needs.plan.outputs.reuse) }}')
        self.assertEqual(data['jobs']['aggregate']['needs'], ['policy-tests', 'plan', 'build', 'reuse'])

    def test_only_automatic_staging_pushes_reuse_images(self):
        data = workflow('private-staging-images.yml')
        def evaluate(expression, event, ref):
            self.assertTrue(expression.startswith('${{') and expression.endswith('}}'))
            expression = expression[3:-2].strip().replace('&&', ' and ').replace('||', ' or ')
            return eval(expression, {'__builtins__': {}}, {'github': SimpleNamespace(event_name=event, ref=ref)})
        reuse = data['jobs']['plan']['env']['REUSE']
        runner = data['jobs']['build']['runs-on']
        for event, ref, automatic in [('push', 'refs/heads/staging', True),
                                      ('push', 'refs/heads/promotion/example-cycle', False),
                                      ('workflow_dispatch', 'refs/heads/staging', False),
                                      ('workflow_dispatch', 'refs/heads/promotion/example-cycle', False)]:
            with self.subTest(event=event, ref=ref):
                self.assertEqual(evaluate(reuse, event, ref), automatic)
                # Promotion and recovery builds keep the runner they always used.
                self.assertEqual(evaluate(runner, event, ref), 'ubuntu-8core' if automatic else 'ubuntu-latest')
        # A deliberate trade of cost for speed, chosen by the owner on
        # 2026-10-23. The 2026-10-15 scratch runs measured the 8-core x64 runner
        # (3.7x the per-minute price) at 1.3x on cached builds, 1.7x on
        # dependency-layer rebuilds and 1.7x on SBOM scans, with no disk
        # reclaim. Replaying the 194 automatic staging runs of 2026-10-16..23
        # with those ratios: build-job billed minutes 13,755 -> ~7,750 and
        # images cost ~$100 -> ~$180 a week, while the median run drops from
        # ~11 to ~7 minutes and p90 from ~18 to ~10. The larger runner is
        # GitHub-hosted, so admission's --deny-self-hosted-runners still holds.
        # Every other job is short and stays on the standard runner.
        for name, job in data['jobs'].items():
            if name != 'build':
                with self.subTest(job=name):
                    self.assertEqual(job['runs-on'], 'ubuntu-latest')
        self.assertIn("github.ref == 'refs/heads/staging'", data['jobs']['reuse']['if'])
        self.assertNotIn('promotion', data['jobs']['reuse']['if'])
        plan = next(step for step in data['jobs']['plan']['steps'] if step.get('id') == 'plan')
        self.assertIn('PLAN=$(node "$MODULE" plan --reuse false)', plan['run'])
        # Without inputs the build adds no label, so those images are unchanged.
        build = next(step for step in data['jobs']['build']['steps'] if step.get('id') == 'build')
        self.assertIn("${{ matrix.inputs != '' && format('{0}={1}', env.INPUTS_LABEL, matrix.inputs) || '' }}", build['with']['labels'])

    def test_reuse_plan_reads_the_previous_snapshot_tags_at_once(self):
        plan = next(step for step in workflow('private-staging-images.yml')['jobs']['plan']['steps']
                     if step.get('id') == 'plan')
        previous_sha, other_sha, current = 'a' * 40, 'b' * 40, 'e' * 40
        namespace = 'ghcr.io/example/snapshots'
        base_digest = 'sha256:' + '4' * 64
        image = lambda digest: json.dumps({'manifest': {'digest': digest}, 'image': {
            'created': '2026-10-23T10:00:00Z', 'config': {'Labels': {'example.inputs': 'sha256:' + '1' * 64}}}})
        expected_image = lambda digest: {'digest': digest, 'created': '2026-10-23T10:00:00Z',
                                         'labels': {'example.inputs': 'sha256:' + '1' * 64}}
        run = lambda run_id, sha, created, branch='staging', path='.github/workflows/private-staging-images.yml': {
            'id': run_id, 'head_sha': sha, 'created_at': created, 'head_branch': branch,
            'head_repository': {'full_name': 'example-org/example'}, 'path': path}
        current_run = run(90, current, '2026-10-23T12:00:00Z')
        fakes = {
            'gh': '#!/bin/bash\ncat "$FAKE/runs.json"\n',
            # `buildx imagetools inspect <ref> --format <format>`: c2 has no tag.
            'docker': f'''#!/bin/bash
echo "$4" >>"$FAKE/inspected.log"
case "$4" in
  node:22-slim) echo '{{"digest":"{base_digest}"}}' ;;
  {namespace}/c1:{previous_sha}) cat "$FAKE/c1.json" ;;
  {namespace}/c3:{previous_sha}) cat "$FAKE/c3.json" ;;
  *) echo "not found: $4" >&2; exit 1 ;;
esac
''',
            # The planner's contract: a component the snapshot has is reused.
            'node': '''#!/bin/bash
case "$2" in
  components) printf 'c1\\nc2\\nc3\\n' ;;
  images) echo node:22-slim ;;
  plan)
    previous=$(sed -n 's/.*--previous \\([^ ]*\\).*/\\1/p' <<<"$*")
    jq -c '. as $snapshot | {
      build: [("c1", "c2", "c3") | select($snapshot.images[.] == null) | {component: ., reason: "inputs changed"}],
      reuse: [("c1", "c2", "c3") | select($snapshot.images[.] != null)
              | {component: ., digest: $snapshot.images[.].digest, reusedSourceSha: $snapshot.sourceSha}]}' "$previous" ;;
  *) exit 2 ;;
esac
''',
        }
        for runs, expected_previous, expected_inspections, counts in [
            ([current_run, run(80, previous_sha, '2026-10-23T11:00:00Z'), run(70, other_sha, '2026-10-23T10:00:00Z'),
              run(40, other_sha, '2026-10-23T11:30:00Z', branch='example-branch'),
              run(30, other_sha, '2026-10-23T11:45:00Z', path='.github/workflows/other.yml')],
             {'sourceSha': previous_sha, 'run': '80', 'images': {
                 'c1': expected_image('sha256:' + '2' * 64), 'c3': expected_image('sha256:' + '3' * 64)}},
             [f'{namespace}/{component}:{previous_sha}' for component in ['c1', 'c2', 'c3']], ('1', '2')),
            ([current_run], {}, [], ('3', '0')),
        ]:
            with self.subTest(previous=bool(expected_previous)), tempfile.TemporaryDirectory() as directory:
                temp = pathlib.Path(directory)
                bin_dir = temp / 'bin'
                bin_dir.mkdir()
                (temp / 'runs.json').write_text(json.dumps({'workflow_runs': runs}))
                (temp / 'c1.json').write_text(image('sha256:' + '2' * 64))
                (temp / 'c3.json').write_text(image('sha256:' + '3' * 64))
                for name, text in fakes.items():
                    (bin_dir / name).write_text(text)
                    (bin_dir / name).chmod(0o755)
                output, summary = temp / 'output', temp / 'summary'
                result = subprocess.run(['bash', '-c', plan['run']], cwd=directory, env={
                    'PATH': str(bin_dir) + os.pathsep + os.environ['PATH'], 'FAKE': directory,
                    'REUSE': 'true', 'GH_TOKEN': 'synthetic-token', 'REPOSITORY': 'example-org/example',
                    'RUN_ID': '90', 'SNAPSHOT_NAMESPACE': namespace, 'GITHUB_SHA': current,
                    'GITHUB_REF': 'refs/heads/staging', 'RUNNER_TEMP': directory,
                    'GITHUB_OUTPUT': str(output), 'GITHUB_STEP_SUMMARY': str(summary),
                    'REUSE_SLOTS': '1',
                }, capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                inspected = (temp / 'inspected.log').read_text().split()
                self.assertEqual(inspected[0], 'node:22-slim')
                # The newest other successful staging run, every component once.
                self.assertEqual(sorted(inspected[1:]), expected_inspections)
                self.assertEqual(json.loads((temp / 'previous.json').read_text()), expected_previous)
                # A tag that could not be read leaves no partial record behind.
                self.assertFalse((temp / 'inspected' / 'c2.json').exists())
                outputs = dict(line.split('=', 1) for line in output.read_text().splitlines())
                self.assertEqual((outputs['build_count'], outputs['reuse_count']), counts)
                # One reuse job per chunk of REUSE_SLOTS components.
                chunks = json.loads(outputs['reuse'])['include']
                self.assertEqual([chunk['chunk'] for chunk in chunks], list(range(1, int(counts[1]) + 1)))
                self.assertEqual([chunk['names'] for chunk in chunks],
                                 [component['component'] for chunk in chunks for component in chunk['components']])
                self.assertEqual([len(chunk['components']) for chunk in chunks], [1] * int(counts[1]))

    def test_reuse_plan_chunks_never_exceed_the_attestation_slots(self):
        data = workflow('private-staging-images.yml')
        plan = next(step for step in data['jobs']['plan']['steps'] if step.get('id') == 'plan')
        slots = int(data['env']['REUSE_SLOTS'])
        # The step's own output block, from the `reuse=` line through its
        # two-line jq program, evaluated as written.
        lines = plan['run'].splitlines()
        start = next(index for index, line in enumerate(lines) if line.strip().startswith('echo "reuse='))
        command = '\n'.join(lines[start:start + 2])
        for count in [1, 3, 4, 5, 8, 13, 14]:
            with self.subTest(count=count), tempfile.TemporaryDirectory() as directory:
                reused = [{'component': f'c{index}', 'digest': 'sha256:' + '1' * 64} for index in range(count)]
                (pathlib.Path(directory) / 'plan.json').write_text(json.dumps({'build': [], 'reuse': reused}))
                result = subprocess.run(['bash', '-c', 'PLAN=$(cat plan.json)\n' + command], cwd=directory,
                                        env={'PATH': os.environ['PATH'], 'REUSE_SLOTS': str(slots)},
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                chunks = json.loads(result.stdout.split('=', 1)[1])['include']
                self.assertTrue(all(1 <= len(chunk['components']) <= slots for chunk in chunks))
                self.assertEqual([component for chunk in chunks for component in chunk['components']], reused)
                self.assertEqual([chunk['chunk'] for chunk in chunks], list(range(1, len(chunks) + 1)))
                self.assertEqual([chunk['names'] for chunk in chunks],
                                 [', '.join(component['component'] for component in chunk['components']) for chunk in chunks])
        # All 14 components fit in a small fixed number of reuse jobs.
        self.assertLessEqual(-(-14 // slots), 4)

    def test_sbom_gate_binds_the_scanned_manifest_to_the_built_digest(self):
        steps = workflow('private-staging-images.yml')['jobs']['build']['steps']
        names = [step.get('name') for step in steps]
        gate_index = names.index('Verify the SBOM describes the built digest')
        self.assertLess(names.index('Generate SPDX SBOM from pushed digest'), gate_index)
        self.assertLess(gate_index, names.index('Attest build provenance'))
        self.assertLess(gate_index, names.index('Attest SPDX SBOM'))
        gate = steps[gate_index]
        self.assertEqual(gate['env'], {'COMPONENT': '${{ matrix.component }}',
                                       'DIGEST': '${{ steps.build.outputs.digest }}'})
        built = 'sha256:' + '5' * 64
        root = 'SPDXRef-DocumentRoot-Image-example'
        def sbom(checksums=(('SHA256', '5' * 64),), roots=(root,)):
            # The shape Syft 1.x writes for an image source (see its SPDX JSON
            # image encoder snapshot): the root package carries the manifest
            # digest, and the document DESCRIBES it.
            return {
                'spdxVersion': 'SPDX-2.3',
                'packages': [
                    {'SPDXID': 'SPDXRef-Package-npm-example', 'name': 'example',
                     'checksums': [{'algorithm': 'SHA256', 'checksumValue': '7' * 64}]},
                    {'SPDXID': root, 'name': 'ghcr.io/example/snapshots/example',
                     'checksums': [{'algorithm': algorithm, 'checksumValue': value} for algorithm, value in checksums]},
                ],
                'relationships': [
                    {'spdxElementId': root, 'relatedSpdxElement': 'SPDXRef-Package-npm-example', 'relationshipType': 'CONTAINS'},
                    *[{'spdxElementId': 'SPDXRef-DOCUMENT', 'relatedSpdxElement': item, 'relationshipType': 'DESCRIBES'}
                      for item in roots],
                ],
            }
        cases = [
            ('matching digest', sbom(), built, 0),
            ('another manifest', sbom(checksums=(('SHA256', '6' * 64),)), built, 1),
            ('no manifest checksum', sbom(checksums=()), built, 1),
            ('only another algorithm', sbom(checksums=(('SHA1', '5' * 40),)), built, 1),
            ('no described root', sbom(roots=()), built, 1),
            ('two described roots', sbom(roots=(root, 'SPDXRef-Package-npm-example')), built, 1),
            ('malformed build digest', sbom(), 'sha256:short', 1),
        ]
        for label, document, digest, expected in cases:
            with self.subTest(case=label), tempfile.TemporaryDirectory() as directory:
                (pathlib.Path(directory) / 'example.spdx.json').write_text(json.dumps(document))
                result = subprocess.run(['bash', '-c', gate['run']], cwd=directory, env={
                    'PATH': os.environ['PATH'], 'COMPONENT': 'example', 'DIGEST': digest,
                    'IMAGE_NAME': 'ghcr.io/example/snapshots/example',
                }, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode != 0, expected != 0, result.stderr)

    def test_disk_reclaim_and_prune_run_only_below_the_free_space_floor(self):
        job = workflow('private-staging-images.yml')['jobs']['build']
        steps = {step.get('name'): step for step in job['steps']}
        start = steps['Start freeing runner disk for the image build']
        prune = steps['Reclaim BuildKit space before SBOM scan']
        floor = job['env']['MIN_FREE_GB']
        # Above the standard runner's ~31 GB after a reclaim, below the 8-core
        # runner's 371 GB.
        self.assertEqual(floor, '40')
        directories = ['/opt/ghc', '/opt/hostedtoolcache/CodeQL', '/usr/local/lib/android', '/usr/share/dotnet']
        for free, reclaims in [('371', False), ('40', False), ('39', True), ('13', True)]:
            with self.subTest(free=free), tempfile.TemporaryDirectory() as directory:
                temp = pathlib.Path(directory)
                bin_dir = temp / 'bin'
                bin_dir.mkdir()
                trace = temp / 'trace'
                # Fakes only: `sudo` records the removal it was asked for.
                for name, text in {
                    'df': '#!/bin/sh\nif [ "$1" = --output=avail ]; then printf "Avail\\n %s\\n" "$FREE_GB"; '
                          'else echo "/dev/root synthetic"; fi\n',
                    'sudo': '#!/bin/sh\necho "$*" >>"$TRACE"\n',
                    'docker': '#!/bin/sh\necho "docker $*" >>"$TRACE"\n',
                }.items():
                    (bin_dir / name).write_text(text)
                    (bin_dir / name).chmod(0o755)
                env = {'PATH': str(bin_dir) + os.pathsep + os.environ['PATH'], 'FREE_GB': free,
                       'TRACE': str(trace), 'RUNNER_TEMP': directory, 'MIN_FREE_GB': floor}
                calls = lambda: trace.read_text().splitlines() if trace.exists() else []
                result = subprocess.run(['bash', '-e', '-c', start['run']], env=env,
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                status = temp / 'disk-reclaim' / 'status'
                deadline = time.monotonic() + 10
                while not status.exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                # The wait step blocks on this file either way.
                self.assertEqual(status.read_text().strip(), '0')
                self.assertEqual(sorted(calls()), [f'rm -rf {path}' for path in directories] if reclaims else [])
                trace.unlink(missing_ok=True)
                result = subprocess.run(['bash', '-e', '-c', prune['run']], env=env,
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(calls(), ['docker buildx prune --all --force'] if reclaims else [])

    def test_reuse_job_attests_each_slot_with_its_verified_component(self):
        data = workflow('private-staging-images.yml')
        job = data['jobs']['reuse']
        slots = int(data['env']['REUSE_SLOTS'])
        self.assertEqual(job['name'], 'Reuse and attest ${{ matrix.names }}')
        self.assertEqual(job['env']['REUSED'], '${{ toJSON(matrix.components) }}')
        steps = job['steps']
        names = [step.get('name') for step in steps]
        verify_index = names.index('Verify the reused snapshots')
        publish_index = names.index('Tag the reused digests with the full SHA')
        self.assertEqual(steps[verify_index]['id'], 'verify')
        self.assertEqual(steps[verify_index]['run'], 'bash .github/actions/oss-snapshot/reuse-snapshots.sh verify')
        self.assertEqual(steps[publish_index]['run'], 'bash .github/actions/oss-snapshot/reuse-snapshots.sh publish')
        for index in [verify_index, publish_index]:
            self.assertNotIn('if', steps[index])
            self.assertNotIn('continue-on-error', steps[index])
        pin = 'actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6'
        expected = []
        for slot in range(slots):
            out = lambda key: f'${{{{ steps.verify.outputs.{key}_{slot} }}}}'
            subject = {'subject-name': out('image'), 'subject-digest': out('digest')}
            condition = f"steps.verify.outputs.digest_{slot} != ''"
            expected += [
                {'name': f'Attest build provenance for {out("component")}', 'if': condition, 'uses': pin,
                 'with': {**subject, 'predicate-type': 'https://slsa.dev/provenance/v1',
                          'predicate-path': out('provenance'), 'push-to-registry': 'true',
                          'create-storage-record': 'false'}},
                {'name': f'Attest SPDX SBOM for {out("component")}', 'if': condition, 'uses': pin,
                 'with': {**subject, 'sbom-path': out('sbom'), 'push-to-registry': 'true',
                          'create-storage-record': 'false'}},
            ]
        # Both attestations of every slot, and only then the tags.
        self.assertEqual(steps[verify_index + 1:publish_index], expected)
        upload = steps[-1]
        self.assertEqual(upload['name'], 'Upload component evidence')
        self.assertEqual(upload['with']['name'], 'oss-snapshot-part-reused-${{ matrix.chunk }}')
        self.assertEqual(upload['with']['path'], '${{ env.EVIDENCE_DIR }}/')
        self.assertEqual(upload['with']['if-no-files-found'], 'error')
        download = next(step for step in data['jobs']['aggregate']['steps'] if step.get('uses', '').startswith('actions/download-artifact@'))
        self.assertEqual(download['with']['pattern'], 'oss-snapshot-part-*')

    def test_reuse_script_verifies_and_publishes_every_component(self):
        script = ROOT / '.github/actions/oss-snapshot/reuse-snapshots.sh'
        reused_sha, built_sha, current = 'a' * 40, 'b' * 40, 'c' * 40
        inputs = 'sha256:' + '1' * 64
        namespace = 'ghcr.io/example-org/snapshots'
        signer = 'example-org/example/.github/workflows/private-staging-images.yml'
        entry = lambda component, digit: {
            'component': component, 'dockerfile': f'agents/{component}/Dockerfile', 'inputs': inputs,
            'digest': 'sha256:' + digit * 64, 'reusedSourceSha': reused_sha, 'reusedRun': '80',
            'builtSourceSha': built_sha}
        fakes = {
            # `gh attestation verify oci://<image>@<digest> ...`
            'gh': '''#!/bin/bash
echo "$*" >>"$FAKE/gh.log"
component=${3##*/}; component=${component%@*}
case " $FAIL_GH " in *" $component "*) echo "synthetic verification failure" >&2; exit 1 ;; esac
if [[ "$*" == *"--format json"* ]]; then
  jq -n --arg name "$component" '[{verificationResult: {statement: {predicate: {spdxVersion: "SPDX-2.3", name: $name}}}}]'
else
  echo "verified $3"
fi
''',
            # `docker buildx imagetools inspect <ref> --format ...` and
            # `docker buildx imagetools create --prefer-index=false --tag <tag> <source>`
            'docker': '''#!/bin/bash
echo "$*" >>"$FAKE/docker.log"
case "$3" in
  inspect)
    component=${4##*/}; component=${component%%[@:]*}
    case " $FAIL_DOCKER " in *" $component "*) exit 1 ;; esac
    if [[ "$4" == *@* ]]; then
      jq -n --arg digest "${4#*@}" --arg label "$INPUTS_LABEL" --arg inputs "$FAKE_INPUTS" --arg built "$FAKE_BUILT" \\
        '{manifest: {digest: $digest}, image: {config: {Labels: {($label): $inputs, "org.opencontainers.image.revision": $built}}}}'
    else
      cat "$FAKE/tag-$component"
    fi ;;
  create)
    component=${7##*/}; component=${component%@*}
    jq -n --arg digest "${7#*@}" '{digest: $digest}' >"$FAKE/tag-$component" ;;
  *) exit 2 ;;
esac
''',
        }
        def run(phase, reused, directory, **overrides):
            temp = pathlib.Path(directory)
            bin_dir = temp / 'bin'
            bin_dir.mkdir(exist_ok=True)
            for name, text in fakes.items():
                (bin_dir / name).write_text(text)
                (bin_dir / name).chmod(0o755)
            env = {
                'PATH': str(bin_dir) + os.pathsep + os.environ['PATH'], 'FAKE': directory,
                'REUSED': json.dumps(reused, indent=2), 'REUSE_SLOTS': '4',
                'EVIDENCE_DIR': str(temp / 'evidence'), 'RUNNER_TEMP': directory,
                'SNAPSHOT_NAMESPACE': namespace, 'INPUTS_LABEL': 'pro.fabric.snapshot.inputs',
                'SIGNER_WORKFLOW': signer, 'REPOSITORY': 'example-org/example',
                'SOURCE_URL': 'https://github.com/example-org/example',
                'WORKFLOW_REF': f'{signer}@refs/heads/staging', 'GH_TOKEN': 'synthetic-token',
                'GITHUB_OUTPUT': str(temp / 'output'), 'GITHUB_SHA': current, 'GITHUB_REF': 'refs/heads/staging',
                'GITHUB_SERVER_URL': 'https://github.com', 'GITHUB_REPOSITORY': 'example-org/example',
                'GITHUB_WORKFLOW_REF': f'{signer}@refs/heads/staging', 'GITHUB_RUN_ID': '90',
                'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_EVENT_NAME': 'push', 'GITHUB_REPOSITORY_ID': '1',
                'GITHUB_REPOSITORY_OWNER_ID': '2', 'RUNNER_ENVIRONMENT': 'github-hosted',
                'FAKE_INPUTS': inputs, 'FAKE_BUILT': built_sha, 'FAIL_GH': '', 'FAIL_DOCKER': '', **overrides}
            return subprocess.run(['bash', str(script), phase], cwd=ROOT, env=env,
                                  capture_output=True, text=True, timeout=60)
        read = lambda path: path.read_text().splitlines() if path.exists() else []
        reused = [entry('c1', '1'), entry('c2', '2'), entry('c3', '3')]
        admission = ['--bundle-from-oci', '--repo example-org/example', f'--signer-workflow {signer}',
                     '--source-ref refs/heads/staging', '--deny-self-hosted-runners']
        with tempfile.TemporaryDirectory() as directory:
            temp = pathlib.Path(directory)
            result = run('verify', reused, directory)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            outputs = dict(line.split('=', 1) for line in read(temp / 'output'))
            expected = {}
            for slot, item in enumerate(reused):
                component = item['component']
                expected.update({
                    f'component_{slot}': component, f'image_{slot}': f'{namespace}/{component}',
                    f'digest_{slot}': item['digest'], f'sbom_{slot}': f'{temp}/evidence/{component}.spdx.json',
                    f'provenance_{slot}': f'{temp}/reuse-snapshots/{component}.provenance.json'})
                # The carried-forward SBOM is the verified predicate, compact.
                self.assertEqual((temp / 'evidence' / f'{component}.spdx.json').read_text(),
                                 json.dumps({'spdxVersion': 'SPDX-2.3', 'name': component}, separators=(',', ':')) + '\n')
                provenance = json.loads((temp / 'reuse-snapshots' / f'{component}.provenance.json').read_text())
                self.assertEqual(provenance['buildDefinition']['resolvedDependencies'][1]['digest'],
                                 {'sha256': item['digest'][len('sha256:'):]})
            self.assertEqual(outputs, expected)
            calls = read(temp / 'gh.log')
            self.assertEqual(len(calls), 6)
            for call in calls:
                # Admission's arguments, bound to the SHA the digest was reused from.
                for argument in [*admission, f'--source-digest {reused_sha}']:
                    self.assertIn(argument, call)
            self.assertFalse(any('create' in call for call in read(temp / 'docker.log')), 'verify never tags')
            (temp / 'gh.log').unlink()
            result = run('publish', reused, directory)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            calls = read(temp / 'gh.log')
            self.assertEqual(len(calls), 6)
            for call in calls:
                for argument in [*admission, f'--source-digest {current}']:
                    self.assertIn(argument, call)
            for item in reused:
                component = item['component']
                self.assertIn(f'buildx imagetools create --prefer-index=false --tag {namespace}/{component}:{current} '
                              f'{namespace}/{component}@{item["digest"]}', read(temp / 'docker.log'))
                self.assertEqual(json.loads((temp / 'evidence' / f'{component}.manifest.json').read_text()), {
                    'schemaVersion': '1.0.0', 'component': component, 'dockerfile': item['dockerfile'],
                    'context': '.', 'image': f'{namespace}/{component}', 'tag': current, 'digest': item['digest'],
                    'inputs': inputs, 'sourceSha': current, 'sourceRef': 'refs/heads/staging',
                    'sourceRepository': 'example-org/example', 'buildWorkflow': f'{signer}@refs/heads/staging',
                    'signerWorkflow': signer,
                    'labels': {'org.opencontainers.image.source': 'https://github.com/example-org/example',
                               'org.opencontainers.image.revision': built_sha},
                    'attestations': {'provenance': 'https://slsa.dev/provenance/v1',
                                     'sbom': 'https://spdx.dev/Document/v2.3'},
                    'reuse': {'reusedFromSourceSha': reused_sha, 'reusedFromRun': '80',
                              'builtFromSourceSha': built_sha}})
        # Each failure fails the phase and names exactly the components that
        # failed; a failed verify publishes no slot, so nothing is attested.
        failures = [
            ('verify', reused, {'FAIL_GH': 'c2'}, ['c2']),
            # An unguarded command failing inside a worker still fails it.
            ('verify', reused, {'FAIL_DOCKER': 'c3'}, ['c3']),
            ('verify', reused, {'FAKE_INPUTS': 'sha256:' + '9' * 64}, ['c1', 'c2', 'c3']),
            ('verify', reused, {'FAKE_BUILT': 'd' * 40}, ['c1', 'c2', 'c3']),
            ('verify', [reused[0], {**reused[1], 'digest': 'sha256:short'}], {}, ['c2']),
            ('verify', [reused[0], {**reused[1], 'reusedSourceSha': 'HEAD'}], {}, ['c2']),
            ('publish', reused, {'FAIL_GH': 'c1'}, ['c1']),
            ('publish', reused, {'FAIL_DOCKER': 'c2'}, ['c2']),
        ]
        for phase, items, overrides, failed in failures:
            with self.subTest(phase=phase, overrides=overrides, failed=failed), tempfile.TemporaryDirectory() as directory:
                if phase == 'publish':
                    self.assertEqual(run('verify', items, directory).returncode, 0)
                    pathlib.Path(directory, 'output').unlink()
                result = run(phase, items, directory, **overrides)
                self.assertNotEqual(result.returncode, 0)
                errors = sorted(line.split(' for ', 1)[1] for line in result.stdout.splitlines()
                                if line.startswith('::error::') and ' failed for ' in line)
                self.assertEqual(errors, failed, result.stdout + result.stderr)
                self.assertEqual(read(pathlib.Path(directory, 'output')), [])
        with tempfile.TemporaryDirectory() as directory:
            five = [entry(f'c{index}', str(index)) for index in range(1, 6)]
            result = run('verify', five, directory)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('::error::5 reused components exceed the 4 attestation slots', result.stdout)
            self.assertEqual(read(pathlib.Path(directory, 'gh.log')), [])

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
        def admitted(name, build='true', ref='refs/heads/staging', counts=('14', '0'), results=('success', 'success', 'success')):
            expression = (data['jobs'][name]['if'].replace('&&', ' and ').replace('||', ' or ')
                          .replace('!cancelled()', 'not cancelled()').replace('policy-tests', 'policy_tests'))
            plan_result, build_result, reuse_result = results
            return eval(expression, {'__builtins__': {}}, {
                'github': SimpleNamespace(repository='Fabric-Pro/fabric-dev', ref=ref),
                'vars': SimpleNamespace(STAGING_RELEASE_ENABLED='true'),
                'needs': SimpleNamespace(
                    policy_tests=SimpleNamespace(outputs=SimpleNamespace(build=build)),
                    plan=SimpleNamespace(result=plan_result, outputs=SimpleNamespace(build_count=counts[0], reuse_count=counts[1])),
                    build=SimpleNamespace(result=build_result),
                    reuse=SimpleNamespace(result=reuse_result)),
                'startsWith': lambda value, prefix: value.startswith(prefix),
                'cancelled': lambda: False,
            })
        for name in ['plan', 'build', 'reuse', 'aggregate']:
            self.assertIn("needs.policy-tests.outputs.build == 'true'", data['jobs'][name]['if'])
            for output, expected in [('true', True), ('false', False), ('', False)]:
                with self.subTest(job=name, output=output):
                    self.assertEqual(admitted(name, build=output, counts=('7', '7')), expected)
        promotion = 'refs/heads/promotion/example-cycle'
        self.assertTrue(admitted('build', ref=promotion))
        self.assertFalse(admitted('reuse', ref=promotion, counts=('0', '14')))
        # An empty matrix is skipped rather than run with nothing in it.
        self.assertFalse(admitted('build', counts=('0', '14')))
        self.assertFalse(admitted('reuse', counts=('14', '0')))
        # The aggregate still runs when one matrix was empty, and never after a failure.
        self.assertTrue(admitted('aggregate', counts=('0', '14'), results=('success', 'skipped', 'success')))
        self.assertTrue(admitted('aggregate', counts=('14', '0'), results=('success', 'success', 'skipped')))
        for results in [('failure', 'skipped', 'skipped'), ('success', 'failure', 'success'),
                        ('success', 'success', 'failure'), ('success', 'cancelled', 'success')]:
            with self.subTest(results=results):
                self.assertFalse(admitted('aggregate', results=results))
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
                        secret_eligible='true', migrations='true', db='true', temporal='true', reason='',
                        filter_result='success')
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
    e = e.replace('labels.*.name', 'labels_star_name').replace('pull_requests.*.base.ref', 'pull_requests_star_base_ref')
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


class RelayNotifierContracts(unittest.TestCase):
    def test_live_promotion_and_invalid_branches_never_dispatch(self):
        job = workflow('oss-relay-notify.yml')['jobs']['notify']
        dispatch = next(step for step in job['steps'] if step.get('name') == 'Dispatch identifiers-only wake-up')
        sha = 'a' * 40
        for event in ['pull_request_target', 'issue_comment', 'workflow_run']:
            for branch in ['promotion/example-cycle', None, '', 42, {}, 'feature/example']:
                with self.subTest(event=event, branch=branch), tempfile.TemporaryDirectory() as directory:
                    temp = pathlib.Path(directory)
                    trace = temp / 'posted.json'
                    gh = temp / 'gh'
                    gh.write_text('#!/bin/sh\nif [ "$2" = "--method" ]; then\n'
                                  '  cp "$6" "$DISPATCH_TRACE"\n'
                                  'else\n  printf "%s\\n" "$LIVE_PR"\nfi\n')
                    gh.chmod(0o755)
                    pr = {'state': 'open', 'draft': False, 'base': {'ref': 'master'},
                          'head': {'sha': sha, 'repo': {'full_name': 'example-org/source'}},
                          'labels': [{'name': 'ready-for-relay'}]}
                    if branch is not None:
                        pr['head']['ref'] = branch
                    # The payload may still name an ordinary branch. Every event
                    # must use the current PR branch before dispatching.
                    env = {**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH'],
                           'LIVE_PR': json.dumps(pr), 'DISPATCH_TRACE': trace.as_posix(),
                           'GITHUB_REPOSITORY': 'example-org/source', 'RUNNER_TEMP': temp.as_posix(),
                           'EVENT_NAME': event, 'STAGING_PR': '11', 'EVENT_HEAD_SHA': sha,
                           'COMMENT_BODY': '/relay ' + sha, 'STAGING_TOKEN': 'synthetic-read-token',
                           'DISPATCH_TOKEN': 'synthetic-dispatch-token'}
                    result = subprocess.run([shutil.which('bash'), '-c', dispatch['run']], env=env,
                                            capture_output=True, text=True, timeout=10)
                    if branch == 'feature/example':
                        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                        self.assertEqual(json.loads(trace.read_text()), {
                            'ref': 'ops', 'inputs': {'mode': 'relay', 'staging_pr': '11', 'expected_head_sha': sha}})
                    else:
                        self.assertFalse(trace.exists(), result.stdout + result.stderr)
                        if branch == 'promotion/example-cycle':
                            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                        else:
                            self.assertNotEqual(result.returncode, 0)

    def test_payload_promotion_filters_preserve_ordinary_wakeups(self):
        job = workflow('oss-relay-notify.yml')['jobs']['notify']
        def admitted(event, branch, bases):
            # `pull_requests_star_base_ref` stands for `pull_requests.*.base.ref`.
            github = {'repository': 'Fabric-Pro/fabric-dev', 'event_name': event, 'event': {
                'action': 'labeled', 'label': {'name': 'ready-for-relay'},
                'pull_request': {'head': {'ref': branch, 'repo': {'full_name': 'Fabric-Pro/fabric-dev'}},
                                 'labels_star_name': ['ready-for-relay']},
                'workflow_run': {'event': 'pull_request', 'head_branch': branch,
                                 'pull_requests_star_base_ref': bases}}}
            return bool(gha_eval(job['if'], github))
        for branch, expected in [('promotion/example-cycle', False), ('feature/example', True)]:
            with self.subTest(event='pull_request_target', branch=branch):
                self.assertEqual(admitted('pull_request_target', branch, []), expected)
        # A CI completion wakes the relay only for a master-based pull request:
        # staging-based ones skip before a runner is allocated.
        for branch, bases, expected in [('feature/example', ['master'], True),
                                        ('feature/example', ['staging', 'master'], True),
                                        ('feature/example', ['staging'], False),
                                        ('feature/example', [], False),
                                        ('promotion/example-cycle', ['master'], False)]:
            with self.subTest(event='workflow_run', branch=branch, bases=bases):
                self.assertEqual(admitted('workflow_run', branch, bases), expected)
        github = {'repository': 'Fabric-Pro/fabric-dev', 'event_name': 'issue_comment', 'event': {
            'issue': {'pull_request': {}}, 'comment': {'body': '/relay ' + 'a' * 40}}}
        self.assertTrue(gha_eval(job['if'], github))
        for step in job['steps']:
            self.assertNotIn('actions/checkout', step.get('uses', ''))
            self.assertNotIn('download-artifact', step.get('uses', ''))
            self.assertNotIn('${{', step.get('run', ''))


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
        self.assertEqual(run(PLAN_RESULT='success'), 0, 'merged plan job succeeds with planning steps skipped on a no-code PR')
        self.assertNotEqual(run(CHANGES_RESULT=''), 0, 'an empty filter outcome fails closed')


class AutoMergeContracts(unittest.TestCase):
    NAME = 'auto-merge.yml'
    APP_TOKEN = '${{ steps.app-token.outputs.token }}'

    def job(self):
        return workflow(self.NAME)['jobs']['arm']

    def step(self, name):
        return next(step for step in self.job()['steps'] if step.get('name') == name)

    def test_runs_trusted_definition_with_least_privilege(self):
        data = workflow(self.NAME)
        self.assertEqual(list(data['on']), ['pull_request_target'])
        trigger = data['on']['pull_request_target']
        self.assertEqual(trigger['branches'], ['staging'])
        self.assertEqual(set(trigger['types']), {'opened', 'reopened', 'ready_for_review', 'synchronize',
                                                 'labeled', 'unlabeled', 'edited'})
        self.assertEqual(data['permissions'], {})
        self.assertEqual(list(data['jobs']), ['arm'])
        job = self.job()
        self.assertEqual(job['permissions'], {'contents': 'read'})
        self.assertEqual(job['environment'], 'auto-merge')
        # Job-level, so a run the `if` skips can never cancel a live one.
        self.assertNotIn('concurrency', data)
        self.assertEqual(job['concurrency'], {'group': 'auto-merge-${{ github.event.pull_request.number }}',
                                              'cancel-in-progress': 'true'})

    def test_never_checks_out_or_executes_pull_request_content(self):
        text = (ROOT / '.github/workflows' / self.NAME).read_text()
        for marker in ['pull_request.head.sha', 'pull_request.head.ref', 'head_ref', 'merge_commit_sha',
                       'refs/pull/', 'download-artifact', 'actions/cache', 'pnpm', 'npm ']:
            self.assertNotIn(marker, text)
        checkouts = [step for step in self.job()['steps'] if step.get('uses', '').startswith('actions/checkout@')]
        self.assertEqual(len(checkouts), 1)
        self.assertEqual(checkouts[0]['with'], {'ref': '${{ github.sha }}', 'persist-credentials': 'false',
                                                'sparse-checkout': '.github/scripts/auto-merge'})
        for step in self.job()['steps']:
            with self.subTest(step=step.get('name')):
                # Event fields reach shells only through env, never interpolated.
                self.assertNotIn('${{', step.get('run', ''))
        self.assertIn('node .github/scripts/auto-merge/eligible.mjs',
                      self.step('Decide from the live pull request')['run'])

    def test_merge_uses_the_app_token_and_never_github_token(self):
        text = (ROOT / '.github/workflows' / self.NAME).read_text()
        self.assertNotIn('github.token', text)
        self.assertNotIn('GITHUB_TOKEN }}', text)
        self.assertNotIn('secrets.GITHUB_TOKEN', text)
        mint = self.step('Mint the auto-merge App token')
        pins = set(re.findall(r'actions/create-github-app-token@[0-9a-f]{40}',
                              ''.join(path.read_text() for path in (ROOT / '.github/workflows').glob('*.yml')
                                      if path.name != self.NAME)))
        self.assertEqual(len(pins), 1, 'other workflows disagree on the App token action pin')
        self.assertEqual(mint['uses'].split(' ')[0], pins.pop())
        self.assertEqual(mint['with']['app-id'], '${{ secrets.AUTO_MERGE_APP_ID }}')
        self.assertEqual(mint['with']['private-key'], '${{ secrets.AUTO_MERGE_APP_PRIVATE_KEY }}')
        self.assertEqual(mint['with']['repositories'], 'fabric-dev')
        for name in ['Decide from the live pull request', 'Apply the decision']:
            self.assertEqual(self.step(name)['env']['GH_TOKEN'], self.APP_TOKEN, name)
        for step in self.job()['steps'][1:]:
            with self.subTest(step=step.get('name')):
                self.assertIn("steps.credentials.outputs.present == 'true'", step['if'])

    def test_missing_app_credentials_warn_and_stop(self):
        script = self.step('Check the App credentials')['run']
        for app_id, key, present in [('', '', 'false'), ('1', '', 'false'), ('', 'k', 'false'), ('1', 'k', 'true')]:
            with self.subTest(app_id=app_id, key=key), tempfile.TemporaryDirectory() as directory:
                output, summary = pathlib.Path(directory, 'output'), pathlib.Path(directory, 'summary')
                result = subprocess.run([shutil.which('bash'), '-c', script], env={
                    'PATH': os.environ['PATH'], 'APP_ID': app_id, 'APP_PRIVATE_KEY': key,
                    'GITHUB_OUTPUT': output.as_posix(), 'GITHUB_STEP_SUMMARY': summary.as_posix(),
                }, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(output.read_text(), f'present={present}\n')
                if present == 'false':
                    self.assertIn('::warning', result.stdout)
                    self.assertIn('never falls back to GITHUB_TOKEN', summary.read_text())
                else:
                    self.assertFalse(summary.exists() and summary.read_text())

    def test_apply_step_issues_only_the_decided_gh_calls(self):
        script = self.step('Apply the decision')['run']
        sha = 'b' * 40
        expected = {
            'enable': [f'pr merge 9 --auto --squash --match-head-commit {sha}'],
            'rearm': ['pr merge 9 --disable-auto', f'pr merge 9 --auto --squash --match-head-commit {sha}'],
            'disable': ['pr merge 9 --disable-auto'],
        }
        for action, head, token in [*[(action, sha, 'app-token') for action in expected],
                                    ('unknown', sha, 'app-token'), ('enable', 'HEAD', 'app-token'),
                                    ('enable', sha, '')]:
            with self.subTest(action=action, head=head, token=token), tempfile.TemporaryDirectory() as directory:
                trace = pathlib.Path(directory, 'trace')
                gh = pathlib.Path(directory, 'gh')
                gh.write_text('#!/bin/sh\necho "$*" >>"$GH_TRACE"\n')
                gh.chmod(0o755)
                result = subprocess.run([shutil.which('bash'), '-c', script], env={
                    'PATH': directory + os.pathsep + os.environ['PATH'], 'GH_TRACE': trace.as_posix(),
                    'GH_TOKEN': token, 'PR_NUMBER': '9', 'ACTION': action, 'HEAD_SHA': head,
                }, capture_output=True, text=True, timeout=10)
                calls = trace.read_text().splitlines() if trace.exists() else []
                if action in expected and head == sha and token:
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertEqual(calls, expected[action])
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(calls, [])

    def test_job_guards_admit_only_staging_pull_requests_in_the_private_repository(self):
        condition = self.job()['if']
        variables = {'AUTO_MERGE_ENABLED': 'true'}

        def admitted(repository='Fabric-Pro/fabric-dev', base='staging', head_repo='Fabric-Pro/fabric-dev',
                     draft=False, action='opened', label=None, changes=None, enabled='true'):
            event = {'action': action, 'pull_request': {
                'base': {'ref': base}, 'draft': draft, 'head': {'repo': {'full_name': head_repo}}}}
            if label is not None:
                event['label'] = {'name': label}
            if changes is not None:
                event['changes'] = changes
            github = {'repository': repository, 'event_name': 'pull_request_target', 'event': event}
            return bool(gha_eval(condition, github, variables={**variables, 'AUTO_MERGE_ENABLED': enabled}))

        for action in ['opened', 'reopened', 'ready_for_review', 'synchronize']:
            self.assertTrue(admitted(action=action), action)
        self.assertFalse(admitted(repository='Fabric-Pro/fabric-oss'))
        self.assertFalse(admitted(repository='example-org/fork'))
        self.assertFalse(admitted(base='master'))
        self.assertFalse(admitted(head_repo='example-user/fork'))
        self.assertFalse(admitted(draft=True))
        self.assertFalse(admitted(enabled='false'))
        self.assertFalse(admitted(enabled=''))
        for action in ['labeled', 'unlabeled']:
            self.assertTrue(admitted(action=action, label='no-auto-merge'), action)
            self.assertFalse(admitted(action=action, label='bug'), action)
        self.assertFalse(admitted(action='edited', changes={'title': {'from': 'old'}}))
        self.assertTrue(admitted(action='edited', changes={'base': {'ref': {'from': 'master'}}}))

    def test_opt_out_label_is_shared_by_workflow_and_script(self):
        script = (ROOT / '.github/scripts/auto-merge/eligible.mjs').read_text()
        self.assertIn('export const OPT_OUT_LABEL = "no-auto-merge";', script)
        self.assertIn('export const AUTO_MERGE_REPOSITORY = "Fabric-Pro/fabric-dev";', script)
        self.assertIn('export const AUTO_MERGE_BASE = "staging";', script)
        self.assertIn("github.event.label.name == 'no-auto-merge'", self.job()['if'])


if __name__ == '__main__':
    unittest.main()
