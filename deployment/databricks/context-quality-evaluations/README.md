# Saved context-quality evaluation job

- **Audience**: Engineers provisioning isolated Databricks evaluation resources
- **Owner**: Fabric platform engineering

This job runs the complete deterministic Fabric context-quality scorer against
recorded answers and authorized, revision-pinned project source snapshots. It
retains Temporal as the execution coordinator. The earlier
[capability pilot](../context-quality-pilot/README.md) exercises synthetic tracking;
this notebook implements the production transport contract and canonical scorer.
Neither scorer generates answers or establishes semantic grounding.

## Provision and approve

Dedicate one service principal, job, MLflow experiment and Unity Catalog volume
to one Fabric project. The principal must belong to one organization; Fabric
rejects cross-organization principal reuse and cross-project resource collisions.
Native workspace administrators are trusted processing operators: they can
inspect uploaded data and alter jobs. Grant the service principal only the
required job run/view, notebook read/export, experiment edit and volume
read/write privileges, plus catalog/schema usage. Use a serverless environment
with `mlflow` installed. No SQL warehouse or Direct SQL connection is required.

From this directory, use an authenticated private CLI profile with an explicit
`auth_type`, after running the pilot's read-only preflight. Keep the real host,
identity and resource identifiers outside tracked files:

```bash
FABRIC_DATABRICKS_EXPECTED_HOST='https://example.cloud.databricks.com' \
  python bind_workspace.py --profile example-test --target test
databricks bundle validate --profile example-test --target test --var project_key=example-project
databricks bundle deploy --profile example-test --target test --var project_key=example-project
```

The host example is a placeholder. Run commands without ambient Databricks or
Azure credential overrides, using the same verified profile. The binding writer
reuses the pilot's exact-host validator and writes only a private ignored
`.databricks/workspace-bindings.yml`. The bundle fails closed without that binding.
The volume must already exist; this bundle creates the job and experiment, has
one notebook task, and installs no schedule, continuous trigger or task retry.
Use a different project key for each project and each promotion environment.

Configure an organization-shared Databricks platform connection in Fabric, then
approve the project's job, experiment and volume binding. Fabric reads the job
configuration and notebook SOURCE export, records its actual SHA256, and checks
it again before export and dispatch. Updating the notebook requires administrator
reapproval. Provisioning a bundle does not enable source export or approve a
project binding by itself. Promote to staging and production only after that
environment's permissions, export approval and end-to-end qualification succeed.

## Data and execution contract

An activity privately reads the bounded immutable snapshot from the database,
rechecks requester access and source revisions, and uploads exact JSON bytes
through Files API 2.0 with `overwrite=false`. Its only path is
`<approved-volume-root>/<fabric-run-id>.json`; a retry reconciles an existing file
by SHA256. Temporal input and activity output contain IDs and status only.

The job accepts only `snapshot_path`, `payload_hash`, `fabric_run_id` and
`experiment_id`. It verifies the bytes, runs the canonical checks, logs counts and
provenance hashes to MLflow, verifies tracking readback, and exits with a bounded
safe report receipt. It logs no source bodies, answers or expectations. Fabric
compares the entire receipt report with its local canonical result, repeats live
access checks, then makes the result available through the saved run.

Jobs admission uses a stable native idempotency token. Ambiguous admission after
cancellation or revocation uses bounded read-only lookup, never another run-now
request. Unconfirmed execution stays `RECONCILIATION_REQUIRED`. Cancellation means
that Fabric discards the result and has confirmed the native execution is terminal;
it cannot undo work already performed. Remote input deletion has a separate
`PENDING`, `CONFIRMED` or `BLOCKED` receipt; successful evaluation does not imply
successful deletion. Recovery can retry purpose-limited cancellation and exact-file
cleanup using the frozen original principal after requester revocation. Local
inputs are scrubbed on settlement; expiry is independent of remote erasure. Long native-job polling uses the dedicated `context-quality` queue.

## Verify locally

From the repository root:

```bash
python3 -m unittest discover -s deployment/databricks/context-quality-evaluations/tests -v
pnpm --filter @repo/rag exec vitest run lib/context-quality/__tests__/python-parity.test.ts
pnpm --filter @repo/databricks exec vitest run __tests__/evaluation-job.test.ts
pnpm --filter @repo/temporal exec vitest run src/activities/__tests__/context-quality-evaluation.test.ts __tests__/context-quality-evaluation-replay.test.ts
```

The parity test executes Python and TypeScript and compares complete reports and
hashes, including Unicode edge cases. The workflow test records and replays actual
success and cancellation histories against a local Temporal test server. The
remaining suites use controlled transport and tracking clients. They do not prove
cloud permissions, deployed notebook identity, real Files API behavior or
production readiness. Qualify those through an isolated project and inspect the
saved Fabric run, native job task receipt, MLflow counts and remote erasure receipt.
