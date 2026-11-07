/**
 * The scopes chosen when an API key is created are enforced on MCP (Fizzy #2380).
 *
 * They were stored and never read here. `GatewaySession` carried no scope list
 * at all, so a key ticked "MCP Read" and nothing else could call every write
 * tool on this surface — while the same scopes had always been enforced on the
 * REST v1 API. The checkboxes in the create dialog were decorative.
 *
 * The case that matters most is the compatibility one. Keys already in
 * circulation default to `["mcp:read", "mcp:write"]`, and enforcement that
 * demanded `projects:write` from them would break every one on the day it
 * deployed. So the coarse `mcp:*` scopes act as umbrellas over their direction,
 * except deliberate Skills/governance and Frame sharing/export operations, which require their exact scopes. The compatibility test pins both the retained umbrella and those explicit refusals.
 *
 * Scopes only ever subtract. They cannot grant a caller more than their role
 * allows — that is what the permission checks do, and they have their own
 * suite. A key is authentication; a scope is a limit its owner chose to accept.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));

vi.mock("@repo/database", () => ({
	db: {},
	// The project read gate, behind every project-scoped read and the
	// work-item create preamble.
	isProjectSoftDeleted: vi.fn().mockResolvedValue(false),
	getProjectAccessContext: vi
		.fn()
		.mockResolvedValue({ organizationId: "org-1" }),
	resolveProjectAccess: vi.fn().mockResolvedValue({
		organizationId: "org-1",
		source: "project-member",
		isVisible: true,
		permissions: ["project:update", "story:update"],
	}),
	hasPermission: vi.fn((permissions, required) =>
		permissions.includes(required),
	),
	Permissions: {
		PROJECT_UPDATE: "project:update",
		STORY_UPDATE: "story:update",
	},
	canCreateProjectInOrganization: vi.fn().mockResolvedValue(true),
	// The workflow reads ask membership and the read permission together.
	// Refused here, so they fail after the scope check, as a result.
	getOrganizationMembership: vi.fn().mockResolvedValue(null),
	canReadOrganizationWorkflows: vi.fn().mockResolvedValue(false),
	listProjects: vi.fn().mockResolvedValue([]),
	updateTask: vi.fn(),
	createProject: vi.fn(),
}));

import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
	TOOL_SCOPES,
} from "../platform-tools";
import type { GatewaySession } from "../types";

function sessionWith(scopes: string[]): GatewaySession {
	return {
		sessionId: "sess-1",
		userId: "user-1",
		organizationId: "org-1",
		userName: "Example Agent",
		email: "agent@example.com",
		role: "user",
		credential: "organization-key",
		scopes,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		expiresAt: new Date("2026-01-02T00:00:00Z"),
	};
}

function text(result: { content: Array<{ text: string }> }) {
	return result.content[0].text;
}

/** Did the call fail on scope, as opposed to succeeding or failing later? */
async function refusedOnScope(tool: string, scopes: string[]) {
	const result = await executePlatformTool(tool, {}, sessionWith(scopes));
	const value = text(result);
	try {
		if (JSON.parse(value).code === "INSUFFICIENT_SCOPE") {
			return true;
		}
	} catch {
		/* Successful tools may return plain text. */
	}
	return value.includes("does not have the");
}

describe("a key is held to the scopes it was given", () => {
	it("refuses a write to a key that only holds mcp:read", async () => {
		expect(await refusedOnScope("fabric_update_task", ["mcp:read"])).toBe(
			true,
		);
	});

	it("allows a read to that same key", async () => {
		expect(await refusedOnScope("fabric_list_projects", ["mcp:read"])).toBe(
			false,
		);
	});

	it("accepts the tool's own specific scope, without any umbrella", async () => {
		expect(
			await refusedOnScope("fabric_update_task", ["features:write"]),
		).toBe(false);
	});

	it("refuses a scope that belongs to a different area", async () => {
		expect(
			await refusedOnScope("fabric_update_task", ["frames:write"]),
		).toBe(true);
	});

	it("refuses a key holding no scopes at all", async () => {
		expect(await refusedOnScope("fabric_list_projects", [])).toBe(true);
	});

	it("lets a wildcard key through", async () => {
		expect(await refusedOnScope("fabric_update_task", ["*"])).toBe(false);
	});

	// A key permitted to write is not meaningfully denied a read, and a key
	// ticked "MCP Write" only would be baffling to find read-blocked.
	it("treats mcp:write as covering reads too", async () => {
		expect(
			await refusedOnScope("fabric_list_projects", ["mcp:write"]),
		).toBe(false);
	});
});

describe("keys already in circulation keep working", () => {
	// Existing general MCP scopes retain ordinary tools. Deliberate skill policy
	// and workbench, evaluation and Frame sharing/export commands require exact scopes.
	const LEGACY_DEFAULT = ["mcp:read", "mcp:write"];

	it("the legacy umbrella retains ordinary tools while workbench, evaluation, skills and export commands require exact consent", async () => {
		const refused: string[] = [];
		for (const tool of PLATFORM_TOOL_DEFINITIONS) {
			if (await refusedOnScope(tool.name, LEGACY_DEFAULT)) {
				refused.push(tool.name);
			}
		}
		expect(refused.sort()).toEqual(
			[
				"fabric_create_frame_draft",
				"fabric_validate_frame_document",
				"fabric_list_frame_templates",
				"fabric_get_frame_template",
				"fabric_create_frame_template",
				"fabric_create_frame_from_template",
				"fabric_propose_frame_change",
				"fabric_list_frame_changes",
				"fabric_get_frame_change",
				"fabric_apply_frame_change",
				"fabric_dismiss_frame_change",
				"fabric_get_frame_review",
				"fabric_approve_frame_revision",
				"fabric_list_report_executions",
				"fabric_list_report_artifacts",

				"fabric_get_project_delivery",
				"fabric_delivery_source_list",
				"fabric_delivery_source_inspect",
				"fabric_delivery_source_configure",
				"fabric_delivery_source_pause",
				"fabric_delivery_source_resume",
				"fabric_delivery_source_disconnect",
				"fabric_delivery_source_capture",
				"fabric_delivery_source_status",
				"fabric_delivery_source_cancel",
				"fabric_delivery_source_observations",
				"fabric_delivery_source_evidence",
				"fabric_list_delivery_signals",
				"fabric_get_delivery_signal",
				"fabric_get_delivery_signal_sources",
				"fabric_cancel_implementation_session",
				"fabric_follow_up_implementation_session",
				"fabric_get_implementation_messages",
				"fabric_get_implementation_session",
				"fabric_list_implementation_sessions",
				"fabric_start_implementation_session",

				"fabric_list_reports",
				"fabric_create_report",
				"fabric_get_report",
				"fabric_configure_report",
				"fabric_execute_report",
				"fabric_get_report_execution",
				"fabric_cancel_report_execution",
				"fabric_download_report_artifact",
				"fabric_distribute_report_artifact",
				"fabric_get_report_deliveries",
				"fabric_agent_quality_get_policy",
				"fabric_agent_quality_configure_policy",
				"fabric_agent_quality_list_assessments",
				"fabric_agent_quality_get_assessment",
				"fabric_agent_quality_cancel_assessment",
				"fabric_agent_quality_compare_assessments",
				"fabric_workflow_quality_get_policy",
				"fabric_workflow_quality_configure_policy",
				"fabric_workflow_quality_list_assessments",
				"fabric_workflow_quality_get_assessment",
				"fabric_workflow_quality_cancel_assessment",
				"fabric_workflow_quality_compare_assessments",
				"fabric_apply_frame_branding",
				"fabric_apply_report_branding",
				"fabric_apply_workflow_check",
				"fabric_archive_agent_test_case",
				"fabric_assist_prompt",
				"fabric_cancel_agent_test_run",
				"fabric_check_agent_run_result",
				"fabric_check_workflow_readiness",
				"fabric_compare_agent_test_runs",
				"fabric_configure_workflow_schedule",
				"fabric_create_agent_test_case",
				"fabric_create_workflow_from_starter",
				"fabric_get_agent_test_run",
				"fabric_get_prompt_response",
				"fabric_get_report_branding",
				"fabric_get_report_instance_branding",
				"fabric_get_workflow_schedule",
				"fabric_inspect_agent_run_result",
				"fabric_inspect_workflow_result",
				"fabric_list_agent_test_cases",
				"fabric_list_agent_test_runs",
				"fabric_list_workflow_checks",
				"fabric_list_workflow_starters",
				"fabric_list_workflow_versions",
				"fabric_preview_prompt",
				"fabric_preview_workflow_check",
				"fabric_remove_workflow_check",
				"fabric_rollback_workflow",
				"fabric_save_workflow_check",
				"fabric_start_agent_test_run",
				"fabric_update_agent_test_case",
				"fabric_update_company_brand",
				"fabric_update_prompt_response",
				"fabric_list_skills",
				"fabric_get_skill",
				"fabric_create_skill",
				"fabric_update_skill",
				"fabric_archive_skill",
				"fabric_restore_skill",
				"fabric_publish_skill",
				"fabric_delete_skill",
				"fabric_get_skill_governance",
				"fabric_update_skill_governance",
				"fabric_assist_skill",
				"fabric_preview_skill_import",
				"fabric_create_skill_import",
				"fabric_read_skill_file",
				"fabric_read_skill_import_file",
				"fabric_share_frame",
				"fabric_get_frame_sharing",
				"fabric_revoke_frame_sharing",
				"fabric_start_frame_export",
				"fabric_get_frame_branding",
				"fabric_get_frame_export",
				"fabric_cancel_frame_export",
				"fabric_download_frame_export",
			].sort(),
		);
	});

	// Browser sessions carry `["*"]` — no key chose scopes for them, and the
	// interactive permission checks that already govern the UI are not
	// loosened or tightened by anything on this path.
	it("a browser session reaches every tool", async () => {
		const refused: string[] = [];
		for (const tool of PLATFORM_TOOL_DEFINITIONS) {
			if (await refusedOnScope(tool.name, ["*"])) {
				refused.push(tool.name);
			}
		}
		expect(refused).toEqual([]);
	});
});

describe("the scope map covers the tool list", () => {
	// An unmapped tool falls back to requiring `mcp:write`, which is the safe
	// reading of "we do not know what this does" — but it is a fallback, not a
	// plan. A tool added without a scope silently becomes write-gated, which is
	// wrong for a read and invisible until someone reports it.
	it("every exported tool definition has a scope", () => {
		const unmapped = PLATFORM_TOOL_DEFINITIONS.filter(
			(tool) => !TOOL_SCOPES[tool.name],
		).map((tool) => tool.name);

		expect(unmapped).toEqual([]);
	});

	it("maps no tool that does not exist", () => {
		const defined = new Set(PLATFORM_TOOL_DEFINITIONS.map((t) => t.name));
		const stale = Object.keys(TOOL_SCOPES).filter((n) => !defined.has(n));

		expect(stale).toEqual([]);
	});
});
