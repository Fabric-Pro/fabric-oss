# Governed delivery analytics

- **Audience**: Fabric platform operators and delivery analytics engineers
- **Owner**: Fabric platform engineering

This directory contains an **offline, operator-only renderer**, not a deployed integration. It builds a fixed-audience projection of approved story and coding-run transition metadata. It does not export private Slack messages, observations, summaries, embeddings or source grants. The unbound `databricks.yml` deliberately contains no resources and an unresolved required variable; deploying it cannot create cross-organization analytical views.

## Trusted audience binding

An operator must approve one organization, a nonempty allowlist of at most 50 projects, a dedicated query service principal, a different deployment service principal, separate source and destination schemas, one warehouse and one exact workspace/profile. Keep the binding and generated bundles outside the public checkout. No credentials belong in the JSON. The profile is checked using the existing [pilot workspace binding validator](../context-quality-pilot/bind_workspace.py); this checks local host/auth configuration only, without authenticating or asserting that the principal is entitled to read data.

For example, an operator-owned private binding has this shape (all values below are synthetic):

```json
{
  "version": 1,
  "audience_id": "example_audience",
  "organization_id": "example-org",
  "project_ids": ["example-project"],
  "source": {"catalog": "example_source", "schema": "example_events"},
  "destination": {"catalog": "example_destination", "schema": "example_delivery"},
  "query_principal": "11111111-1111-4111-8111-111111111111",
  "deployment_principal": "22222222-2222-4222-8222-222222222222",
  "warehouse_id": "example_warehouse",
  "workspace_host": "https://example.azuredatabricks.net",
  "target": "test"
}
```

`source` always refers to `lb_delivery_event_history`, the CDF destination of the approved `lakehouse_export.delivery_event` contract. Source and destination may share a catalog but must use distinct catalog/schema pairs. UC names use lowercase ASCII letters, digits and underscores. Organization/project identifiers are bounded UTF-8 strings encoded as SQL hex literals; they cannot introduce SQL syntax or bundle substitutions. Duplicate JSON keys, unknown fields, an empty audience, ambiguous identities, symlinked output and overwriting an existing output directory are refused. New output directories and files are private (0700/0600).

Render with Python 3.10+ and an existing profile whose host matches the binding and whose `auth_type` is explicit:

```bash
python3 deployment/databricks/delivery-analytics/render.py \
  --binding /private/example-binding.json \
  --profile EXAMPLE \
  --output /private/example-delivery-rendered
```

Rendering makes no cloud calls. It creates `views/` and `genie/` bundles plus a private `binding.json`. Never retarget an existing audience's bundle state or reuse its destination schema or query principal for another audience. An audience change requires a new isolated binding and revocation of the old binding. The renderer cannot prove that a UUID is dedicated or that existing UC/inherited grants are safe; those are live operator qualification requirements.

## Explicit deployment sequence

Generated resources use the direct bundle engine and require Databricks CLI 1.7.0 or later. The metric metadata requires YAML 1.1 and supported compute (Databricks Runtime 17.3+ or a qualifying SQL warehouse). There is no ingestion scheduler or automatic refresh schedule. Each step below is an explicit operator action; rendering does not perform it.

1. Qualify the selected workspace/profile and both principals. Pre-create a dedicated destination schema. Verify that the deployment principal can read only the intended approved history and create the destination views, and that the query principal has no source/history access, schema ownership, broad inherited SELECT, ability to alter the views or membership shared with a different audience. Do not grant these privileges globally to make a deployment work.
2. In the rendered `views/` directory, validate and deploy its bundle, then explicitly run `apply_delivery_views`. The finite job applies the bounded event/current/fact/daily/duration/metric views in dependency order and finally grants only destination usage and SELECT on the four public analytical assets to the exact query principal. It runs as the pinned deployment principal. It does not grant any source privilege or create a Lakebase feed.
3. Verify those views using the **actual query principal**. Check `session_user()` against the UUID in the binding, positive allowed rows, foreign organizations/projects, an unauthorized principal, CDC updates/deletes/redactions, UTC day boundaries and capture lag. Confirm there are no other permitted data paths. A mismatched identity must see no rows. Views depend on owner privileges and native UC behavior, so local SQLite fixtures do not qualify these controls.
4. Only after the views exist and qualification succeeds, validate and deploy the separate `genie/` bundle. Its inline `serialized_space` attaches the bounded current/duration views and the metric view as a native `metric_views` source; no file-path variable substitution is assumed. Its explicit `CAN_RUN` ACL contains only the query principal. Inspect actual effective ACLs after deployment, including inherited access and privileged owners/admins.
5. Test Genie under the same qualified identity. Databricks uses the calling UC identity for data, while author credentials supply warehouse access. A shared service principal is not the Fabric viewer. Fabric must independently check current actor/project access before dispatch and before disclosing results, or qualify a supported per-user identity mapping. No Fabric API, UI, OBO mapping or query dispatch is wired by this renderer.

The event view also checks `session_user()` against the fixed query principal after CDC collapse; prompts and user-supplied filters are never the authorization boundary. This is a bounded analytical audience, not automatic propagation of current Fabric roles, Slack ACLs or revocation. Disable disclosure and revoke the query principal's grants/Genie access immediately when the audience is withdrawn; then remove the audience assets and verify deletion of any downstream results/caches. A new narrower binding alone does not revoke an older deployed bundle.

## Data meaning and erasure

The event view collapses CDF rows **per event ID** using `_sort_by`, then `_pg_lsn`, then a deterministic delete/postimage/insert tie break. Preimages are excluded. A winning delete removes that event before any subject/event-time aggregation. Audience filtering happens after collapse so an old audience row cannot reappear when the newest CDC row is redacted, moved or deleted. An event with missing ordering metadata is suppressed. Only schema version 1 and approved subject/event types are retained. The view recomputes from the current CDF table generation; it does not retain offsets or join old generations after a re-snapshot.

`delivery_current` means the latest retained recorded subject event by event time and ID, not live operational state. Null state remains unknown. `delivery_daily` counts one first retained creation per story, one first retained PUBLISHED transition per story, and one first retained creation per coding run. Coding runs do not count as created features, and repeated postimages or repeated readiness transitions do not inflate counts. `delivery_ready_durations` uses the first retained creation and readiness events in the same organization/project/story. Missing or inconsistent creation times yield a null duration with explicit coverage. Readiness does not mean deployed, released, merged or completed.

These are **first retained recorded events**, not first lifetime events. Capture starts only after the existing opt-in export is enabled; missing pre-capture activity cannot be reconstructed. Deleting the first retained event may change the retained aggregate. Source tombstones suppress analytical rows once CDF delivers them; this is not synchronous erasure or proof of downstream cache cleanup. Lakebase CDF is asynchronous and may re-snapshot on schema changes. No watermark, lag monitor or deletion acknowledgement is implemented here; qualify those before using analytics for product decisions.

Native metric YAML `comment` and `synonyms` fields provide semantic meaning to UC/Genie. They contain only the approved metric definitions, with no external-knowledge-source or generic Ontology snippet publication.

## Offline validation

```bash
python3 -m unittest discover \
  -s deployment/databricks/delivery-analytics -p 'test_*.py' -v
```

The relational tests execute rendered SQL in SQLite with dialect-only DDL/name/function adaptations. They prove fixture logic for CDC collapse, tombstones, first readiness, counts, unknown durations, audience/identity predicates, source generation replacement and SQL escaping. They do not execute Databricks SQL or prove native UC authorization, view-owner behavior, principal mapping, warehouse support, query plans, source ingestion, Genie answers or cloud deployment.

One test invokes only the local `databricks bundle schema` command and validates both generated configs with Node.js/Ajv 8 (`ajv/dist/2020`). This is a static schema check, not `bundle validate`, which may authenticate and resolve cloud resources. Missing executables/dependencies fail the test rather than passing as certification.

The canonical capability and privacy reference is [Databricks capabilities for live Fabric recommendations](../../../docs/research/fabric-live-awareness-databricks.md). Primary references: [Lakebase CDF](https://learn.microsoft.com/en-us/azure/databricks/oltp/projects/lakebase-cdf), [session_user](https://docs.databricks.com/aws/en/sql/language-manual/functions/session_user), [bundle Genie resources](https://docs.databricks.com/aws/en/dev-tools/bundles/resources), [Genie identity and access](https://learn.microsoft.com/en-us/azure/databricks/genie-agents/set-up), and [native metric metadata](https://learn.microsoft.com/en-us/azure/databricks/uc-semantics/agent-metadata).
