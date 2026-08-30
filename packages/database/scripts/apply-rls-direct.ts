#!/usr/bin/env npx tsx
/**
 * Apply RLS Policies Directly
 * This script applies RLS policies directly to the database without
 * going through Prisma migrations. Use this for local development.
 * Usage:
 * pnpm --filter @repo/database apply:rls
 */

import { pathToFileURL } from "node:url";
import { db } from "../prisma/client";

async function applyRLS() {
	console.log("🔒 Applying RLS policies to local database...\n");

	try {
		// Test connection
		await db.$queryRaw`SELECT 1`;
		console.log("✓ Connected to database");

		// Step 0: Provision the worker role (cloud deploys only).
		// The Temporal worker uses raw `db` with no per-request tenant context, so
		// under FORCE ROW LEVEL SECURITY it must connect as a role that BYPASSES RLS
		// — mirroring how a superuser/owner connection bypasses locally and on Neon.
		// When WORKER_DB_PASSWORD is set (AWS deploy injects it from the
		// fabric/<env>/database-worker secret), ensure a dedicated `fabric_worker`
		// LOGIN role and grant it DML on the public schema. Skipped when unset
		// (local dev / Azure-Neon), so behavior there is unchanged.
		//
		// WORKER_RLS_MODE controls how the worker bypasses per-tenant RLS:
		//   "bypassrls" (default) — role attribute BYPASSRLS; standard Neon/AWS path.
		//   "policy"              — role attribute NOBYPASSRLS; managed Postgres hosts
		//     (e.g. Databricks Lakebase) may not permit BYPASSRLS for non-superuser
		//     roles. In that mode the worker instead receives an explicit permissive
		//     per-table policy (worker_bypass, created in the table loop below) that
		//     OR-combines with tenant_isolation and survives FORCE ROW LEVEL SECURITY.
		const workerPwd = process.env.WORKER_DB_PASSWORD;
		// Managed Postgres (e.g. Databricks Lakebase) blocks the app role from
		// CREATE/ALTER ROLE, and grants no one the superuser needed to set the
		// BYPASSRLS attribute — so fabric_worker must be provisioned out-of-band
		// by an admin. Set WORKER_ROLE_PREPROVISIONED=true in that case: the
		// script then skips role + grant management (which the app role can't do)
		// and only attaches the worker_bypass policies (which the table-owning app
		// role can). See docs/deployment/DATABRICKS.md §2.2 for admin role setup.
		const workerPreprovisioned = /^(1|true|yes)$/i.test(
			(process.env.WORKER_ROLE_PREPROVISIONED ?? "").trim(),
		);
		const workerEnabled = !!workerPwd || workerPreprovisioned;
		const workerRlsMode = (process.env.WORKER_RLS_MODE ?? "bypassrls")
			.trim()
			.toLowerCase();
		if (workerRlsMode !== "bypassrls" && workerRlsMode !== "policy") {
			throw new Error(
				`Unsupported WORKER_RLS_MODE "${workerRlsMode}" — expected "bypassrls" or "policy"`,
			);
		}
		if (workerPreprovisioned) {
			// Admin manages the role + its grants; just confirm it exists so the
			// worker_bypass CREATE POLICY below fails loudly, not cryptically.
			const exists = await db.$queryRaw<Array<{ ok: number }>>`
				SELECT 1 AS ok FROM pg_roles WHERE rolname = 'fabric_worker'
			`;
			if (exists.length === 0) {
				throw new Error(
					'WORKER_ROLE_PREPROVISIONED=true but role "fabric_worker" does not exist — create it and its schema/DML grants as an admin first (docs/deployment/DATABRICKS.md §2.2).',
				);
			}
			console.log(
				`\n👷 fabric_worker: pre-provisioned — skipping role/grant management, applying worker_bypass policies only (mode: ${workerRlsMode}).`,
			);
		} else if (workerPwd) {
			// Script-managed role: needs a connection that can CREATE/ALTER roles
			// (and superuser for BYPASSRLS in bypassrls mode). Standard Neon/AWS
			// path. Only emit an RLS attribute when it must change: BYPASSRLS needs
			// superuser, and NOBYPASSRLS is the default — stating it explicitly would
			// needlessly trip the same superuser check, so omit it in policy mode.
			const rlsAttr = workerRlsMode === "policy" ? "" : " BYPASSRLS";
			console.log(
				`\n👷 Ensuring fabric_worker role (mode: ${workerRlsMode})...`,
			);
			// special=false password (alphanumeric); double any quote defensively.
			const esc = workerPwd.replace(/'/g, "''");
			await db.$executeRawUnsafe(
				`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fabric_worker') THEN CREATE ROLE fabric_worker LOGIN PASSWORD '${esc}'${rlsAttr}; END IF; END $$;`,
			);
			// Idempotently reconcile the attributes + password on every run.
			await db.$executeRawUnsafe(
				`ALTER ROLE fabric_worker WITH LOGIN PASSWORD '${esc}'${rlsAttr};`,
			);
			// DML on current + future tables/sequences (migrations run as the owner
			// just before this, so ALTER DEFAULT PRIVILEGES covers future objects).
			await db.$executeRawUnsafe(
				"GRANT USAGE ON SCHEMA public TO fabric_worker;",
			);
			await db.$executeRawUnsafe(
				"GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO fabric_worker;",
			);
			await db.$executeRawUnsafe(
				"GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO fabric_worker;",
			);
			await db.$executeRawUnsafe(
				"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO fabric_worker;",
			);
			await db.$executeRawUnsafe(
				"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO fabric_worker;",
			);
			console.log(
				`   ✓ fabric_worker ensured (LOGIN${rlsAttr}, schema DML grants)`,
			);
		} else {
			console.log(
				"\n👷 WORKER_DB_PASSWORD unset — skipping fabric_worker role (worker shares the app role; fine where that connection already bypasses RLS).",
			);
		}

		// On Neon, the app role bypassed RLS implicitly via neon_superuser
		// membership. Managed Postgres (e.g. Databricks Lakebase) grants no
		// such membership, and the query layer's raw `db` client with
		// explicit tenant WHERE filters (see packages/database/prisma/queries/
		// projects/publishing-suite.ts ~line 569) is the documented isolation
		// boundary — so under FORCE ROW LEVEL SECURITY with no tenant context,
		// every raw-db query returns zero rows. Set APP_RLS_BYPASS=true on
		// such hosts: the table loop below then attaches an explicit
		// permissive per-table policy (app_bypass, mirroring worker_bypass) to
		// `fabric_app`. Requires the fabric_app role to already exist (it owns
		// the tables on those hosts).
		const appRlsBypass = /^(1|true|yes)$/i.test(
			(process.env.APP_RLS_BYPASS ?? "").trim(),
		);
		if (appRlsBypass) {
			console.log(
				"\n🔓 APP_RLS_BYPASS=true — fabric_app will receive per-table app_bypass policies.",
			);
		}

		// Step 1: Create helper functions
		console.log("\n📦 Creating helper functions...");

		await db.$executeRawUnsafe(`
			CREATE OR REPLACE FUNCTION current_tenant_type() RETURNS TEXT AS $$
			BEGIN
			  RETURN COALESCE(current_setting('app.tenant_type', true), 'none');
			END;
			$$ LANGUAGE plpgsql STABLE;
		`);

		await db.$executeRawUnsafe(`
			CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS TEXT AS $$
			BEGIN
			  RETURN current_setting('app.tenant_id', true);
			END;
			$$ LANGUAGE plpgsql STABLE;
		`);

		await db.$executeRawUnsafe(`
			CREATE OR REPLACE FUNCTION current_user_id() RETURNS TEXT AS $$
			BEGIN
			  RETURN current_setting('app.user_id', true);
			END;
			$$ LANGUAGE plpgsql STABLE;
		`);

		console.log("✓ Helper functions created");

		// Step 2: Enable RLS on tables
		console.log("\n🔐 Enabling RLS on tenant-aware tables...");

		const tables = [
			// Strict isolation: EITHER userId OR orgId, never both
			{ name: "mcp_config", policy: "per_user_within_org" },
			{ name: "mcp_server", policy: "per_user_within_org_with_system" },
			// Physical table names (snake_case @@map), NOT the PascalCase model
			// names — otherwise `ALTER TABLE "OpenAPIService"` targets a
			// nonexistent relation and the policy is silently skipped (these
			// tables hold OAuth/service credentials, so a missed policy matters).
			{ name: "openapi_service", policy: "strict" },
			{ name: "openapi_service_config", policy: "strict" },
			// ai_chat removed - migrated to user_owned for per-user isolation within orgs
			// { name: "ai_chat", policy: "strict" },
			{ name: "purchase", policy: "strict" }, // Purchases belong to user OR org
			{ name: "ai_credit_account", policy: "strict" }, // AI credit usage belongs to user OR org
			{ name: "code_symbol", policy: "strict" }, // Code symbols belong to user OR org

			// Scope-based: SYSTEM scope always visible
			{
				name: "registered_agent",
				policy: "scope",
				orgScope: "ORGANIZATION",
			},
			{ name: "prompt", policy: "scope", orgScope: "ORG" }, // PromptScope uses 'ORG' not 'ORGANIZATION'
			{
				name: "report_template",
				policy: "scope",
				orgScope: "ORGANIZATION",
			},
			{
				name: "golden_reference",
				policy: "scope",
				orgScope: "ORG", // GoldenReferenceScope uses 'ORG' not 'ORGANIZATION'
			},

			// User-owned: org sees all org data, personal sees only personal
			{ name: "agent", policy: "user_owned" },
			{ name: "agent_task", policy: "user_owned" },
			// Per-user-in-org: an org member must not read other members' rows.
			// Matches PER_USER_ORG_TABLES in tenant-db.ts.
			{ name: "agent_conversation", policy: "per_user_within_org" },
			// Document Assistant chat history (spec 2026-05-19 §3.5 FR-20).
			// Tenant-floor only — visibility (SHARED vs PRIVATE) is enforced
			// at the procedure layer so project teammates can still read each
			// other's SHARED conversations within the same org.
			{ name: "document_assistant_conversation", policy: "user_owned" },
			{ name: "ai_chat", policy: "per_user_within_org" },
			{ name: "ai_chat_mcp_config", policy: "per_user_within_org" },
			{ name: "registered_agent_suggestion", policy: "user_owned" }, // USER/ORG agent suggestion state
			{ name: "workflow", policy: "user_owned" },
			{ name: "workflow_execution", policy: "user_owned" },
			{ name: "workflow_integration", policy: "user_owned" },
			{ name: "workflow_version", policy: "user_owned" }, // Workflow version history
			{ name: "workflow_api_key", policy: "user_owned" }, // API keys for workflows
			{ name: "workflow_execution_log", policy: "user_owned" }, // Execution logs
			{ name: "project", policy: "user_owned" },
			{ name: "diagram", policy: "user_owned" }, // Excalidraw diagrams
			{ name: "project_document", policy: "user_owned" }, // Project documents
			{ name: "project_document_asset", policy: "user_owned" }, // Binary/HTML artifacts attached to generated docs
			{ name: "project_context", policy: "user_owned" }, // Project context files
			{ name: "project_context_url_page", policy: "user_owned" }, // URL Context Sources per-page crawl rows
			{
				name: "project_context_conversation_bundle",
				policy: "user_owned",
			}, // Captured Teams/Slack channel bundles hanging off a monitored channel context
			// Registered separately from the bundle table on purpose: this one holds
			// tenant-associated provider message ids and gates whether a message can
			// ever be captured, so a cross-tenant write could suppress capture through
			// a uniqueness conflict without touching any content.
			{
				name: "project_context_conversation_claim",
				policy: "user_owned",
			},
			// Stranded-vector cleanup queue: the ids an unlink still owes the
			// vector store after its rows are gone. Registered like the tables
			// it cleans up after — it names one tenant's context and bundle ids
			// and carries the organizationId that decides the collection.
			{
				name: "project_context_pending_vector_cleanup",
				policy: "user_owned",
			},
			{ name: "project_readiness_item_state", policy: "user_owned" }, // Manual readiness states (snooze / not applicable / help requested)
			{ name: "project_readiness_verdict", policy: "user_owned" }, // Last computed readiness verdict per item
			{ name: "project_context_summary", policy: "user_owned" }, // Compressed project-history summaries
			{ name: "project_rag_settings", policy: "user_owned" }, // RAG settings
			{ name: "background_job", policy: "user_owned" }, // Job Hub — background job progress rows
			// Security & accessibility scanning (project-scoped, user/org owned)
			{ name: "project_scan_config", policy: "user_owned" },
			{ name: "project_scan", policy: "user_owned" },
			{ name: "scan_finding", policy: "user_owned" },
			{ name: "scan_finding_review", policy: "user_owned" }, // on-demand AI false-positive review runs
			{ name: "scan_finding_grouping", policy: "user_owned" }, // security-finding-grouping pipeline runs
			{ name: "scan_activity", policy: "user_owned" },
			{ name: "project_scan_checkpoint", policy: "user_owned" }, // per-branch incremental scan checkpoint
			// Atlas tab — project-scoped graph data
			{ name: "atlas_analysis", policy: "user_owned" },
			{ name: "atlas_node", policy: "user_owned" },
			{ name: "atlas_edge", policy: "user_owned" },
			{ name: "atlas_analysis_run", policy: "user_owned" }, // Analysis run history (who/when/commit)
			{ name: "atlas_conversation", policy: "user_owned" }, // Persistent codebase-chat conversations
			{ name: "atlas_node_override", policy: "user_owned" }, // Stable per-node user description/category overrides
			{
				name: "atlas_node_override_history",
				policy: "user_owned",
			}, // Node override edit history
			{ name: "atlas_cross_edge", policy: "user_owned" }, // Multi-repo System map: cross-repository edges
			{ name: "atlas_cross_link", policy: "user_owned" }, // Multi-repo System map: per-project cross-link state
			{ name: "atlas_cross_link_run", policy: "user_owned" }, // Multi-repo System map: cross-link recompute (re-map) history
			{ name: "atlas_system_layout", policy: "user_owned" }, // Multi-repo System map: shared per-project node positions
			{ name: "atlas_parse_checkpoint", policy: "user_owned" }, // Structure-phase resume checkpoint (per-file FileMeta)
			{ name: "atlas_edge_override", policy: "user_owned" }, // Stable per-edge user description / manual / soft-delete overrides
			{
				name: "atlas_edge_override_history",
				policy: "user_owned",
			}, // Edge override edit history
			{ name: "project_linked_meeting", policy: "user_owned" }, // Linked meetings for transcript sync
			{ name: "project_meeting_transcript", policy: "user_owned" }, // Synced meeting transcripts
			{ name: "project_meeting_action_item", policy: "user_owned" }, // Action items extracted from meeting transcripts
			{ name: "meeting_action_item_link", policy: "user_owned" }, // Links from meeting action items to work items (#1902)
			{ name: "project_meeting_agenda", policy: "user_owned" }, // Generated pre-meeting agendas (#1901)
			{ name: "project_linked_teams_channel", policy: "user_owned" }, // Teams channels monitored for feature extraction
			{ name: "project_linked_slack_channel", policy: "user_owned" }, // Slack channels monitored for feature extraction
			{ name: "project_slack_huddle_note", policy: "user_owned" }, // Auto-synced Slack huddle AI-notes canvases
			{ name: "pending_backlog_proposal", policy: "user_owned" }, // Pending backlog proposals awaiting review
			{ name: "backlog_update_session", policy: "user_owned" }, // AI Backlog Update session log (read-only history)
			{ name: "project_presence", policy: "user_owned" }, // Presence tracking
			{ name: "project_activity", policy: "user_owned" }, // Activity feed
			{ name: "audit_log", policy: "user_owned" }, // Comprehensive audit log
			{ name: "pm_sync_log", policy: "user_owned" }, // PM tool sync audit log (mirrors audit_log: org XOR user + projectId)
			{ name: "user_story_comment", policy: "author_owned" }, // Feature comment threads and Fabric Agent replies
			{ name: "story_task_comment", policy: "author_owned" }, // Task comment threads and Fabric Agent replies
			// Feature Maturation V2 (spec 2026-06-09 §5). decision_log_entry's tenant
			// key is `userId` (not `authorId`), so it uses user_owned — org members
			// share the org's log, personal sees only their own. maturation_approval_-
			// preference is a per-USER default, so userId is required in both branches
			// → per_user_within_org.
			{ name: "decision_log_entry", policy: "user_owned" },
			{
				name: "maturation_approval_preference",
				policy: "per_user_within_org",
			},
			// Architecture Decision Log (ADL): decisions + threaded comments + version history
			{ name: "architecture_decision", policy: "user_owned" },
			{ name: "architecture_decision_comment", policy: "author_owned" },
			{ name: "architecture_decision_version", policy: "user_owned" },
			// Per-project decision-type taxonomy backing the ADL tagging metadata
			{ name: "decision_type", policy: "user_owned" },
			// Test Cases: top-level tables use denormalized tenant columns; child
			// tables inherit access through their parent rows.
			{ name: "test_case", policy: "user_owned" },
			{ name: "test_plan", policy: "user_owned" },
			{ name: "test_case_step", policy: "test_result_event" },
			{ name: "test_plan_case", policy: "test_plan_case" },
			{
				name: "test_case_work_item_link",
				policy: "test_case_work_item_link",
			},
			// AI drafting runs: carries the same denormalized tenant columns as
			// test_case, so the same policy applies.
			{ name: "test_case_draft_job", policy: "user_owned" },
			// Pipeline-result ingestion. Both are top-level tenant
			// tables carrying the same denormalized organizationId/userId columns
			// as test_case, so the same user_owned policy applies. The per-case
			// result rows they produce live in test_result_event (parent-scoped).
			{ name: "test_pipeline_run", policy: "user_owned" },
			{ name: "test_finding", policy: "user_owned" },
			{ name: "test_pipeline_sync_state", policy: "user_owned" },
			// Fabric-orchestrated runs. Top-level tenant table with
			// the same denormalized columns as test_pipeline_run — it is the
			// dispatch envelope, while the results it produces are ordinary
			// pipeline-run/result-event rows already covered above.
			{ name: "test_agentic_run", policy: "user_owned" },
			// Saved run configurations (mocks C8). Same denormalized tenant
			// columns as the runs they configure.
			{ name: "test_run_configuration", policy: "user_owned" },
			// Per-batch staging rows for a Fabric run (spec F3). Carries the same
			// denormalized tenant columns as its parent run, so it takes the same
			// policy rather than a parent walk.
			{ name: "test_agentic_case_result", policy: "user_owned" },
			// Deliberately FK-less (see the model): the tenant columns still carry the
			// isolation predicate, and user_owned compares values rather than relations.
			{ name: "test_run_evidence", policy: "user_owned" },
			// Per-project QA policy + the deployment targets it references. Both
			// are top-level tenant tables carrying the same denormalized
			// organizationId/userId columns as test_case.
			{ name: "project_qa_settings", policy: "user_owned" },
			{ name: "project_environment", policy: "user_owned" },
			{ name: "project_qa_webhook", policy: "user_owned" },
			{
				name: "project_qa_webhook_delivery",
				policy: "qa_webhook_delivery",
			},
			{ name: "qa_open_question", policy: "user_owned" },
			{ name: "qa_sign_off", policy: "user_owned" },
			{ name: "pull_request_review", policy: "user_owned" },
			{ name: "pull_request_review_finding", policy: "user_owned" },
			// The accuracy ledger. Carries its own tenant columns precisely so
			// it survives the finding rows a lens re-run deletes, which means it
			// needs its own policy rather than inheriting one by relation.
			{ name: "pr_review_judgement", policy: "user_owned" },
			{ name: "test_result_event", policy: "test_result_event" },
			// Per-step agentic run log. A GRANDchild: it carries no tenant
			// columns and no testCaseId either, so it cannot reuse the
			// test_result_event policy — it has to walk one hop further, through
			// test_result_event to test_case. Its own policy case below.
			{ name: "test_agentic_step_log", policy: "test_agentic_step_log" },
			// Per-case edit-history child. Same columnless-child shape as
			// test_result_event: no tenant columns, inherit access via the parent
			// test_case row (testCaseId).
			{ name: "test_case_activity", policy: "test_result_event" },
			// Complete, append-only Mode B script snapshots. The projectId is
			// denormalized so the standard project-scoped policy can enforce
			// tenancy without loading the parent case first.
			{
				name: "test_case_script_revision",
				policy: "project_scoped",
			},
			// QA analysis version snapshots. Carries projectId, no tenant columns
			// of its own — inherits the parent project's tenancy, same EXISTS
			// shape as story_priority_change.
			{ name: "qa_analysis_version", policy: "project_scoped" },
			// Project-level Databricks Vector Search knowledge binding. Carries
			// projectId, no tenant columns of its own — inherits the parent
			// project's tenancy, same EXISTS shape as qa_analysis_version.
			{
				name: "project_databricks_knowledge_binding",
				policy: "project_scoped",
			},
			{ name: "project_user_preference", policy: "per_user_within_org" },
			{ name: "project_user_function_tag", policy: "user_owned" }, // Shared per-project function tags (admin-managed)
			{ name: "daily_brief", policy: "user_owned" }, // Shared per-project daily brief
			{
				name: "daily_brief_release_note_exclusion",
				policy: "user_owned",
			}, // Per-project release-notes exclusions
			{ name: "daily_brief_view", policy: "per_user_within_org" }, // Per-user brief read state
			{ name: "project_brief_cursor", policy: "per_user_within_org" }, // Per-user "last reviewed" marker
			{ name: "newsletter_settings", policy: "user_owned" }, // Per-project newsletter config
			{ name: "newsletter_subscriber", policy: "user_owned" }, // External subscriber list
			{ name: "newsletter_send", policy: "user_owned" }, // Send history/audit
			{ name: "newsletter_delivery", policy: "user_owned" }, // Per-recipient delivery rows
			{ name: "newsletter_chat_delivery", policy: "user_owned" }, // Per-channel chat delivery rows
			{ name: "publishing_suggestion_cycle", policy: "user_owned" }, // Publishing Suite run ledger
			{ name: "publishing_topic", policy: "user_owned" }, // Publishing Suite topics
			{ name: "publishing_topic_read", policy: "per_user_within_org" }, // Per-user topic read markers
			{ name: "publishing_suite_settings", policy: "user_owned" }, // Publishing Suite per-project config
			{ name: "publishing_notification_delivery", policy: "user_owned" }, // Publishing Suite delivery ledger
			{ name: "publishing_chat_delivery", policy: "user_owned" }, // Publishing Suite chat broadcast ledger
			{
				name: "publishing_topic_planning_analysis",
				policy: "user_owned",
			}, // Publishing Suite planning worksheet
			{ name: "document_version", policy: "user_owned" }, // Document history
			{ name: "document_auto_refresh_settings", policy: "user_owned" }, // Per-document auto-refresh enrollment
			{ name: "feature_version", policy: "user_owned" }, // Feature version history
			// Roadmap Priority band-change history. Carries projectId but no
			// tenant columns of its own, so it inherits the parent project's
			// tenancy — same EXISTS shape as test_result_event.
			{
				name: "story_priority_change",
				policy: "project_scoped",
			},
			{ name: "document_lock", policy: "user_owned" }, // Document locks
			{ name: "browser_task", policy: "per_user_within_org" },
			{ name: "template_instance", policy: "user_owned" },
			{ name: "template_instance_execution", policy: "user_owned" },
			{ name: "template_instance_artifact", policy: "user_owned" },
			{ name: "template_instance_artifact_chunk", policy: "user_owned" }, // Artifact chunks
			{ name: "report_execution", policy: "user_owned" },
			{ name: "report_artifact", policy: "user_owned" },
			{ name: "report_artifact_chunk", policy: "user_owned" }, // Report chunks
			{
				name: "template_instance_artifact_email_delivery",
				policy: "user_owned",
			}, // Email send log for template-instance artifacts; org members see all org sends, personal sees only own
			{ name: "sdlc_pipeline", policy: "user_owned" },
			{ name: "chat_document", policy: "per_user_within_org" },
			{ name: "document_chunk", policy: "per_user_within_org" },
			{ name: "document_eval", policy: "per_user_within_org" },
			{ name: "document_eval_metric", policy: "eval_metric" },
			{ name: "workspace", policy: "user_owned" },
			{ name: "ai_usage_log", policy: "user_owned" }, // Can have both userId and orgId
			// Human verdicts on AI output. Same tenant shape as ai_usage_log:
			// an org row carries both userId (who judged) and organizationId,
			// a personal row carries userId with organizationId NULL.
			{ name: "ai_outcome_event", policy: "user_owned" },
			// AI usage limits are XOR-scoped (one of organizationId/userId is non-null)
			// because limits express centralized policy, not per-user-within-org caps.
			{ name: "ai_usage_limit", policy: "strict" },
			// Counter rows have no direct tenant columns — access inherits from
			// the parent ai_usage_limit row through the limitId FK.
			{
				name: "ai_usage_limit_counter",
				policy: "ai_usage_limit_counter",
			},
			{ name: "agent_workspace_file", policy: "per_user_within_org" },
			{ name: "wizard_temp_context", policy: "user_owned" }, // Temporary file storage during project wizard
			{ name: "agent_execution_step", policy: "user_owned" }, // Agent execution steps
			{ name: "agent_deployment_trigger", policy: "user_owned" }, // Deployment triggers
			{ name: "agent_deployment_metrics", policy: "user_owned" }, // Deployment metrics
			// Prompt-related tables
			{ name: "prompt_version", policy: "user_owned" }, // Prompt versions (has userId)
			{ name: "prompt_comment", policy: "author_owned" }, // Prompt comments (uses authorId)
			{ name: "prompt_comment_vote", policy: "user_owned" }, // Comment votes (has userId)
			{ name: "prompt_change_request", policy: "author_owned" }, // Change requests (uses authorId)
			{ name: "prompt_connection", policy: "org_only_owned" }, // Prompt connections (only org filtering)
			// Proposed defaults. An ORG nomination carries the organizationId it
			// is for; a SYSTEM one carries null, which is what the personal-tenant
			// branch of org_only_owned matches. Filtering by the nominator would
			// be wrong: the row exists to be read by someone ELSE, the admin who
			// reviews it.
			{ name: "prompt_nomination", policy: "org_only_owned" },

			// User-owned with public visibility
			{ name: "automation_template", policy: "user_owned_with_public" },

			// Org-only tables
			{ name: "organization_eval_budget", policy: "org_only" },

			// Dynamic agents
			{ name: "offloaded_tool_output", policy: "user_owned" }, // Large tool outputs
			{
				name: "dynamic_agent_config",
				policy: "scope",
				orgScope: "ORGANIZATION",
			}, // User-created agents with scope
			// Note: dynamic_agent_trigger has no direct userId/organizationId - access controlled by parent
			{ name: "dynamic_agent_execution", policy: "user_owned" }, // Execution history
			// Note: dynamic_agent_favorite only has userId - user-specific favorites

			// Skill catalog - scope-based (SYSTEM visible to all)
			{
				name: "skill",
				policy: "scope",
				orgScope: "ORGANIZATION",
			},
			// Note: skill_file has no direct tenant columns — access controlled through parent skill via FK cascade

			// Coding runs - Background agent execution
			{ name: "coding_run", policy: "user_owned" },

			// Runtime authority (Pipes-style session-scoped authorization)
			{ name: "authority_session", policy: "strict" }, // EITHER userId OR orgId
			// authority_grant has no direct tenant fields — access controlled through parent authority_session

			// Data connections - External data sync
			{ name: "data_connection", policy: "user_owned" }, // External service connections
			// Note: data_sync_job, synced_resource, data_sync_schedule have no direct tenant fields
			// Access controlled through parent data_connection

			// Note: project_repository_integration has no userId/organizationId columns
			// Access controlled through parent project via hasProjectAccess at application layer

			// Weave (multi-agent orchestration)
			{ name: "weave_plan", policy: "user_owned" },
			{ name: "weave_execution", policy: "user_owned" },
			{ name: "project_weave_config", policy: "user_owned" },

			// Slack conversational threads
			{ name: "slack_thread_mapping", policy: "user_owned" },
			{ name: "slack_event_receipt", policy: "user_owned" },
			{ name: "teams_event_receipt", policy: "user_owned" },

			// Monitoring / incidents — admin-only global tables.
			// No per-tenant column exists; access from per-tenant connections is
			// denied by RLS (false). Admin code paths use the direct/superuser
			// connection that bypasses RLS, or go through adminProcedure.
			{ name: "error_rate_incident", policy: "admin_only" },
			{ name: "integration_incident", policy: "admin_only" },
			{ name: "incident_event", policy: "admin_only" },
			{ name: "integration_provider_registry", policy: "admin_only" },
		];

		for (const table of tables) {
			try {
				// Enable RLS
				await db.$executeRawUnsafe(
					`ALTER TABLE "${table.name}" ENABLE ROW LEVEL SECURITY`,
				);
				await db.$executeRawUnsafe(
					`ALTER TABLE "${table.name}" FORCE ROW LEVEL SECURITY`,
				);

				// Drop existing policy if exists
				await db.$executeRawUnsafe(
					`DROP POLICY IF EXISTS tenant_isolation ON "${table.name}"`,
				);

				// Create appropriate policy based on type
				let policySQL: string;

				switch (table.policy) {
					case "strict":
						// USING = read/update/delete, WITH CHECK = insert/update
						policySQL = `
							CREATE POLICY tenant_isolation ON "${table.name}"
							USING (
								CASE current_tenant_type()
									WHEN 'organization' THEN
										"organizationId" = current_tenant_id() AND "userId" IS NULL
									WHEN 'personal' THEN
										"userId" = current_tenant_id() AND "organizationId" IS NULL
									ELSE false
								END
							)
							WITH CHECK (
								CASE current_tenant_type()
									WHEN 'organization' THEN
										"organizationId" = current_tenant_id() AND "userId" IS NULL
									WHEN 'personal' THEN
										"userId" = current_tenant_id() AND "organizationId" IS NULL
									ELSE false
								END
							)
						`;
						break;

					case "strict_with_system":
						// Read: can see system + own tenant data
						// Write: can ONLY write to own tenant data (not system)
						policySQL = `
							CREATE POLICY tenant_isolation ON "${table.name}"
							USING (
								"isSystemProvided" = true
								OR
								CASE current_tenant_type()
									WHEN 'organization' THEN
										"organizationId" = current_tenant_id() AND "userId" IS NULL
									WHEN 'personal' THEN
										"userId" = current_tenant_id() AND "organizationId" IS NULL
									ELSE false
								END
							)
							WITH CHECK (
								"isSystemProvided" = false
								AND
								CASE current_tenant_type()
									WHEN 'organization' THEN
										"organizationId" = current_tenant_id() AND "userId" IS NULL
									WHEN 'personal' THEN
										"userId" = current_tenant_id() AND "organizationId" IS NULL
									ELSE false
								END
							)
						`;
						break;

					case "scope": {
						// Read: can see SYSTEM + own scope
						// Write: can ONLY write to own scope (not SYSTEM)
						const orgScopeValue =
							(table as any).orgScope || "ORGANIZATION";
						policySQL = `
							CREATE POLICY tenant_isolation ON "${table.name}"
							USING (
								scope = 'SYSTEM'
								OR
								CASE current_tenant_type()
									WHEN 'organization' THEN
										scope = '${orgScopeValue}' AND "organizationId" = current_tenant_id()
									WHEN 'personal' THEN
										scope = 'USER' AND "userId" = current_tenant_id()
									ELSE false
								END
							)
							WITH CHECK (
								scope != 'SYSTEM'
								AND
								CASE current_tenant_type()
									WHEN 'organization' THEN
										scope = '${orgScopeValue}' AND "organizationId" = current_tenant_id()
									WHEN 'personal' THEN
										scope = 'USER' AND "userId" = current_tenant_id()
									ELSE false
								END
							)
						`;
						break;
					}

					case "user_owned":
						policySQL = `
							CREATE POLICY tenant_isolation ON "${table.name}"
							USING (
								CASE current_tenant_type()
									WHEN 'organization' THEN
										"organizationId" = current_tenant_id()
									WHEN 'personal' THEN
										"userId" = current_user_id() AND "organizationId" IS NULL
									ELSE false
								END
							)
							WITH CHECK (
								CASE current_tenant_type()
									WHEN 'organization' THEN
										"organizationId" = current_tenant_id()
									WHEN 'personal' THEN
										"userId" = current_user_id() AND "organizationId" IS NULL
									ELSE false
								END
							)
						`;
						break;

					case "author_owned":
						// Same as user_owned but uses authorId instead of userId
						policySQL = `
							CREATE POLICY tenant_isolation ON "${table.name}"
							USING (
								CASE current_tenant_type()
									WHEN 'organization' THEN
										"organizationId" = current_tenant_id()
									WHEN 'personal' THEN
										"authorId" = current_user_id() AND "organizationId" IS NULL
									ELSE false
								END
							)
							WITH CHECK (
								CASE current_tenant_type()
									WHEN 'organization' THEN
										"organizationId" = current_tenant_id()
									WHEN 'personal' THEN
										"authorId" = current_user_id() AND "organizationId" IS NULL
									ELSE false
								END
							)
						`;
						break;

					case "org_only_owned":
						// For tables that only filter by organizationId (no userId/authorId for personal)
						policySQL = `
							CREATE POLICY tenant_isolation ON "${table.name}"
							USING (
								CASE current_tenant_type()
									WHEN 'organization' THEN
										"organizationId" = current_tenant_id()
									WHEN 'personal' THEN
										"organizationId" IS NULL
									ELSE false
								END
							)
							WITH CHECK (
								CASE current_tenant_type()
									WHEN 'organization' THEN
										"organizationId" = current_tenant_id()
									WHEN 'personal' THEN
										"organizationId" IS NULL
									ELSE false
								END
							)
						`;
						break;

					case "user_owned_with_public":
						// Read: can see public + own tenant data
						// Write: can ONLY write to own tenant data (cannot set isPublic=true via RLS)
						policySQL = `
							CREATE POLICY tenant_isolation ON "${table.name}"
							USING (
								"isPublic" = true
								OR
								CASE current_tenant_type()
									WHEN 'organization' THEN
										"organizationId" = current_tenant_id()
									WHEN 'personal' THEN
										"userId" = current_user_id() AND "organizationId" IS NULL
									ELSE false
								END
							)
							WITH CHECK (
								CASE current_tenant_type()
									WHEN 'organization' THEN
										"organizationId" = current_tenant_id()
									WHEN 'personal' THEN
										"userId" = current_user_id() AND "organizationId" IS NULL
									ELSE false
								END
							)
						`;
						break;

					case "org_only":
						policySQL = `
							CREATE POLICY tenant_isolation ON "${table.name}"
							USING (
								CASE current_tenant_type()
									WHEN 'organization' THEN
										"organizationId" = current_tenant_id()
									ELSE false
								END
							)
							WITH CHECK (
								CASE current_tenant_type()
									WHEN 'organization' THEN
										"organizationId" = current_tenant_id()
									ELSE false
								END
							)
						`;
						break;

					case "eval_metric":
						// Parent document_eval is per-user-in-org, so the
						// metric inherits that shape — both branches require
						// userId to match.
						policySQL = `
							CREATE POLICY tenant_isolation ON "${table.name}"
							USING (
								EXISTS (
									SELECT 1
									FROM "document_eval" AS de
									WHERE de.id = "documentEvalId"
									AND CASE current_tenant_type()
										WHEN 'organization' THEN
											de."userId" = current_user_id() AND de."organizationId" = current_tenant_id()
										WHEN 'personal' THEN
											de."userId" = current_user_id() AND de."organizationId" IS NULL
										ELSE false
									END
								)
							)
							WITH CHECK (
								EXISTS (
									SELECT 1
									FROM "document_eval" AS de
									WHERE de.id = "documentEvalId"
									AND CASE current_tenant_type()
										WHEN 'organization' THEN
											de."userId" = current_user_id() AND de."organizationId" = current_tenant_id()
										WHEN 'personal' THEN
											de."userId" = current_user_id() AND de."organizationId" IS NULL
										ELSE false
									END
								)
							)
						`;
						break;

					case "ai_usage_limit_counter":
						// Inherit access from the parent ai_usage_limit row via
						// limitId FK. The parent's strict (XOR) policy decides
						// whether the current tenant can see the limit, and the
						// counter follows. Mirrors the eval_metric → document_eval
						// pattern above.
						policySQL = `
								CREATE POLICY tenant_isolation ON "${table.name}"
								USING (
									EXISTS (
										SELECT 1
										FROM "ai_usage_limit" AS lim
										WHERE lim.id = "limitId"
										AND CASE current_tenant_type()
											WHEN 'organization' THEN
												lim."organizationId" = current_tenant_id() AND lim."userId" IS NULL
											WHEN 'personal' THEN
												lim."userId" = current_tenant_id() AND lim."organizationId" IS NULL
											ELSE false
										END
									)
								)
								WITH CHECK (
									EXISTS (
										SELECT 1
										FROM "ai_usage_limit" AS lim
										WHERE lim.id = "limitId"
										AND CASE current_tenant_type()
											WHEN 'organization' THEN
												lim."organizationId" = current_tenant_id() AND lim."userId" IS NULL
											WHEN 'personal' THEN
												lim."userId" = current_tenant_id() AND lim."organizationId" IS NULL
											ELSE false
										END
									)
								)
							`;
						break;

					case "project_scoped":
						// No direct tenant columns — inherit access from the
						// parent project row via projectId. Same EXISTS pattern
						// as test_result_event, one level up the tree.
						policySQL = `
							CREATE POLICY tenant_isolation ON "${table.name}"
							USING (
								EXISTS (
									SELECT 1
									FROM "project" AS p
									WHERE p.id = "projectId"
									AND CASE current_tenant_type()
										WHEN 'organization' THEN
											p."organizationId" = current_tenant_id()
										WHEN 'personal' THEN
											p."userId" = current_user_id() AND p."organizationId" IS NULL
										ELSE false
									END
								)
							)
							WITH CHECK (
								EXISTS (
									SELECT 1
									FROM "project" AS p
									WHERE p.id = "projectId"
									AND CASE current_tenant_type()
										WHEN 'organization' THEN
											p."organizationId" = current_tenant_id()
										WHEN 'personal' THEN
											p."userId" = current_user_id() AND p."organizationId" IS NULL
										ELSE false
									END
								)
							)
						`;
						break;

					case "test_agentic_step_log":
						// Per-step log for a Fabric-orchestrated run. Two hops:
						// it has neither tenant columns nor a testCaseId, so it
						// reaches its tenant through test_result_event and then
						// test_case. Written as one EXISTS with a join rather
						// than nested EXISTS so the planner sees a single
						// subquery, matching how the one-hop policies read.
						policySQL = `
							CREATE POLICY tenant_isolation ON "${table.name}"
							USING (
								EXISTS (
									SELECT 1
									FROM "test_result_event" AS tre
									JOIN "test_case" AS tc ON tc.id = tre."testCaseId"
									WHERE tre.id = "testResultEventId"
									AND CASE current_tenant_type()
										WHEN 'organization' THEN
											tc."organizationId" = current_tenant_id()
										WHEN 'personal' THEN
											tc."userId" = current_user_id() AND tc."organizationId" IS NULL
										ELSE false
									END
								)
							)
							WITH CHECK (
								EXISTS (
									SELECT 1
									FROM "test_result_event" AS tre
									JOIN "test_case" AS tc ON tc.id = tre."testCaseId"
									WHERE tre.id = "testResultEventId"
									AND CASE current_tenant_type()
										WHEN 'organization' THEN
											tc."organizationId" = current_tenant_id()
										WHEN 'personal' THEN
											tc."userId" = current_user_id() AND tc."organizationId" IS NULL
										ELSE false
									END
								)
							)
						`;
						break;

					case "qa_webhook_delivery": {
						const predicate = `
							EXISTS (
								SELECT 1
								FROM "project_qa_webhook" AS hook
								WHERE hook.id = "webhookId"
								AND CASE current_tenant_type()
									WHEN 'organization' THEN
										hook."organizationId" = current_tenant_id()
									WHEN 'personal' THEN
										hook."userId" = current_user_id()
										AND hook."organizationId" IS NULL
									ELSE false
								END
							)
						`;
						policySQL = `
							CREATE POLICY tenant_isolation ON "${table.name}"
							USING (${predicate})
							WITH CHECK (${predicate})
						`;
						break;
					}

					case "test_plan_case": {
						const predicate = `
							EXISTS (
								SELECT 1
								FROM "test_plan" AS tp
								JOIN "test_case" AS tc ON tc.id = "testCaseId"
								WHERE tp.id = "planId"
								AND CASE current_tenant_type()
									WHEN 'organization' THEN
										tp."organizationId" = current_tenant_id()
										AND tc."organizationId" = current_tenant_id()
									WHEN 'personal' THEN
										tp."userId" = current_user_id()
										AND tp."organizationId" IS NULL
										AND tc."userId" = current_user_id()
										AND tc."organizationId" IS NULL
									ELSE false
								END
							)
						`;
						policySQL = `
							CREATE POLICY tenant_isolation ON "${table.name}"
							USING (${predicate})
							WITH CHECK (${predicate})
						`;
						break;
					}

					case "test_case_work_item_link": {
						const predicate = `
							EXISTS (
								SELECT 1
								FROM "test_case" AS tc
								JOIN "user_story" AS us ON us.id = "userStoryId"
								JOIN "project" AS usp ON usp.id = us."projectId"
								WHERE tc.id = "testCaseId"
								AND us."projectId" = tc."projectId"
								AND CASE current_tenant_type()
									WHEN 'organization' THEN
										tc."organizationId" = current_tenant_id()
										AND usp."organizationId" = current_tenant_id()
									WHEN 'personal' THEN
										tc."userId" = current_user_id()
										AND tc."organizationId" IS NULL
										AND usp."userId" = current_user_id()
										AND usp."organizationId" IS NULL
									ELSE false
								END
							)
						`;
						policySQL = `
							CREATE POLICY tenant_isolation ON "${table.name}"
							USING (${predicate})
							WITH CHECK (${predicate})
						`;
						break;
					}

					case "test_result_event":
						// Append-only run-result history. No direct tenant columns —
						// inherit access from the parent test_case row via testCaseId,
						// mirroring test_case's user_owned policy (org sees the org's
						// rows; personal sees own rows with no org). Same EXISTS pattern
						// as eval_metric / ai_usage_limit_counter.
						policySQL = `
							CREATE POLICY tenant_isolation ON "${table.name}"
							USING (
								EXISTS (
									SELECT 1
									FROM "test_case" AS tc
									WHERE tc.id = "testCaseId"
									AND CASE current_tenant_type()
										WHEN 'organization' THEN
											tc."organizationId" = current_tenant_id()
										WHEN 'personal' THEN
											tc."userId" = current_user_id() AND tc."organizationId" IS NULL
										ELSE false
									END
								)
							)
							WITH CHECK (
								EXISTS (
									SELECT 1
									FROM "test_case" AS tc
									WHERE tc.id = "testCaseId"
									AND CASE current_tenant_type()
										WHEN 'organization' THEN
											tc."organizationId" = current_tenant_id()
										WHEN 'personal' THEN
											tc."userId" = current_user_id() AND tc."organizationId" IS NULL
										ELSE false
									END
								)
							)
						`;
						break;

					case "per_user_within_org_with_system":
						// Per-user-within-org with system-provided visibility
						// Read: can see system + own tenant data
						// Write: can ONLY write to own tenant data (not system)
						policySQL = `
							CREATE POLICY tenant_isolation ON "${table.name}"
							USING (
								"isSystemProvided" = true
								OR
								CASE current_tenant_type()
									WHEN 'organization' THEN
										"userId" = current_user_id() AND "organizationId" = current_tenant_id()
									WHEN 'personal' THEN
										"userId" = current_user_id() AND "organizationId" IS NULL
									ELSE false
								END
							)
							WITH CHECK (
								"isSystemProvided" = false
								AND
								CASE current_tenant_type()
									WHEN 'organization' THEN
										"userId" = current_user_id() AND "organizationId" = current_tenant_id()
									WHEN 'personal' THEN
										"userId" = current_user_id() AND "organizationId" IS NULL
									ELSE false
								END
							)
						`;
						break;

					case "per_user_within_org":
						// Per-user-within-org: userId always required, organizationId optional
						// In org context: user's records within the org (userId + organizationId)
						// In personal context: user's personal records (userId + organizationId IS NULL)
						policySQL = `
							CREATE POLICY tenant_isolation ON "${table.name}"
							USING (
								CASE current_tenant_type()
									WHEN 'organization' THEN
										"userId" = current_user_id() AND "organizationId" = current_tenant_id()
									WHEN 'personal' THEN
										"userId" = current_user_id() AND "organizationId" IS NULL
									ELSE false
								END
							)
							WITH CHECK (
								CASE current_tenant_type()
									WHEN 'organization' THEN
										"userId" = current_user_id() AND "organizationId" = current_tenant_id()
									WHEN 'personal' THEN
										"userId" = current_user_id() AND "organizationId" IS NULL
									ELSE false
								END
							)
						`;
						break;

					case "admin_only":
						// Admin-only global tables (no per-tenant column).
						// Deny all access from per-tenant connections. Admin code
						// paths use the direct/superuser connection that bypasses
						// RLS (FORCE ROW LEVEL SECURITY is still enforced, but
						// table owners bypass FORCE RLS), or operate via
						// `adminProcedure` which uses the direct connection.
						policySQL = `
							CREATE POLICY tenant_isolation ON "${table.name}"
							USING (false)
							WITH CHECK (false)
						`;
						break;

					default:
						continue;
				}

				await db.$executeRawUnsafe(policySQL);

				// Worker bypass policy (policy-mode alternative to the BYPASSRLS attribute).
				// Always drop so switching back to bypassrls mode cleans up.
				await db.$executeRawUnsafe(
					`DROP POLICY IF EXISTS worker_bypass ON "${table.name}"`,
				);
				if (workerEnabled && workerRlsMode === "policy") {
					await db.$executeRawUnsafe(
						`CREATE POLICY worker_bypass ON "${table.name}" FOR ALL TO fabric_worker USING (true) WITH CHECK (true)`,
					);
				}

				// App bypass policy (managed Postgres hosts where fabric_app has no
				// implicit RLS bypass). Always drop so disabling the flag cleans up.
				await db.$executeRawUnsafe(
					`DROP POLICY IF EXISTS app_bypass ON "${table.name}"`,
				);
				if (appRlsBypass) {
					await db.$executeRawUnsafe(
						`CREATE POLICY app_bypass ON "${table.name}" FOR ALL TO fabric_app USING (true) WITH CHECK (true)`,
					);
				}

				console.log(`   ✓ ${table.name}`);
			} catch (error: any) {
				if (error.message?.includes("does not exist")) {
					// FAIL LOUD (SOC 2 CC6.1 / M-A2): an allowlist entry that
					// targets a nonexistent relation means its RLS policy is NOT
					// applied — e.g. a PascalCase model name instead of the
					// @@map'd physical table. Silently skipping is exactly how
					// openapi_service / openapi_service_config went unprotected.
					// Surface the mismatch so it is fixed, never shipped.
					throw new Error(
						`RLS target "${table.name}" does not exist — the allowlist entry must use the physical (snake_case @@map) table name. Original error: ${error.message}`,
					);
				}
				console.log(`   ✗ ${table.name}: ${error.message}`);
			}
		}

		// Step 3: Clean up legacy indexes that cause schema drift
		// These were previously created by this script but should be managed
		// by Prisma migrations instead.
		console.log(
			"\n🧹 Cleaning up legacy indexes (prevents schema drift)...",
		);

		const legacyIndexes = [
			"idx_mcp_config_tenant",
			"idx_mcp_server_tenant",
			"idx_ai_chat_tenant",
			"idx_agent_tenant",
			"idx_project_tenant",
			"idx_purchase_tenant",
			"idx_ai_credit_account_tenant",
			"idx_ai_usage_log_tenant",
			"idx_agent_workspace_file_tenant",
			"idx_wizard_temp_context_tenant",
			"idx_document_eval_tenant",
			"idx_org_eval_budget_org",
		];

		for (const indexName of legacyIndexes) {
			try {
				await db.$executeRawUnsafe(
					`DROP INDEX IF EXISTS "${indexName}"`,
				);
				console.log(`   ✓ Dropped ${indexName}`);
			} catch (error: any) {
				// DROP INDEX IF EXISTS shouldn't fail for missing indexes,
				// so any error here is a real problem (permissions, etc.)
				console.error(`   ✗ ${indexName}: ${error.message}`);
				throw error;
			}
		}

		console.log("\n✅ RLS policies applied successfully!");
		console.log(
			"\n📝 Note: RLS is now enabled but your current connection",
		);
		console.log("   likely uses a superuser that bypasses RLS.");
		console.log("   The Prisma Client Extension (getTenantDb) provides");
		console.log("   application-level filtering regardless.");
	} catch (error) {
		console.error("\n❌ Error applying RLS:", error);
		throw error;
	}
}

// Export for use by deploy-rls.ts
export { applyRLS };

// Run directly if executed as main script (not imported). Use pathToFileURL so
// the comparison holds cross-platform — on Windows `process.argv[1]` is a
// backslash drive path while `import.meta.url` is a `file:///C:/…` URL, so the
// old `file://${argv[1]}` template never matched and the script silently no-op'd.
const isMainModule =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
	applyRLS()
		.catch(() => process.exit(1))
		.finally(() => db.$disconnect());
}
