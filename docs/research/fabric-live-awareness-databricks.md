# Databricks capabilities for live Fabric recommendations

Verified backend capabilities and implementation seams for evidence-backed delivery recommendations.

- **Audience**: Fabric product, delivery, AI, security and platform engineers
- **Owner**: Fabric product and platform engineering
- **Status**: Research reference; capability availability is not deployment qualification
- **Verified**: 2026-11-06

This note supplies implementation facts for the [software factory sequence](../features/software-factory.md#s2--complete-bounded-source-capture-and-triage-commands). The [Databricks-backed context platform](../features/databricks-context-platform.md) remains the canonical backend architecture and qualification plan.

## Product meaning

For this feature, a self-aware application can identify the user's currently accessible work, its exact state and evidence, observed failures, missing knowledge, and the next permitted action. It also knows when an observation is incomplete, stale, unavailable or contradicted. An AI explanation cannot establish a permission, successful execution, complete capture, deployment, or causal relationship.

Operational state and dispatch decisions should continue to come from Fabric's authorized records and native Temporal execution. Databricks can enrich that state with governed historical analysis, semantic context and evaluation results. This split is a Fabric design inference from the capability boundaries below, rather than a claim that Databricks provides a universal live application-awareness API.

## Verified capability boundaries

| Backend capability | Verified role | Consequence for Fabric |
| --- | --- | --- |
| Lakebase PostgreSQL | Direct access uses PostgreSQL roles; it is distinct from the read-only, Unity Catalog registration route, which requires serverless compute | Preserve Fabric's current actor/project checks and PostgreSQL RLS. Do not describe UC registration as protection for every direct Prisma query. |
| Unity Catalog and Delta analytical projections | UC registration provides analytical discovery, governance, lineage and read-only cross-source queries | Publish a deliberately limited delivery projection. Measure ingestion lag and acknowledge deletions; do not imply every operational change has already reached analysis. |
| Databricks Genie Agents, formerly Spaces | Analytical agents use attached permitted assets. Author credentials supply warehouse compute access, while data permissions are evaluated for the calling UC identity | A shared service principal represents that principal, not automatically the Fabric viewer. Use qualified identity mapping or physically isolated, audience-limited resources and repeat Fabric disclosure checks. |
| Genie Ontology | Semantic definitions and inferred snippets support the Genie family; the current Azure guide marks it Public Preview | Use as optional semantic enrichment for approved analytical assets. It is not Fabric's canonical project context store or a required dependency for source capture. |
| Databricks AI Search, formerly Vector Search | Managed hybrid/vector retrieval with index ACLs and filter support; row/column permission enforcement is not supported | Construct trusted organization/project/audience filters server-side and validate current source access. A filtered index is still a derived copy whose erasure must be verified. |
| MLflow 3 evaluation | Code-based scorers and model judges attach feedback to traces and support repeatable evaluation datasets | Compare exact Fabric agent/prompt/workflow versions, and expose understandable failure examples in Fabric. Separate deterministic checks from model opinion. |

Lakebase's two access paths are documented in [Query from SQL editor](https://learn.microsoft.com/en-us/azure/databricks/oltp/projects/query-sql-editor); native Genie identity behavior is documented in [Create and manage a Genie Agent](https://learn.microsoft.com/en-us/azure/databricks/genie-agents/set-up). These permission paths require explicit integration tests; source possession or administrative workspace access is insufficient.

The current [Genie Ontology guide](https://learn.microsoft.com/en-us/azure/databricks/genie/genie-ontology) distinguishes UC-derived semantics/snippets from external knowledge sources. It explicitly says external-knowledge-source snippets are available to all users in the Databricks account. That route is unsuitable for private customer, project or Slack evidence. The reviewed guide does not establish a generic public inferred-snippet CRUD/search interface. Fabric must not promise one from source-package naming alone.

[AI Search documentation](https://learn.microsoft.com/en-us/azure/databricks/ai-search/ai-search) explicitly excludes row/column permissions. [Index synchronization documentation](https://learn.microsoft.com/en-us/azure/databricks/ai-search/create-ai-search) describes continuous synchronization with seconds of latency on standard endpoints and explicitly triggered synchronization; storage-optimized endpoints support triggered synchronization only. Treat freshness as an observed watermark, not a transactional guarantee.

[MLflow evaluation](https://learn.microsoft.com/en-us/azure/databricks/mlflow3/genai/eval-monitor/) supports reusable scorers and version comparisons. [Managed production monitoring](https://learn.microsoft.com/en-us/azure/databricks/mlflow3/genai/eval-monitor/production-monitoring) is Beta, samples incoming traces, needs instrumented production traces and configured resources, and runs under the first scorer registrant's identity. It cannot be required for initial recommendations. Fabric can retain Temporal-coordinated evaluation jobs and add qualified managed monitoring later.

## Existing implementation to reuse

These are source findings, not fresh cloud acceptance results:

| Existing implementation | Reuse and remaining work |
| --- | --- |
| [Dashboard delivery insights](../../packages/database/prisma/queries/dashboard-delivery-insights.ts), [My work](../../packages/database/prisma/queries/dashboard-my-work.ts), [dashboard composition](../../apps/web/modules/saas/dashboard/components/OrganizationDashboard.tsx) | Already derive current user-reachable operational work. The dashboard polls work and delivery insights every five minutes. Add bounded invalidation/update events and explicit source freshness rather than putting Genie queries in every page render. |
| [Current recommendation rules](../../apps/web/modules/saas/dashboard/lib/curated-model.ts) | Client-side deterministic selection of action/project/static guidance. It currently has no Databricks reasoning, evaluation feedback or evidence-aware context-gap assessment. Move future recommendation eligibility/ranking behind one authorized query shared by transports. |
| [Delivery event capture migration](../../packages/database/prisma/migrations/20261106130000_delivery_analytics_capture/migration.sql), [analytical bundle](../../deployment/databricks/delivery-analytics/databricks.yml) | Existing opt-in, content-free story/coding-run transition capture plus current/daily/metric-view and Genie resource assets. Preserve this bounded metadata contract. Source files do not prove the migration, ingestion, views or Genie binding are deployed. Validate deployment variables, source/target generation, identity, coverage and watermark before use. |
| [Genie REST client](../../packages/databricks/src/genie-lakebase.ts) | Existing conversation, message polling and SQL/result attachment plumbing. Repository search found exports and tests, but no established production caller outside this package. Connecting Fabric Genie to it remains integration work. |
| [AI Search adapter](../../packages/integrations/src/databricks-vector-search/index.ts) | Existing selected-index hybrid query path; its current request has no trusted per-row audience filter. It must not be reused as a shared private-source index without additional authorization and erasure work. |
| [Saved context-quality commands](../../packages/api/modules/context-quality/lib/saved-commands.ts), [bound job transport](../../packages/databricks/src/evaluation-job.ts), [evaluation job contract](../../deployment/databricks/context-quality-evaluations/README.md) | Existing version-pinned snapshots, approved resource bindings, stable native admission, result verification and separate remote-erasure receipts. Extend these patterns for recommendation/triage evaluation rather than inventing another job lifecycle. Current deterministic context scoring does not prove semantic answer correctness. |
| [Harness finite adapter](../../packages/agent-runtime/src/harness/index.ts) | Existing qualified-release and remote-admission seam. Reuse it for bounded triage agents under Temporal coordination; package presence does not qualify a deployed Remote Server target. |

## Bound delivery analytics implementation

The [delivery analytics renderer](../../deployment/databricks/delivery-analytics/README.md) now produces private, operator-bound bundles for one fixed organization, a bounded project allowlist and a dedicated query principal. Its unbound base configuration has no deployable resources. It reuses the pilot's profile/host validator and separates the manually applied views from the inline Genie resource. This is offline hardening, not evidence of deployed assets, native identity mapping or current Fabric viewer authorization.

[Lakebase CDF](https://learn.microsoft.com/en-us/azure/databricks/oltp/projects/lakebase-cdf) supplies `_sort_by` and `_pg_lsn` ordering metadata and explicit insert/postimage/delete types; event timestamps do not order erasure. The projection collapses CDC per event ID before audience filtering or subject aggregates, suppresses tombstones, and derives first retained creation/readiness facts once per subject. CDF is asynchronous and schema changes can replace the destination generation. These views neither certify complete lifetime capture nor synchronous deletion.

The fixed audience is enforced in generated SQL, including a [session_user](https://docs.databricks.com/aws/en/sql/language-manual/functions/session_user) UUID fence, and in the explicit Genie ACL. Genie instructions cannot authorize an audience. The native [serialized Genie format](https://docs.databricks.com/api/genie/v1/update-space) distinguishes attached tables from `metric_views`; inline [bundle resource definitions](https://docs.databricks.com/aws/en/dev-tools/bundles/resources) avoid assuming substitutions inside a JSON file. Effective UC privileges, view-owner/session identity behavior and service-principal-to-Fabric-viewer mapping still require live qualification.

[Native metric metadata](https://learn.microsoft.com/en-us/azure/databricks/uc-semantics/agent-metadata) supports `comment`, display names and synonyms with YAML 1.1 on qualifying compute (Runtime 17.3+). The delivery definitions use approved metric comments/synonyms directly. This supplies governed semantic context without publishing private source text or external-knowledge snippets to Genie Ontology.

## Privacy and freshness acceptance

Private source capture starts as owner-only. Never copy its message text, embeddings, summaries, inferred facts or model traces into organization analytics, shared ontology, project context or search merely because the person can open the project. Derived information retains the source audience until deliberate, authorized publication establishes a different audience. A model cannot widen that audience.

Before a private-source-backed recommendation or evidence drawer returns data, repeat current Fabric actor/object permissions and the qualified provider ACL/revision check. A UC role, cached membership, content hash, successful earlier capture or current project membership is not an equivalent source permission. Every background export must enforce its own processing authorization and pin the intended destination and audience.

Require observable expiry/revocation across snapshots, search rows and embeddings, analytical projections, evaluation inputs, traces and cached recommendations. Suppress disclosure immediately while physical cleanup is pending. Test a disconnected Slack installation, removed channel membership, deleted/edited message, project-role revocation and cross-organization request. No raw source body belongs in workflow history, logs, generic notifications or audit metadata.

An eventual recommendation contract should expose stable identity, subject/revision, reason, source references, observation time, source watermark, coverage, expiry, current action eligibility and ranking/policy version. Distinguish live operational facts, delayed analytics and optional model interpretation. Expired or unqualified enrichment is omitted or labelled unavailable; healthy operational actions should still work when Databricks analysis is unavailable. Feedback such as dismissal or snooze is per actor and reason revision, so a materially changed failure can reappear without reviving unchanged noise.

Qualification should prove one complete chain: a selected Slack source is captured durably; an authorized finite Harness triager proposes a cited change; a person reviews it; exact-version execution and validation evidence become visible; a recommendation resolves when its underlying state changes. Measure unauthorized disclosure, unsupported claims, stale actions, duplicates, dismissal recurrence and time to useful action before expanding autonomy.
