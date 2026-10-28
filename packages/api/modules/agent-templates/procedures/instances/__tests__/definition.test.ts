import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	membership: vi.fn(),
	validateMemoryFile: vi.fn(),
	findFirst: vi.fn(),
	templateCreate: vi.fn(),
	instanceCreate: vi.fn(),
	audit: vi.fn(),
	auditTx: vi.fn(),
	markCurated: vi.fn(),
	transaction: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		agentTemplateInstance: { findFirst: mocks.findFirst },
		$transaction: mocks.transaction,
	},
	getOrganizationMembership: mocks.membership,
	getTenantContext: vi.fn(() => ({})),
	grantProjectAccess: vi.fn(),
	recordAuditTx: mocks.auditTx,
	validateMemoryFile: mocks.validateMemoryFile,
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.audit,
	auditRequestFields: () => ({}),
	resolveActor: () => ({ type: "user", userId: "example-user" }),
}));
vi.mock("../../../../../orpc/middleware/audit-timing-middleware", () => ({
	markCuratedAuditWritten: mocks.markCurated,
}));
// Keep real input parsing and live destination-role middleware. Only authentication
// context construction and persistence are substituted in these boundary tests.
vi.mock("../../../../../orpc/procedures", async () => {
	const { os } = await import("@orpc/server");
	const { Permissions } = await import("@repo/permissions");
	const { requireInputOrgPermission } = await import(
		"../../../../../orpc/middleware/require-permission"
	);
	return {
		tenantProtectedProcedure: os,
		Permissions,
		requireInputOrgPermission,
	};
});

import {
	exportAgentDefinitionProcedure,
	importAgentDefinitionProcedure,
	previewAgentDefinitionProcedure,
} from "../definition";

const definition = {
	apiVersion: "fabric.ai/v1",
	kind: "Agent",
	name: "Example agent",
	description: "A portable agent",
	instructions: { template: "Cite sources", role: "Research" },
	model: { model: "example-model" },
	execution: { mode: "single_turn", maxIterations: 10 },
	skills: [
		{
			path: "skills/research/SKILL.md",
			content: "Find relevant documents",
			enabled: true,
		},
	],
	requirements: [
		{ kind: "trigger", name: "slack" },
		{ kind: "mcp", name: "Example tools" },
	],
};
const input = {
	organizationId: "destination-org",
	document: JSON.stringify(definition),
};
const context = {
	user: {
		id: "example-user",
		email: "dev@example.com",
		name: "Example User",
	},
	session: { id: "example-session", activeOrganizationId: "session-org" },
	activeOrganizationRole: "owner",
	allowedProjectIds: [],
	tenantContext: {
		type: "organization" as const,
		userId: "example-user",
		organizationId: "session-org",
	},
	headers: new Headers(),
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.validateMemoryFile.mockReturnValue({ valid: true });
	mocks.membership.mockResolvedValue({ role: "admin" });
	mocks.templateCreate.mockResolvedValue({ id: "new-template" });
	mocks.instanceCreate.mockResolvedValue({
		id: "new-instance",
		sId: "new-stable",
		version: 1,
		status: "DRAFT",
	});
	mocks.auditTx.mockResolvedValue(undefined);
	mocks.transaction.mockImplementation(async (fn) =>
		fn({
			agentTemplate: { create: mocks.templateCreate },
			agentTemplateInstance: { create: mocks.instanceCreate },
		}),
	);
	mocks.findFirst.mockResolvedValue(null);
});

describe("agent definition boundaries", () => {
	it("previews without mutation", async () => {
		const result = await call(previewAgentDefinitionProcedure, input, {
			context,
		});
		expect(result.definition).toEqual(definition);
		expect(mocks.membership).toHaveBeenCalledWith(
			"destination-org",
			"example-user",
		);
		expect(mocks.transaction).not.toHaveBeenCalled();
	});
	it.each([null, { role: "member" }])(
		"requires a live destination management role: %j",
		async (membership) => {
			mocks.membership.mockResolvedValue(membership);
			await expect(
				call(importAgentDefinitionProcedure, input, { context }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.transaction).not.toHaveBeenCalled();
		},
	);
	it("rejects missing organization and cannot fall back to a personal context", async () => {
		await expect(
			call(
				importAgentDefinitionProcedure,
				{ ...input, organizationId: "" },
				{ context },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.transaction).not.toHaveBeenCalled();
	});
	it("creates only a draft, with local skill ownership and an atomic audit", async () => {
		const result = await call(importAgentDefinitionProcedure, input, {
			context,
		});
		expect(result.instance.status).toBe("DRAFT");
		expect(mocks.markCurated).toHaveBeenCalledOnce();
		expect(mocks.templateCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				organizationId: "destination-org",
				scope: "ORGANIZATION",
				isPublished: false,
			}),
		});
		const data = mocks.instanceCreate.mock.calls[0][0].data;
		expect(data).toMatchObject({
			status: "DRAFT",
			organizationId: "destination-org",
			userId: "example-user",
			toolConnections: {},
			triggers: [],
			workspaceIds: [],
			isApiExposed: false,
			memoryAutoApprove: false,
		});
		expect(data.customInstructions.portableRequirements).toEqual(
			definition.requirements,
		);
		expect(data.memoryFiles.create[0]).toMatchObject({
			organizationId: "destination-org",
			userId: "example-user",
			path: "skills/research/SKILL.md",
			contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(data.memoryFiles.create[0]).not.toHaveProperty("sourceSkillId");
		expect(mocks.auditTx).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "org.agent_definition.imported",
				organizationId: "destination-org",
			}),
		);
		expect(JSON.stringify(mocks.auditTx.mock.calls)).not.toContain(
			"Cite sources",
		);
	});
	it("validates skill contents with the existing memory-file rules", async () => {
		mocks.validateMemoryFile.mockReturnValue({ valid: false });
		await expect(
			call(importAgentDefinitionProcedure, input, { context }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.validateMemoryFile).toHaveBeenCalledWith(
			"skills/research/SKILL.md",
			"Find relevant documents",
		);
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it("propagates audit failure so the transaction rolls back", async () => {
		mocks.auditTx.mockRejectedValue(new Error("Audit unavailable"));
		await expect(
			call(importAgentDefinitionProcedure, input, { context }),
		).rejects.toThrow("Audit unavailable");
	});
	it("rejects malformed definitions before starting a transaction without echoing input", async () => {
		await expect(
			call(
				importAgentDefinitionProcedure,
				{ ...input, document: "secret: example-secret" },
				{ context },
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.not.stringContaining("example-secret"),
		});
		expect(mocks.transaction).not.toHaveBeenCalled();
	});
	it("scopes export to the requested organization even for a multi-organization owner", async () => {
		await expect(
			call(
				exportAgentDefinitionProcedure,
				{
					id: "foreign-instance",
					organizationId: "destination-org",
					format: "yaml",
				},
				{ context },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "foreign-instance",
					organizationId: "destination-org",
				},
			}),
		);
		expect(mocks.audit).not.toHaveBeenCalled();
	});
	it("exports portable intent that can be imported into another authorized organization", async () => {
		mocks.findFirst.mockResolvedValue({
			id: "source-instance",
			version: 3,
			name: definition.name,
			description: definition.description,
			template: {
				instructions: definition.instructions.template,
				suggestedModel: null,
				modelConfig: null,
				scope: "ORGANIZATION",
				organizationId: "source-org",
			},
			customInstructions: {
				role: definition.instructions.role,
				portableRequirements: definition.requirements,
			},
			modelOverride: definition.model.model,
			modelConfig: null,
			executionMode: "single_turn",
			goal: null,
			maxIterations: 10,
			successCriteria: null,
			toolConnections: {},
			triggers: [],
			workspaceIds: [],
			memoryFiles: [
				{
					path: "skills/notes.md",
					content: "Example notes",
					isEnabled: true,
					lastModifiedBy: "user",
				},
				{
					path: "skills/learned/SKILL.md",
					content: "Example learned skill",
					isEnabled: true,
					lastModifiedBy: "agent",
				},
				...definition.skills.map((skill) => ({
					...skill,
					isEnabled: skill.enabled,
				})),
			],
			integrationConfigurations: [],
			mcpServerConfigurations: [],
		});
		const exported = await call(
			exportAgentDefinitionProcedure,
			{
				id: "source-instance",
				organizationId: "source-org",
				format: "yaml",
			},
			{ context },
		);
		expect(exported.document).not.toContain("source-org");
		expect(exported.document).not.toContain("Example learned skill");
		expect(exported.notices.join(" ")).toContain("skills/notes.md");
		expect(exported.notices.join(" ")).toContain("skills/learned/SKILL.md");
		expect(exported.document).not.toContain("source-instance");
		expect(mocks.audit).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				action: "org.agent_definition.exported",
				metadata: { format: "yaml", version: 3 },
			}),
		);
		await call(
			importAgentDefinitionProcedure,
			{ organizationId: "destination-org", document: exported.document },
			{ context },
		);
		expect(mocks.instanceCreate.mock.calls[0][0].data).toMatchObject({
			organizationId: "destination-org",
			status: "DRAFT",
			toolConnections: {},
			triggers: [],
		});
	});

	it("rejects a cross-organization template even if its instance is in scope", async () => {
		mocks.findFirst.mockResolvedValue({
			template: { scope: "ORGANIZATION", organizationId: "foreign-org" },
		});
		await expect(
			call(
				exportAgentDefinitionProcedure,
				{
					id: "example-instance",
					organizationId: "destination-org",
					format: "json",
				},
				{ context },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
