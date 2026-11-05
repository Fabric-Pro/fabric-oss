import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	membership: vi.fn(),
	memory: vi.fn(),
	boundary: vi.fn(),
	revalidate: vi.fn(),
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
	memorySourceBoundary: mocks.boundary,
	db: {
		agentMemoryFile: { findMany: mocks.memory },
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
	mocks.boundary.mockImplementation(async (_actor, where) => ({
		where: { ...where, AND: [{ sourceSkillId: null }] },
		revalidate: mocks.revalidate,
	}));
	mocks.memory.mockImplementation(async () =>
		((await mocks.findFirst())?.memoryFiles ?? []).filter(
			(file: { sourceSkillId?: string | null }) => !file.sourceSkillId,
		),
	);
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
					path: "skills/private/SKILL.md",
					content: "Private draft source instructions",
					sourceSkillId: "example-private-source",
					lastModifiedBy: "user",
					isEnabled: true,
				},
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
		expect(exported.document).not.toContain(
			"Private draft source instructions",
		);
		expect(
			mocks.findFirst.mock.calls[0][0].include.memoryFiles,
		).toBeUndefined();
		expect(mocks.boundary).toHaveBeenCalledWith(
			{ userId: "example-user", organizationId: "source-org" },
			{
				agentInstanceId: "source-instance",
				organizationId: "source-org",
				fileType: "SKILL",
			},
		);
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

describe("implementation-aware portable draft import", () => {
	const implementation = {
		kind: "harness_persistent",
		artifact: {
			digest: `sha256:${"a".repeat(64)}`,
			repository: {
				url: "https://example.com/agents.git",
				revision: "b".repeat(40),
			},
			packages: {
				sdk: {
					name: "@fabric-harness/sdk",
					version: "6.9.0",
					entrypoint: "strict",
				},
				node: { name: "@fabric-harness/node", version: "6.7.0" },
			},
			buildManifestVersion: 2,
		},
		entrypoint: {
			module: "dist/report.mjs",
			export: "reportAgent",
			identity: "report-agent",
		},
		protocol: {
			generation: "example-http-v1",
			interface: "persistent_submission",
		},
		schemas: {
			input: {
				path: "schemas/input.json",
				digest: `sha256:${"c".repeat(64)}`,
			},
			output: {
				path: "schemas/output.json",
				digest: `sha256:${"d".repeat(64)}`,
			},
		},
	};
	const advanced = {
		...definition,
		apiVersion: "fabric.ai/v2",
		implementation,
		logicalBindings: [
			{
				name: "reports-project",
				kind: "project",
				required: true,
				operations: ["read"],
			},
		],
		expectedOutput: "A cited report",
	};
	it("previews exact release metadata and unavailable runtime without starting work", async () => {
		const result = await call(
			previewAgentDefinitionProcedure,
			{ ...input, document: JSON.stringify(advanced) },
			{ context },
		);
		expect(result.definition).toEqual(advanced);
		expect(result.implementationAvailability).toMatchObject({
			available: false,
		});
		expect(result.notices.join(" ")).toContain(
			"qualified execution adapter",
		);
		expect(result.notices.join(" ")).toContain("unresolved declarations");
		expect(mocks.transaction).not.toHaveBeenCalled();
	});
	it("retains a pinned code release as a disconnected local draft with unresolved logical bindings", async () => {
		const result = await call(
			importAgentDefinitionProcedure,
			{ ...input, document: JSON.stringify(advanced) },
			{ context },
		);
		expect(result.implementationAvailability.available).toBe(false);
		const data = mocks.instanceCreate.mock.calls[0][0].data;
		expect(data).toMatchObject({
			status: "DRAFT",
			toolConnections: {},
			triggers: [],
			workspaceIds: [],
			isApiExposed: false,
			customInstructions: {
				portableDefinitionVersion: "fabric.ai/v2",
				portableImplementation: implementation,
				portableBindings: advanced.logicalBindings,
				expectedOutput: "A cited report",
			},
		});
		expect(data.customInstructions).not.toHaveProperty("projectId");
		expect(mocks.auditTx.mock.calls[0][1].metadata).not.toHaveProperty(
			"implementation",
		);
	});
});
