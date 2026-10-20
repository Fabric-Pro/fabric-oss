import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "../../../../lib/missing-organization-context";

const mocks = vi.hoisted(() => ({
	membership: vi.fn(),
	read: vi.fn(),
	write: vi.fn(),
	selection: vi.fn(),
}));
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	getOrganizationMembership: mocks.membership,
	getOrchestratorPreferences: mocks.read,
	upsertOrchestratorPreferences: mocks.write,
	upsertChatAgentSelection: mocks.write,
}));
vi.mock("../../../../orpc/procedures", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../../orpc/procedures")>();
	const { os } = await import("@orpc/server");
	return { ...actual, tenantProtectedProcedure: os.$context<any>() };
});
vi.mock("../chat-agent-selection/server-fetch", () => ({
	fetchChatAgentSelectionForUser: mocks.selection,
}));

import { getChatAgentSelectionProcedure } from "../chat-agent-selection/get";
import { setChatAgentSelectionProcedure } from "../chat-agent-selection/set";
import { getOrchestratorPreferencesProcedure } from "../orchestrator-preferences/get";
import { updateOrchestratorPreferencesProcedure } from "../orchestrator-preferences/update";

const preferences = {
	exists: true,
	enabledMcpConfigIds: [],
	enabledAgentIds: [],
	enabledWorkspaceIds: [],
	autonomyLevel: "BALANCED",
	chatMode: "direct",
	reasoningMode: "balanced",
	uiMode: "simple",
};
const context = {
	user: { id: "example-user" },
	session: { activeOrganizationId: "example-org-a" },
	tenantContext: {
		type: "organization",
		userId: "example-user",
		organizationId: "example-org-a",
	},
	activeOrganizationRole: "member",
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.membership.mockResolvedValue({
		role: "member",
		organization: { deletedAt: null },
	});
	mocks.read.mockResolvedValue(preferences);
	mocks.write.mockResolvedValue(preferences);
	mocks.selection.mockResolvedValue({
		exists: false,
		version: 1,
		selectedAgents: [],
		droppedCount: 0,
		defaultAgent: null,
	});
});

// Explicit-org cases depend on input preservation + resolveOrganizationId;
// refusal cases depend on requireInputOrgPermission + the non-null schema.
// Fallback cases protect rollout compatibility and depend on the optional input.
describe.each([
	[
		"orchestrator get",
		getOrchestratorPreferencesProcedure,
		{},
		mocks.read,
		false,
	],
	[
		"orchestrator update",
		updateOrchestratorPreferencesProcedure,
		{ chatMode: "direct" },
		mocks.write,
		true,
	],
	[
		"selection get",
		getChatAgentSelectionProcedure,
		{},
		mocks.selection,
		false,
	],
	[
		"selection set",
		setChatAgentSelectionProcedure,
		{ selectedAgents: [] },
		mocks.write,
		true,
	],
] as const)(
	"%s organization boundary",
	(_name, procedure, input, operation, write) => {
		const invoke = (value: unknown) =>
			call(procedure as any, value, { context });
		it("uses the page organization when the session names another", async () => {
			await invoke({ ...input, organizationId: "example-org-b" });
			expect(mocks.membership).toHaveBeenCalledWith(
				"example-org-b",
				"example-user",
			);
			expect(operation.mock.calls[0][write ? 2 : 1]).toBe(
				"example-org-b",
			);
		});
		it("refuses non-members before reading or writing", async () => {
			mocks.membership.mockResolvedValue(null);
			await expect(
				invoke({ ...input, organizationId: "example-org-b" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(operation).not.toHaveBeenCalled();
		});
		it("refuses null organization input", async () => {
			await expect(
				invoke({ ...input, organizationId: null }),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
			});
			expect(operation).not.toHaveBeenCalled();
		});
		// Depends on requireOrganization: true, rather than schema validation.
		it("refuses a missing organization context before reading or writing", async () => {
			await expect(
				call(procedure as any, write ? input : undefined, {
					context: {
						...context,
						session: { activeOrganizationId: null },
						tenantContext: {
							...context.tenantContext,
							organizationId: null,
							type: "none",
						},
					},
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
			});
			expect(operation).not.toHaveBeenCalled();
		});

		it("falls back to the session organization when omitted", async () => {
			await invoke(write ? input : undefined);
			expect(operation.mock.calls[0][write ? 2 : 1]).toBe(
				"example-org-a",
			);
		});
	},
);

// Depends on the GET input schema retaining the query-string organization.
describe.each([
	[
		"orchestrator-preferences",
		getOrchestratorPreferencesProcedure,
		mocks.read,
	],
	["chat-agent-selection", getChatAgentSelectionProcedure, mocks.selection],
] as const)("GET /users/%s", (path, procedure, operation) => {
	it("accepts the organization in an OpenAPI query string", async () => {
		const { OpenAPIHandler } = await import("@orpc/openapi/fetch");
		const handler = new OpenAPIHandler({ preference: procedure });
		const result = await handler.handle(
			new Request(
				`http://example.com/users/${path}?organizationId=example-org-b`,
			),
			{ context },
		);
		expect(result.matched).toBe(true);
		expect(result.response?.status).toBe(200);
		expect(operation).toHaveBeenCalledWith("example-user", "example-org-b");
	});
});
