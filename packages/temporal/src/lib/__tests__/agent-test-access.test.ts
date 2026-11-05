import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	scoped: vi.fn(),
	project: vi.fn(),
	projectAccess: vi.fn(),
	deleted: vi.fn(),
	documentCount: vi.fn(),
	workspace: vi.fn(),
	skill: vi.fn(),
	skillPermission: vi.fn(),
	memory: vi.fn(),
	permissions: vi.fn(),
	bindings: vi.fn(),
	integrations: vi.fn(),
	template: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		workspaceDocument: { count: m.documentCount },
		agentMemoryFile: { findMany: m.memory },
		agentMCPServerConfiguration: { findMany: m.bindings },
		agentIntegrationConfiguration: { findMany: m.integrations },
		agentTemplate: { findUnique: m.template },
	},
	getAgentTemplateInstanceForRead: m.scoped,
	getProjectAccessContext: m.project,
	hasProjectAccess: m.projectAccess,
	isProjectSoftDeleted: m.deleted,
	getSkillById: m.skill,
	canReadOrganizationSkills: m.skillPermission,
	Permissions: { CONTEXT_READ: "context:read" },
	hasPermission: (permissions: string[], required: string) =>
		permissions.includes(required),
}));
vi.mock("@repo/database/prisma/queries/workspaces/document-content", () => ({
	authorizeWorkspaceDocumentRead: m.workspace,
}));
vi.mock("@repo/rag/lib/context-quality/project-access", () => ({
	resolveEffectiveProjectPermissions: m.permissions,
}));

import {
	assertAgentTestSourceScope,
	boundAgentTest,
	loadAgentTestScope,
} from "../agent-test-access";

const actor = { userId: "example-user", organizationId: "example-org" };
const instance = {
	id: "example-agent",
	sId: "example-logical-agent",
	version: 1,
	userId: actor.userId,
	organizationId: actor.organizationId,
	workspaceIds: ["example-workspace"],
	customInstructions: {
		knowledgeFilters: [
			{
				workspaceId: "example-workspace",
				documentIds: ["example-document"],
			},
		],
	},
	memoryFiles: [],
};
const scope = {
	instanceId: instance.id,
	projectId: "example-project",
	workspaceIds: instance.workspaceIds,
	workspaceDocumentFilters: instance.customInstructions.knowledgeFilters,
	skillIds: ["example-skill"],
};
beforeEach(() => {
	vi.resetAllMocks();
	m.scoped.mockResolvedValue({ instance, projectId: scope.projectId });
	m.project.mockResolvedValue({ organizationId: actor.organizationId });
	m.projectAccess.mockResolvedValue(true);
	m.deleted.mockResolvedValue(false);
	m.workspace.mockResolvedValue(undefined);
	m.documentCount.mockResolvedValue(1);
	m.skillPermission.mockResolvedValue(true);
	m.skill.mockResolvedValue({
		scope: "ORGANIZATION",
		organizationId: actor.organizationId,
	});
	m.memory.mockResolvedValue([{ sourceSkillId: "example-skill" }]);
	m.bindings.mockResolvedValue([]);
	m.integrations.mockResolvedValue([]);
	m.template.mockResolvedValue({
		instructions: "Example template",
		version: 1,
	});
	m.permissions.mockResolvedValue({
		organizationId: actor.organizationId,
		organizationDeleted: false,
		permissions: ["context:read"],
	});
});
describe("agent test historical source access", () => {
	it("keeps saved owner/org, canonical document selectors and skill IDs in a metadata-only snapshot", async () => {
		const result = await loadAgentTestScope(actor, instance.id);
		expect(result.scope).toMatchObject({
			...scope,
			configHash: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(JSON.stringify(result.scope)).not.toContain("credentials");
		expect(m.scoped).toHaveBeenCalledWith({
			...actor,
			instanceId: instance.id,
		});
	});
	it("refuses an agent owned by another current organization member", async () => {
		m.scoped.mockResolvedValue({
			instance: { ...instance, userId: "example-other-user" },
			projectId: scope.projectId,
		});
		await expect(
			loadAgentTestScope(actor, instance.id),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("refuses an unavailable or foreign organization agent", async () => {
		m.scoped.mockResolvedValue(null);
		await expect(
			assertAgentTestSourceScope(actor, scope),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("does not convert malformed persisted selectors into unrestricted access", async () => {
		m.scoped.mockResolvedValue({
			instance: {
				...instance,
				customInstructions: { knowledgeFilters: "all" },
			},
			projectId: scope.projectId,
		});
		await expect(loadAgentTestScope(actor, instance.id)).rejects.toThrow();
	});
	it.each(["foreign", "removed", "deleted"])(
		"withholds reports when project authority is %s",
		async (kind) => {
			if (kind === "foreign") {
				m.project.mockResolvedValue({
					organizationId: "example-other-org",
				});
			}
			if (kind === "removed") {
				m.projectAccess.mockResolvedValue(false);
			}
			if (kind === "deleted") {
				m.deleted.mockResolvedValue(true);
			}
			await expect(
				assertAgentTestSourceScope(actor, scope),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		},
	);
	it("requires current project context-read permission beyond project membership", async () => {
		m.permissions.mockResolvedValue({
			organizationId: actor.organizationId,
			organizationDeleted: false,
			permissions: [],
		});
		await expect(
			assertAgentTestSourceScope(actor, scope),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("withholds results after workspace permission removal", async () => {
		m.workspace.mockRejectedValue(new Error("Example denied"));
		await expect(
			assertAgentTestSourceScope(actor, scope),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("withholds results after a selected document disappears", async () => {
		m.documentCount.mockResolvedValue(0);
		await expect(
			assertAgentTestSourceScope(actor, scope),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("inactive saved selectors grant no workspace/document reads", async () => {
		await assertAgentTestSourceScope(actor, {
			...scope,
			workspaceDocumentFilters: [
				{
					workspaceId: "example-inactive",
					documentIds: ["example-hidden"],
				},
			],
		});
		expect(m.documentCount).not.toHaveBeenCalled();
		expect(m.workspace).not.toHaveBeenCalledWith(
			expect.objectContaining({ workspaceId: "example-inactive" }),
		);
	});
	it.each(["role", "foreign", "deleted"])(
		"requires current skill authority: %s",
		async (kind) => {
			if (kind === "role") {
				m.skillPermission.mockResolvedValue(false);
			}
			if (kind === "foreign") {
				m.skill.mockResolvedValue({
					scope: "ORGANIZATION",
					organizationId: "example-other-org",
				});
			}
			if (kind === "deleted") {
				m.skill.mockResolvedValue(null);
			}
			await expect(
				assertAgentTestSourceScope(actor, scope),
			).rejects.toThrow();
		},
	);
	it("bounds retained test data before storage", () => {
		expect(() =>
			boundAgentTest({ input: "x".repeat(129 * 1024) }),
		).toThrow();
	});
});

describe("agent test semantic configuration fingerprint", () => {
	it("ignores instance usage timestamps but changes for model or instructions", async () => {
		const initial = await loadAgentTestScope(actor, instance.id);
		m.scoped.mockResolvedValue({
			instance: {
				...instance,
				updatedAt: new Date("2026-01-02T00:00:00Z"),
			},
			projectId: scope.projectId,
		});
		expect(
			(await loadAgentTestScope(actor, instance.id)).scope.configHash,
		).toBe(initial.scope.configHash);
		m.scoped.mockResolvedValue({
			instance: { ...instance, modelOverride: "example-different-model" },
			projectId: scope.projectId,
		});
		expect(
			(await loadAgentTestScope(actor, instance.id)).scope.configHash,
		).not.toBe(initial.scope.configHash);
		m.scoped.mockResolvedValue({
			instance: {
				...instance,
				customInstructions: {
					...instance.customInstructions,
					role: "Example changed instructions",
				},
			},
			projectId: scope.projectId,
		});
		expect(
			(await loadAgentTestScope(actor, instance.id)).scope.configHash,
		).not.toBe(initial.scope.configHash);
	});
});
