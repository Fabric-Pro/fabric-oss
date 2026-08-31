/**
 * RLS coverage guard (SOC 2 CC6.1 — M-A1 / M-A2).
 *
 * The RLS allowlist in `scripts/apply-rls-direct.ts` must (A) reference only
 * REAL physical tables, and (B) cover every organization-scoped tenant table
 * — otherwise a tenant table silently ships without a row-level-security
 * policy (defense-in-depth backstop for the RLS-enforcing DB role).
 *
 * This test enforces both, so a NEW org-scoped model can't land without either
 * an RLS policy or an explicit, justified exemption. It complements the
 * fail-loud behavior added to apply-rls-direct.ts (an allowlist entry that
 * targets a nonexistent relation now throws instead of silently skipping —
 * that was how `openapi_service`/`openapi_service_config` went unprotected).
 *
 * NOTE: RLS is currently latent (the app connection bypasses RLS; `getTenantDb`
 * is not yet the app query path — tracked as the deeper H8 activation). This
 * guard ensures that WHEN that lands, coverage is already complete.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const schemaSrc = readFileSync(
	resolve(__dirname, "../prisma/schema.prisma"),
	"utf-8",
);
const applySrc = readFileSync(
	resolve(__dirname, "../scripts/apply-rls-direct.ts"),
	"utf-8",
);
const tenantDbSrc = readFileSync(
	resolve(__dirname, "../src/tenant-db.ts"),
	"utf-8",
);

type Model = {
	name: string;
	physical: string;
	hasOrg: boolean;
	hasUser: boolean;
	hasProject: boolean;
};

/** Robust line-based Prisma model parser (regex-over-whole-body is unreliable
 * because adjacent models share `}` boundaries). */
function parseModels(schema: string): Model[] {
	const models: Model[] = [];
	let cur: Model | null = null;
	for (const line of schema.split("\n")) {
		const start = line.match(/^model\s+(\w+)\s*\{/);
		if (start) {
			cur = {
				name: start[1],
				physical: start[1],
				hasOrg: false,
				hasUser: false,
				hasProject: false,
			};
			models.push(cur);
			continue;
		}
		if (!cur) {
			continue;
		}
		if (/^\}/.test(line)) {
			cur = null;
			continue;
		}
		const map = line.match(/@@map\("([^"]+)"\)/);
		if (map) {
			cur.physical = map[1];
		}
		if (/^\s*organizationId\s+/.test(line)) {
			cur.hasOrg = true;
		}
		if (/^\s*userId\s+/.test(line)) {
			cur.hasUser = true;
		}
		if (/^\s*projectId\s+/.test(line)) {
			cur.hasProject = true;
		}
	}
	return models;
}

/** Physical table names in the RLS allowlist (`{ name: "x", policy: "y" }`). */
function parseAllowlist(src: string): Set<string> {
	return new Set(
		[...src.matchAll(/name:\s*"([^"]+)",\s*policy:/g)].map((m) => m[1]),
	);
}

/**
 * Org-scoped tables intentionally NOT under an RLS policy (yet). Each MUST have
 * a justification. Keep this shrinking: the target is an empty set once the
 * latent-RLS backfill (and getTenantDb activation, H8) lands. Better-Auth-owned
 * tables are managed by the auth library and are covered by app-layer tenant
 * checks; the rest are the tracked defense-in-depth backfill.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
	// Better-Auth-owned org tables (managed by the auth library; tenant access
	// is enforced at the app layer via membership checks).
	["member", "Better-Auth-managed; app-layer membership enforced"],
	["invitation", "Better-Auth-managed; app-layer membership enforced"],
	// Tracked defense-in-depth backfill — latent until getTenantDb is the app
	// query path (H8). Each needs its correct per-table policy shape (org-only
	// vs org+user XOR/both) determined before an RLS policy is applied; adding a
	// wrong policy would be worse than a documented gap while RLS is bypassed.
	["organization_rag_settings", "latent-RLS backfill (H8); org-only"],
	["organization_rag_provider", "latent-RLS backfill (H8); org-only"],
	["organization_search_provider", "latent-RLS backfill (H8); org-only"],
	["organization_api_key", "latent-RLS backfill (H8); org-only"],
	["integration_approval", "latent-RLS backfill (H8); org+user"],
	["channel_thread_mapping", "latent-RLS backfill (H8); org+user"],
	["sdlc_artifact", "latent-RLS backfill (H8); org-only"],
	["project_code_index", "latent-RLS backfill (H8); org+user"],
	["project_linked_teams_chat", "latent-RLS backfill (H8); org+user"],
	["request_span", "latent-RLS backfill (H8); org+user"],
	["task_workflow_plan", "latent-RLS backfill (H8); org+user"],
	["mcp_oauth_state", "latent-RLS backfill (H8); org+user"],
	["mcp_client_session", "latent-RLS backfill (H8); org+user"],
	["prompt_binding", "latent-RLS backfill (H8); org+user"],
	["azure_agent_deployment", "latent-RLS backfill (H8); org-only"],
	["azure_ai_model_deployment", "latent-RLS backfill (H8); org-only"],
	["cloud_provider_config", "latent-RLS backfill (H8); org-only"],
	["model_router_config", "latent-RLS backfill (H8); org-only"],
	["frame_template", "latent-RLS backfill (H8); org-only"],
	["user_orchestrator_preferences", "latent-RLS backfill (H8); org+user"],
	["user_chat_agent_selection", "latent-RLS backfill (H8); org+user"],
	["notification_preference", "latent-RLS backfill (H8); org+user"],
	["organization_model_preference", "latent-RLS backfill (H8); org-only"],
	["ai_provider_fallback", "latent-RLS backfill (H8); org+user"],
	["approval_template", "latent-RLS backfill (H8); org+user"],
	["agent_template", "latent-RLS backfill (H8); org+user"],
	["agent_template_instance", "latent-RLS backfill (H8); org+user"],
	["agent_template_conversation", "latent-RLS backfill (H8); org+user"],
	["agent_template_execution", "latent-RLS backfill (H8); org+user"],
	["agent_deployment", "latent-RLS backfill (H8); org+user"],
	["agent_deployment_execution", "latent-RLS backfill (H8); org+user"],
	["task_queue_shard", "latent-RLS backfill (H8); org-only"],
	["organization_deployment_quota", "latent-RLS backfill (H8); org-only"],
	["agent_memory_file", "latent-RLS backfill (H8); org+user"],
	["agent_memory_edit", "latent-RLS backfill (H8); org+user"],
	["orchestrator_memory_preferences", "latent-RLS backfill (H8); org+user"],
	["episodic_memory", "latent-RLS backfill (H8); org+user"],
	["data_connection_credential", "latent-RLS backfill (H8); org+user"],
	["external_api_usage_log", "latent-RLS backfill (H8); org+user"],
	["kanban_queue", "latent-RLS backfill (H8); org-only"],
	["weave_plan_template", "latent-RLS backfill (H8); org+user"],
	["chat_artifact", "latent-RLS backfill (H8); org+user"],
	["notification", "latent-RLS backfill (H8); org+user"],
	["notification_delivery_preference", "latent-RLS backfill (H8); org+user"],
	["subscription", "latent-RLS backfill (H8); org+user"],
]);

const models = parseModels(schemaSrc);
const allowlist = parseAllowlist(applySrc);
const physicals = new Set(models.map((m) => m.physical));

describe("RLS coverage guard (SOC 2 CC6.1)", () => {
	it("sanity: schema + allowlist parsed", () => {
		expect(models.length).toBeGreaterThan(100);
		expect(allowlist.size).toBeGreaterThan(50);
	});

	it("every RLS allowlist entry targets a real physical table (M-A2)", () => {
		const bogus = [...allowlist].filter((n) => !physicals.has(n));
		if (bogus.length > 0) {
			throw new Error(
				`${bogus.length} RLS allowlist entr(ies) target a nonexistent table (use the physical @@map name, not the model name):\n  ${bogus.join("\n  ")}`,
			);
		}
		expect(bogus.length).toBe(0);
	});

	it("every organization-scoped tenant table is RLS-covered or exempted (M-A1)", () => {
		const uncovered = models
			.filter((m) => m.hasOrg)
			.filter(
				(m) => !allowlist.has(m.physical) && !EXEMPT.has(m.physical),
			)
			.map((m) => `${m.name} (table ${m.physical})`);
		if (uncovered.length > 0) {
			throw new Error(
				`${uncovered.length} organization-scoped table(s) have no RLS policy and no documented exemption. ` +
					"Add each to the allowlist in scripts/apply-rls-direct.ts (physical @@map name + correct policy) " +
					`or, if intentionally excluded, to EXEMPT in this test with a justification:\n  ${uncovered.join("\n  ")}`,
			);
		}
		expect(uncovered.length).toBe(0);
	});

	it("scopes test-case work-item links through the story's project", () => {
		expect(applySrc).toContain(
			'JOIN "project" AS usp ON usp.id = us."projectId"',
		);
		expect(applySrc).toContain('AND us."projectId" = tc."projectId"');
		expect(applySrc).not.toContain('us."organizationId"');
		expect(applySrc).not.toContain('us."userId"');
	});
});

/**
 * Second half of the same guard, in the OTHER direction.
 *
 * Registering a table for RLS is only half the job: `tenant-db.ts` must also
 * know how to scope it, because `getTenantFilter` returns `null` for a model it
 * doesn't recognise and `mergeWithTenantFilter` then passes the WHERE through
 * UNFILTERED — it fails OPEN, not closed. The RLS list above and the tenant-db
 * allowlist are maintained by hand in two files, and they have now drifted
 * twice: the pipeline tables in one wave (caught in review) and
 * ProjectQaSettings / ProjectEnvironment in the next (shipped, caught by audit).
 * Nothing compared the two lists until this test.
 */
/**
 * Tables that are RLS-registered but NOT yet scoped by tenant-db, frozen as of
 * 2026-07-26. This is a real pre-existing backlog (42 tables, mostly Atlas,
 * scanning and newsletter), not an approval — each still needs its tenant
 * column confirmed before it can be added. The list exists so the guard below
 * can ratchet: nothing NEW may join it.
 */
const TENANT_DB_BASELINE = new Set([
	"project_document_asset",
	"project_context_summary",
	"project_scan_config",
	"project_scan",
	"project_scan_checkpoint",
	"scan_finding",
	"scan_activity",
	"scan_finding_review",
	"scan_finding_grouping",
	"atlas_analysis",
	"atlas_parse_checkpoint",
	"atlas_node",
	"atlas_edge",
	"atlas_analysis_run",
	"atlas_conversation",
	"atlas_node_override",
	"atlas_node_override_history",
	"atlas_cross_edge",
	"atlas_cross_link",
	"atlas_cross_link_run",
	"atlas_system_layout",
	"atlas_edge_override",
	"atlas_edge_override_history",
	"project_meeting_action_item",
	"project_slack_huddle_note",
	"project_linked_teams_channel",
	"project_linked_slack_channel",
	"pending_backlog_proposal",
	"backlog_update_session",
	"pm_sync_log",
	"project_user_function_tag",
	"daily_brief",
	"newsletter_settings",
	"newsletter_subscriber",
	"newsletter_send",
	"newsletter_delivery",
	"newsletter_chat_delivery",
	"decision_log_entry",
	"architecture_decision",
	"architecture_decision_version",
	"document_assistant_conversation",
	"template_instance_artifact_email_delivery",
]);

const PROJECT_SCOPE_BASELINE = new Set([
	"document_auto_refresh_settings",
	"audit_log",
	"daily_brief_release_note_exclusion",
	"workflow",
	"ai_usage_log",
	"agent_deployment_trigger",
	"weave_plan",
	"weave_execution",
]);

/**
 * `publishing_topic_decision_entry` registration (Publishing Suite 2A-3).
 *
 * A tenant table missing from EITHER tenant-db list is not "less isolated",
 * it is UNFILTERED: `tenantProtectedProcedure` looks the model up by name and
 * silently applies no filter when it is absent. So the registration is the
 * isolation, and it is worth its own assertion rather than trusting review.
 *
 * `RLS_TABLES` in apply-rls-direct.ts is a plain array literal local to
 * `applyRLS()` (not a module-level export), so — matching how the rest of
 * this file already checks that script's content — these assertions read its
 * source text directly rather than importing a symbol that isn't exported.
 */
describe("publishing_topic_decision_entry registration", () => {
	it("is registered as a tenant table", () => {
		const block =
			tenantDbSrc.match(
				/const USER_OWNED_TABLES = new Set\(\[([\s\S]*?)\]\);/,
			)?.[1] ?? "";
		expect(block).toMatch(/"PublishingTopicDecisionEntry",/);
	});

	it("is registered as project-scoped on projectId", () => {
		const block =
			tenantDbSrc.match(
				/const PROJECT_SCOPED_TABLES:[^{]+\{([\s\S]*?)\n\};/,
			)?.[1] ?? "";
		expect(block).toMatch(/PublishingTopicDecisionEntry:\s*"projectId",/);
	});

	it("has an RLS policy in the inventory", () => {
		expect(applySrc).toMatch(
			/name:\s*"publishing_topic_decision_entry"\s*,\s*policy:\s*"user_owned"/,
		);
	});
});

describe("tenant-db allowlist parity with the RLS registration", () => {
	const userOwnedBlock =
		tenantDbSrc.match(
			/const USER_OWNED_TABLES = new Set\(\[([\s\S]*?)\]\);/,
		)?.[1] ?? "";
	const projectScopedBlock =
		tenantDbSrc.match(
			/const PROJECT_SCOPED_TABLES:[^{]+\{([\s\S]*?)\n\};/,
		)?.[1] ?? "";
	const userOwnedModels = new Set(
		[...userOwnedBlock.matchAll(/^\s*"([A-Z][A-Za-z0-9]*)",/gm)].map(
			(m) => m[1],
		),
	);
	const projectScopedModels = new Set(
		[
			...projectScopedBlock.matchAll(
				/^\s*([A-Z][A-Za-z0-9]*):\s*"[^"]+",/gm,
			),
		].map((m) => m[1]),
	);

	it("sanity: tenant-db allowlist parsed", () => {
		expect(userOwnedModels.size).toBeGreaterThan(20);
		expect(projectScopedModels.size).toBeGreaterThan(20);
	});

	it("every user_owned RLS table is also scoped by tenant-db", () => {
		const userOwnedPhysicals = new Set(
			[
				...applySrc.matchAll(
					/name:\s*"([a-z0-9_]+)"\s*,\s*policy:\s*"user_owned"/g,
				),
			].map((m) => m[1]),
		);
		const missing = models
			.filter(
				(m) =>
					userOwnedPhysicals.has(m.physical) &&
					!userOwnedModels.has(m.name) &&
					!TENANT_DB_BASELINE.has(m.physical),
			)
			.map((m) => `${m.name} (${m.physical})`);

		expect(
			missing,
			missing.length === 0
				? ""
				: `${missing.length} table(s) are registered for RLS as user_owned but missing from ` +
						"tenant-db.ts. getTenantFilter returns null for an unregistered model, so its " +
						"queries run WITHOUT a tenant filter — add them to USER_OWNED_TABLES and " +
						`PROJECT_SCOPED_TABLES: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("project-backed user-owned tables are registered for project access", () => {
		const userOwnedPhysicals = new Set(
			[
				...applySrc.matchAll(
					/name:\s*"([a-z0-9_]+)"\s*,\s*policy:\s*"user_owned"/g,
				),
			].map((m) => m[1]),
		);
		const missing = models
			.filter(
				(model) =>
					model.hasProject &&
					userOwnedPhysicals.has(model.physical) &&
					userOwnedModels.has(model.name) &&
					!projectScopedModels.has(model.name) &&
					!PROJECT_SCOPE_BASELINE.has(model.physical),
			)
			.map((model) => `${model.name} (${model.physical})`);

		expect(missing).toEqual([]);
	});
});
