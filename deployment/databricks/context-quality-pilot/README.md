# Context-quality capability pilot

Synthetic MLflow tracking and serverless execution qualification for an isolated
Databricks workspace.

- **Audience**: Engineers qualifying Databricks test and promotion environments
- **Owner**: Fabric platform engineering

This is an experimental capability probe. It runs four fixed recorded answers:
one must pass; three must be rejected for a missing phrase, a forbidden phrase,
or a missing declared citation. A successful pilot means that all four expected
outcomes were observed and the metrics, hashes and runtime versions were written
to and read back from MLflow. It does not mean that every answer passed.

The notebook calls no models, retrieval systems, Fabric APIs or databases. It
logs no source bodies, answers or citation labels. Its simplified exact-match
checks are **not** the Fabric TypeScript context-quality scorer, and do not prove
retrieval quality, semantic grounding, tenant isolation or product integration.

## Run without a workspace

From the repository root:

```bash
python -m unittest discover -s deployment/databricks/context-quality-pilot/tests -v
```

These tests use a fake tracking client to prove that wrong scoring expectations,
lost writes, unfinished runs and tracking errors fail. They provide no evidence
about a real Databricks connection. The Databricks Context Quality Pilot Tests
workflow runs this same dependency-free suite on matching pull requests and
pushes; it receives no workspace credentials and makes no cloud calls.

## Check a workspace before deployment

From the repository root, supply the expected workspace origin privately and
select an authenticated CLI profile with an explicit `auth_type` (the CLI OAuth
login flow sets this). Host-only profiles are rejected. The example origin is a placeholder:

```bash
FABRIC_DATABRICKS_EXPECTED_HOST='https://example.cloud.databricks.com' \
  python deployment/databricks/context-quality-pilot/preflight.py --profile example-test
```

The preflight validates the exact profile host before making read-only identity,
experiment, job, SQL warehouse and Lakebase project requests. Ambient
`DATABRICKS_*` host, token and profile overrides are removed; the operator's
`DATABRICKS_CONFIG_FILE` and existing `DATABRICKS_AUTH_STORAGE` choice are retained.
Azure `ARM_*` and `AZURE_*` environment overrides are also removed. This verifies
an active identity using the profile's chosen authentication mechanism; it does
not compare that identity with an expected principal or prove production role parity.
This isolation applies to the preflight subprocesses only. Run the separate
bundle commands in a shell without ambient Databricks host, token or identity
overrides, using the same verified profile and configuration file.
Output contains availability flags and observed counts, without resource names,
IDs, identities or raw error bodies. Job and experiment counts sample at most
ten records; they are not complete inventories. A zero count establishes API
availability only, not resource existence, privileges or deployment readiness.

Exit code one means the expected workspace did not match or at least one check
was unavailable. An optional capability being unavailable does not by itself
block an unrelated pilot; inspect which check failed. This preflight creates
no resources, enables no Search features and runs no database migration.
`missing_workspace_access` and `missing_sql_access` identify workspace access
entitlements that an administrator must grant; a paid subscription and successful
login alone do not establish them. See the [Azure entitlement guide](https://learn.microsoft.com/en-us/azure/databricks/security/auth/entitlements).

## Run in the Databricks UI

Import `src/context_quality_pilot.py` as a **Python notebook** into an isolated
workspace folder, create the folder `/Shared/fabric-context-quality-pilot/experiments`,
choose serverless compute and run all cells. The default
`target` widget is `test`; the notebook creates or reuses the experiment
`/Shared/fabric-context-quality-pilot/experiments/test` and adds one run per invocation.
It requires a serverless environment that already includes `mlflow`; missing
packages and tracking permissions fail explicitly, without a silent fallback.

Expected final output has `status: verified`, `case_count: 4`, `accepted_count: 1`
and `rejected_count: 3`, along with runtime versions and provenance hashes.
`dataset_sha256` hashes the fixed cases; `rules_sha256` hashes the versioned rule
description, not Python source. Pin the notebook revision separately for promotion.
The receipt also includes `target` and `experiment_path`; the path must be
canonical and its final name must equal the target or end with `-<target>`.
Open **Experiments**, select the pilot experiment and inspect the run metrics.
The three rejected answers are deliberate checks. Any failed assertion, missing
dependency, quota failure or API error means the pilot has not passed.

## Reproduce as a job

Authenticate a private Databricks CLI profile for the intended workspace using
the supported login flow. Do not put its host, identity or credentials in this
directory. From this directory:

```bash
FABRIC_DATABRICKS_EXPECTED_HOST='https://example.cloud.databricks.com' \
  python bind_workspace.py --profile example-test --target test
databricks bundle validate --profile example-test --target test
databricks bundle deploy --profile example-test --target test
databricks bundle run --profile example-test --target test context_quality_pilot
```

The bundle manages an experiment under the operator's private user directory
and passes its path to the notebook's `experiment_path` widget. Bundle deployment
files use the operator's `.bundle` directory. The optional manual notebook default
under `/Shared` is for synthetic examples only; it is not a permission boundary.
Manual runs at the same shared path intermix across operators. The bundle's
host defaults to an unconfigured reserved domain: `bind_workspace.py` verifies
the selected profile host and explicit authentication mechanism, then writes only
that target's host into the git-ignored `.databricks/workspace-bindings.yml` file.
It does not contact the cloud or store credentials. Configure each target
separately using its own expected host and profile; unbound targets must fail.
An existing target cannot be rebound to a different host because its deployment
state belongs to the original workspace. Use separate local bundle copies for
independent test workspaces, copying source files without `.databricks` state.
Never commit that local file. A target name alone does not identify a workspace.
Authentication fields cannot use custom bundle variables; see the
[Databricks configuration reference](https://docs.databricks.com/aws/en/dev-tools/bundles/reference).

For machine-readable results, get the notebook task's run ID from `jobs get-run`,
then use `jobs get-run-output` for that task. The notebook returns its verified
JSON receipt through `dbutils.notebook.exit`; failed checks fail the job rather
than returning a success receipt. The receipt is a runtime record and may contain
the operator's private workspace path; do not commit it.

The bundle declares one serverless notebook task, no schedule, no automatic
retries, concurrency one and bounded timeouts. It creates no Lakebase project,
catalog, table, model endpoint or production resource. The job definition relies
on the notebook serverless base environment for MLflow and must be qualified in
each workspace. A second execution creates another MLflow run; there is no
exactly-once claim or deduplication of tracking effects.

## Promote the artifact

Use the same reviewed notebook and bundle revision with separate CLI profiles
and `staging` or `prod` targets. The target changes job, deployment and experiment
paths. Deployment directories and experiment objects have different paths to
avoid collisions. It does not authorize running against a different workspace:
verify the private profile host and identity before deployment. Do not copy test data,
credentials, experiment IDs or run IDs into later environments or the repository.
The `staging` and `prod` targets are available configurations, not evidence that
those environments have been deployed or qualified.

Production already using Lakebase does not require a database migration for this
probe. Future Fabric evaluation persistence needs a separately reviewed additive
Prisma migration, tenant/RLS tests and the existing [database promotion path](../../../docs/database-promotion.md).
Keep Temporal as the durable Fabric orchestrator; this job is only an isolated
compute target and does not replace Temporal schedules or workflows.

Free Edition is quota limited and intended for non-commercial learning and
experimentation. Use a trial or paid workspace to qualify commercial deployment,
service identities, networking and production permissions. Consult the current
[Free Edition limits](https://docs.databricks.com/aws/en/getting-started/free-edition-limitations)
and [serverless job bundle examples](https://docs.databricks.com/aws/en/dev-tools/bundles/examples).
For hosted Fabric environments, the canonical deployment pipeline lives outside
this repository; see the [Azure deployment guide](../../azure/README.md) before
actual environment promotion.
