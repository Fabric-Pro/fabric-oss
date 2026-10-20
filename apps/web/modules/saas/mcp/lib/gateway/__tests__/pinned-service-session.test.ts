/**
 * A service session whose grant names a meeting's project.
 *
 * It holds the base scopes plus the portal scopes within the ceiling, and the
 * gateway itself keeps every call on that project: a project named anywhere in
 * the arguments, a feature, document or context that lives in another project,
 * and every tool outside the portal and the runtime's own families. The session
 * is not a project connection, so the workflow, frame and workspace tools stay.
 */

import { PARLUME_GRANT_SCOPES } from "@repo/api/lib/agent-service-auth";
import { FABRIC_FRAME_TOOL_DEFINITIONS } from "@repo/temporal/fabric-frame-tool-definitions";
import { FABRIC_FRAME_VERSION_TOOL_DEFINITIONS } from "@repo/temporal/fabric-frame-version-tool-definitions";
import { FABRIC_PAGE_DISCOVERY_TOOL_DEFINITIONS } from "@repo/temporal/fabric-page-discovery-tool-definitions";
import { FABRIC_PAGE_TOOL_DEFINITIONS } from "@repo/temporal/fabric-page-tool-definitions";
import {
	FABRIC_PORTAL_EXCLUDED_TOOL_NAMES,
	FABRIC_PORTAL_PROJECT_TOOL_NAMES,
	FABRIC_PORTAL_TENANT_TOOL_NAMES,
	FABRIC_PORTAL_TOOL_NAMES,
} from "@repo/temporal/fabric-portal-tools";
import { FABRIC_WORKFLOW_TOOL_DEFINITIONS } from "@repo/temporal/fabric-workflow-tool-definitions";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));
vi.mock("@repo/database", () => ({ db: {} }));

import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
	platformToolScope,
} from "../platform-tools";
import {
	bindToolCall,
	pinnedSessionHasTool,
	pinnedSessionTools,
	serviceSessionHasTool,
	sessionMayReachProject,
} from "../project-binding";
import { getAggregatedTools } from "../tool-aggregator";
import {
	SERVICE_CREDENTIAL_SCOPES,
	SERVICE_GRANT_MAX_SCOPES,
	scopeSatisfied,
	serviceSessionScopes,
} from "../tool-scope";
import type { GatewaySession } from "../types";

const PROJECT = "project-meeting";

function pinnedSession(
	overrides: Partial<GatewaySession> = {},
): GatewaySession {
	return {
		sessionId: "sess-1",
		userId: "user-1",
		organizationId: "org-1",
		projectId: null,
		pinnedProjectId: PROJECT,
		userName: "Example Agent",
		email: "agent@example.com",
		role: "user",
		credential: "service",
		scopes: serviceSessionScopes({
			projectId: PROJECT,
			scopes: PARLUME_GRANT_SCOPES,
		}),
		actingContext: {},
		createdAt: new Date("2026-01-01T00:00:00Z"),
		expiresAt: new Date("2026-01-02T00:00:00Z"),
		...overrides,
	};
}

describe("the scopes a service session holds", () => {
	it("is exactly the base set for a chat grant, which names no project", () => {
		expect(serviceSessionScopes({})).toEqual([
			...SERVICE_CREDENTIAL_SCOPES,
		]);
	});

	it("adds a project grant's scopes within the ceiling", () => {
		expect(
			serviceSessionScopes({
				projectId: PROJECT,
				scopes: ["features:read", "features:write"],
			}),
		).toEqual([
			...SERVICE_CREDENTIAL_SCOPES,
			"features:read",
			"features:write",
		]);
	});

	it("adds nothing for scopes that name no project", () => {
		expect(
			serviceSessionScopes({
				scopes: ["features:read", "projects:write"],
			}),
		).toEqual([...SERVICE_CREDENTIAL_SCOPES]);
	});

	it.each([
		"mcp:write",
		"*",
		"authority:read",
		"authority:write",
		"orgs:write",
		"chats:write",
		"workflows:admin",
	])("never adds %s, however the grant names it", (scope) => {
		expect(
			serviceSessionScopes({ projectId: PROJECT, scopes: [scope] }),
		).toEqual([...SERVICE_CREDENTIAL_SCOPES]);
	});

	it.each(["orgs:read", "chats:read", "mcp:read"])(
		"adds %s when the grant names a project and it",
		(scope) => {
			expect(
				serviceSessionScopes({ projectId: PROJECT, scopes: [scope] }),
			).toEqual([...new Set([...SERVICE_CREDENTIAL_SCOPES, scope])]);
		},
	);

	it("keeps the ceiling clear of every write to organizations, chats, connected servers, authority and the wildcard", () => {
		expect(SERVICE_GRANT_MAX_SCOPES).toContain("orgs:read");
		for (const scope of SERVICE_GRANT_MAX_SCOPES) {
			expect(scope).not.toMatch(
				/^(?:orgs|chats|mcp):write$|^authority:|^\*$/,
			);
		}
	});

	it("holds every scope the 38 portal tools need and nothing a tool does not", () => {
		const needed = new Set(
			FABRIC_PORTAL_TOOL_NAMES.map(
				(name) => platformToolScope(name).scope,
			),
		);
		const ceiling = new Set(SERVICE_GRANT_MAX_SCOPES);

		for (const scope of needed) {
			expect(
				ceiling.has(scope) || SERVICE_CREDENTIAL_SCOPES.includes(scope),
			).toBe(true);
		}
		for (const scope of ceiling) {
			expect(needed.has(scope) || scope === "mcp:read").toBe(true);
		}
	});

	it("is a ceiling the meeting grant the web app mints stays within", () => {
		const beyondBase = PARLUME_GRANT_SCOPES.filter(
			(scope) => !SERVICE_CREDENTIAL_SCOPES.includes(scope),
		);

		expect(beyondBase.sort()).toEqual(
			SERVICE_GRANT_MAX_SCOPES.filter(
				(scope) => !SERVICE_CREDENTIAL_SCOPES.includes(scope),
			).sort(),
		);
	});
});

describe("which gateway tools Parlume gets", () => {
	const runtimeFamilies = new Set(
		[
			...FABRIC_WORKFLOW_TOOL_DEFINITIONS,
			...FABRIC_FRAME_TOOL_DEFINITIONS,
			...FABRIC_FRAME_VERSION_TOOL_DEFINITIONS,
			...FABRIC_PAGE_TOOL_DEFINITIONS,
			...FABRIC_PAGE_DISCOVERY_TOOL_DEFINITIONS,
		].map((tool) => tool.name),
	);
	const gatewayPlatformTools = PLATFORM_TOOL_DEFINITIONS.map(
		(tool) => tool.name,
	).filter((name) => !runtimeFamilies.has(name));

	it("keeps connection reads, delegated authority and memory tools outside meeting grants", () => {
		expect(FABRIC_PORTAL_TOOL_NAMES).toHaveLength(38);
		expect([...FABRIC_PORTAL_EXCLUDED_TOOL_NAMES].sort()).toEqual([
			"fabric_check_authority",
			"fabric_get_project_pm_connection",
			"fabric_get_project_pm_item_snapshots",
			"fabric_get_project_work_item_counts",
			"fabric_list_project_pm_assigned_items",
			"fabric_list_project_pm_members",
			"fabric_list_project_pm_work_item_types",
			"fabric_memory_read",
			"fabric_memory_targets",
			"fabric_memory_write",
			"fabric_memory_write_status",
			"fabric_request_authority",
			"fabric_revoke_authority",
		]);
	});

	it("leaves no platform tool the gateway has in neither the portal list nor the exclusion list", () => {
		const named = new Set([
			...FABRIC_PORTAL_TOOL_NAMES,
			...FABRIC_PORTAL_EXCLUDED_TOOL_NAMES,
		]);

		const unnamed = gatewayPlatformTools.filter((name) => !named.has(name));

		expect(unnamed).toEqual([]);
	});

	it("names no tool the gateway does not have, in either list", () => {
		const have = new Set(gatewayPlatformTools);

		const missing = [
			...FABRIC_PORTAL_TOOL_NAMES,
			...FABRIC_PORTAL_EXCLUDED_TOOL_NAMES,
		].filter((name) => !have.has(name));

		expect(missing).toEqual([]);
	});

	it("puts no tool in two lists, and no portal tool in the exclusion list", () => {
		const all = [
			...FABRIC_PORTAL_PROJECT_TOOL_NAMES,
			...FABRIC_PORTAL_TENANT_TOOL_NAMES,
			...FABRIC_PORTAL_EXCLUDED_TOOL_NAMES,
		];

		expect(new Set(all).size).toBe(all.length);
	});

	it("keeps a runtime family tool out of the portal list, which is the platform tools alone", () => {
		for (const name of FABRIC_PORTAL_TOOL_NAMES) {
			expect(runtimeFamilies.has(name)).toBe(false);
		}
	});
});

describe("what the portal tools need", () => {
	it("is a scope the ceiling allows, for every portal tool", () => {
		for (const name of FABRIC_PORTAL_TOOL_NAMES) {
			const required = platformToolScope(name);
			expect(
				scopeSatisfied(
					serviceSessionScopes({
						projectId: PROJECT,
						scopes: PARLUME_GRANT_SCOPES,
					}),
					required,
					"service",
				),
			).toBe(true);
		}
	});

	it("keeps ordinary chat to the six selected portal reads even with the MCP read umbrella", () => {
		const allowed = FABRIC_PORTAL_TOOL_NAMES.filter((name) =>
			serviceSessionHasTool({}, name),
		);
		expect(allowed.sort()).toEqual([
			"fabric_get_project",
			"fabric_get_project_instruction",
			"fabric_get_project_instruction_bundle",
			"fabric_list_connected_servers",
			"fabric_list_project_instructions",
			"fabric_list_projects",
		]);
	});

	it("is a tool the gateway actually has", () => {
		const names = new Set(
			PLATFORM_TOOL_DEFINITIONS.map((tool) => tool.name),
		);
		for (const name of FABRIC_PORTAL_TOOL_NAMES) {
			expect(names.has(name)).toBe(true);
		}
	});
});

describe("the project a pinned session reaches", () => {
	it("reaches its own project only, through a feature, document or context too", () => {
		const session = pinnedSession();

		expect(sessionMayReachProject(session, PROJECT)).toBe(true);
		expect(sessionMayReachProject(session, "another-project")).toBe(false);
	});

	it("leaves an organization-wide session as it was", () => {
		expect(
			sessionMayReachProject(
				pinnedSession({ pinnedProjectId: null }),
				"another-project",
			),
		).toBe(true);
	});

	it.each([
		["a project argument", { projectId: "another-project" }],
		["a nested project", { preset: { projectId: "another-project" } }],
		[
			"a project deep in a list",
			{ items: [{ more: { projectId: "another-project" } }] },
		],
	])("rejects a call that names another project in %s", (_name, args) => {
		for (const tool of [
			"fabric_get_document",
			"fabric_create_workflow",
			"fabric_create_frame",
		]) {
			expect(bindToolCall(tool, args, pinnedSession())).toEqual({
				ok: false,
				message: "Project not found or access denied",
			});
		}
	});

	it("defaults a portal tool's project to the meeting's, and keeps one that names it", () => {
		expect(
			bindToolCall("fabric_list_features", {}, pinnedSession()),
		).toEqual({ ok: true, args: { projectId: PROJECT } });
		expect(
			bindToolCall(
				"fabric_list_features",
				{ projectId: PROJECT },
				pinnedSession(),
			),
		).toEqual({ ok: true, args: { projectId: PROJECT } });
	});

	it("passes the runtime's workflow, frame and workspace reads through untouched", () => {
		for (const tool of [
			"fabric_list_workflows",
			"fabric_create_frame",
			"fabric_list_workspaces",
			"fabric_query_workspace",
		]) {
			expect(bindToolCall(tool, { name: "x" }, pinnedSession())).toEqual({
				ok: true,
				args: { name: "x" },
			});
		}
	});

	it.each([
		"fabric_request_authority",
		"fabric_revoke_authority",
		"fabric_check_authority",
		"fabric_memory_read",
		"fabric_memory_write",
		"fabric_memory_write_status",
		"fabric_memory_targets",
		"fabric_page_read_connected",
		"fabric_page_ask",
		"fabric_not_a_tool",
	])("refuses %s on a pinned session, whatever scopes it holds", (tool) => {
		const result = bindToolCall(tool, {}, pinnedSession());

		expect(result.ok).toBe(false);
		expect(pinnedSessionHasTool(tool)).toBe(false);
	});

	it.each(FABRIC_PORTAL_TOOL_NAMES)("has %s on a pinned session", (tool) => {
		expect(pinnedSessionHasTool(tool)).toBe(true);
		expect(bindToolCall(tool, {}, pinnedSession()).ok).toBe(true);
	});

	it.each([
		"fabric_request_authority",
		"fabric_revoke_authority",
		"fabric_check_authority",
	])(
		"refuses %s through the tool call itself, not only the binding",
		async (tool) => {
			const result = await executePlatformTool(
				tool,
				{},
				pinnedSession({ scopes: ["*"] }),
			);

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("not available");
		},
	);

	it("answers a call for another project as a project that does not exist", async () => {
		const result = await executePlatformTool(
			"fabric_get_project",
			{ projectId: "another-project" },
			pinnedSession(),
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain(
			"Project not found or access denied",
		);
	});

	it("does not touch a chat session, which names no project", () => {
		expect(
			bindToolCall(
				"fabric_create_workflow",
				{ preset: { projectId: "any-project" } },
				pinnedSession({ pinnedProjectId: null }),
			),
		).toEqual({
			ok: true,
			args: { preset: { projectId: "any-project" } },
		});
	});
});

describe("the tools a pinned session is offered", () => {
	it("is the portal and runtime families, with the project optional on the portal tools", () => {
		const offered = pinnedSessionTools(PLATFORM_TOOL_DEFINITIONS);
		const names = offered.map((tool) => tool.name);

		for (const name of FABRIC_PORTAL_TOOL_NAMES) {
			expect(names).toContain(name);
		}
		expect(names).toContain("fabric_list_workflows");
		expect(names).toContain("fabric_create_frame");
		for (const hidden of FABRIC_PORTAL_EXCLUDED_TOOL_NAMES) {
			expect(names).not.toContain(hidden);
		}
		const document = offered.find(
			(tool) => tool.name === "fabric_get_document",
		);
		expect(document?.inputSchema.required).not.toContain("projectId");
	});

	it("is what the gateway lists a pinned service session, and a chat session its base set only", async () => {
		const pinned = await getAggregatedTools(pinnedSession());
		const chat = await getAggregatedTools(
			pinnedSession({
				pinnedProjectId: null,
				scopes: [...SERVICE_CREDENTIAL_SCOPES],
			}),
		);

		const pinnedNames = pinned.tools.map((tool) => tool.name);
		expect(pinnedNames).toContain("fabric_update_feature_status");
		expect(pinnedNames).toContain("fabric_create_feature");
		expect(pinnedNames).toContain("fabric_create_bug");
		expect(pinnedNames).toContain("fabric_create_project");
		expect(pinnedNames).not.toContain("fabric_request_authority");
		expect(chat.tools.map((tool) => tool.name)).not.toContain(
			"fabric_update_feature_status",
		);
		expect(pinned.servers).toEqual([]);
	});

	it("weighs what a meeting turn that needs the portal tools carries", () => {
		const offered = pinnedSessionTools(PLATFORM_TOOL_DEFINITIONS).filter(
			(tool) => FABRIC_PORTAL_TOOL_NAMES.includes(tool.name),
		);
		const characters = JSON.stringify(
			offered.map((tool) => [
				tool.name,
				tool.description,
				tool.inputSchema,
			]),
		).length;

		expect(offered).toHaveLength(FABRIC_PORTAL_TOOL_NAMES.length);
		expect(characters).toBeGreaterThan(20_000);
		expect(characters).toBeLessThan(32_000);
	});
});
