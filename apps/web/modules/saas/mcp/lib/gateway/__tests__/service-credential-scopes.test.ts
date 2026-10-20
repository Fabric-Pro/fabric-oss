/**
 * Fabric's own agent runtime holds a narrow, fixed set of scopes, not a
 * wildcard. A leaked agent secret therefore reaches the workflow and frame
 * tools the chat engines expose and nothing else, and the service credential
 * is held to the tenant it was opened in like an organization key is.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));

vi.mock("@repo/database", () => ({ db: {} }));

import { executePlatformTool, TOOL_SCOPES } from "../platform-tools";
import { serviceSessionHasTool } from "../project-binding";
import {
	credentialSubject,
	SERVICE_CREDENTIAL_SCOPES,
	scopeSatisfied,
} from "../tool-scope";
import {
	type GatewaySession,
	isDelegatedCredential,
	isOrganizationBoundCredential,
} from "../types";

function serviceSession(): GatewaySession {
	return {
		sessionId: "sess-1",
		userId: "user-1",
		organizationId: "org-1",
		userName: "Example Agent",
		email: "agent@example.com",
		role: "user",
		credential: "service",
		scopes: [...SERVICE_CREDENTIAL_SCOPES],
		actingContext: {},
		createdAt: new Date("2026-01-01T00:00:00Z"),
		expiresAt: new Date("2026-01-02T00:00:00Z"),
	};
}

describe("the service credential's scope ceiling", () => {
	it.each([
		"fabric_list_documents",
		"fabric_create_project",
		"fabric_list_features",
		"fabric_page_read_connected",
	])(
		"refuses %s outside the explicit service allowlist despite read scopes",
		async (toolName) => {
			const result = await executePlatformTool(
				toolName,
				{},
				serviceSession(),
			);

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("agent runtime");
			expect(result.content[0]?.text).toContain("not available");
		},
	);

	it.each([
		"fabric_list_projects",
		"fabric_get_project",
		"fabric_list_project_instructions",
		"fabric_get_project_instruction",
		"fabric_get_project_instruction_bundle",
		"fabric_list_connected_servers",
		"fabric_list_page_tools",
	])("allows the selected read %s", (name) => {
		expect(serviceSessionHasTool(serviceSession(), name)).toBe(true);
		expect(
			scopeSatisfied(
				[...SERVICE_CREDENTIAL_SCOPES],
				TOOL_SCOPES[name],
				"service",
			),
		).toBe(true);
	});

	it("holds MCP read for listing connections but refuses a connected-server write", () => {
		expect(
			scopeSatisfied(
				SERVICE_CREDENTIAL_SCOPES as string[],
				{ scope: "mcp:write", kind: "write" },
				"service",
			),
		).toBe(false);
		expect(
			scopeSatisfied(
				SERVICE_CREDENTIAL_SCOPES as string[],
				{ scope: "mcp:read", kind: "read" },
				"service",
			),
		).toBe(true);
	});

	it("only lists scopes some platform tool actually requires", () => {
		const required = new Set(
			Object.values(TOOL_SCOPES).map((entry) => entry.scope),
		);
		const unused = SERVICE_CREDENTIAL_SCOPES.filter(
			(scope) => !required.has(scope),
		);

		expect(unused).toEqual([]);
	});

	it("is fixed to its tenant and treated as a delegated credential", () => {
		expect(isOrganizationBoundCredential("service")).toBe(true);
		expect(isDelegatedCredential("service")).toBe(true);
	});

	it("keeps the refusal wording of the other credentials", () => {
		expect(credentialSubject("oauth")).toBe("signed-in agent");
		expect(credentialSubject("organization-key")).toBe("API key");
		expect(credentialSubject("personal-key")).toBe("API key");
		expect(credentialSubject("service")).toBe("agent runtime");
	});

	it("cannot switch to another organization", async () => {
		const result = await executePlatformTool(
			"fabric_switch_organization",
			{ organizationId: "org-2" },
			{ ...serviceSession(), scopes: ["orgs:read", "mcp:write"] },
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain(
			"not available to this agent runtime",
		);
	});
});
