import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	agentPreviewDraftSchema,
	agentPreviewStartSchema,
} from "../agent-preview-contracts";

const m = vi.hoisted(() => ({
	member: vi.fn(),
	execute: vi.fn(),
	readSkills: vi.fn(),
	instance: vi.fn(),
	project: vi.fn(),
	projectAccess: vi.fn(),
	deleted: vi.fn(),
	workspace: vi.fn(),
	documents: vi.fn(),
	skill: vi.fn(),
	skillFiles: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		member: { findFirst: m.member },
		workspaceDocument: { count: m.documents },
		skillFile: { count: m.skillFiles },
	},
	canExecuteOrganizationAgents: m.execute,
	canReadOrganizationSkills: m.readSkills,
	getAgentTemplateInstanceForRead: m.instance,
	getSkillById: m.skill,
	hasProjectAccess: m.projectAccess,
	isProjectSoftDeleted: m.deleted,
	hasPermission: (permissions: string[], permission: string) =>
		permissions.includes(permission),
	Permissions: { CONTEXT_READ: "context:read" },
}));
vi.mock("@repo/database/prisma/queries/workspaces/document-content", () => ({
	authorizeWorkspaceDocumentRead: m.workspace,
	WorkspaceDocumentContentError: class extends Error {
		constructor(readonly code: string) {
			super("Workspace unavailable");
		}
	},
}));
vi.mock("@repo/rag/lib/context-quality/project-access", () => ({
	resolveEffectiveProjectPermissions: m.project,
}));

import { WorkspaceDocumentContentError } from "@repo/database/prisma/queries/workspaces/document-content";
import {
	assertAgentPreviewAccess,
	previewRequestHash,
	previewWorkflowId,
} from "../agent-preview-access";

const actor = { userId: "example-user", organizationId: "example-org" };
const draft = agentPreviewDraftSchema.parse({
	instanceId: "example-agent",
	instructions: "Use selected sources",
	projectId: "example-project",
	workspaceIds: ["example-workspace"],
	workspaceDocumentFilters: [
		{ workspaceId: "example-workspace", documentIds: ["example-document"] },
	],
	skillIds: ["example-skill"],
	capabilityIds: ["project-context"],
});
beforeEach(() => {
	vi.resetAllMocks();
	m.member.mockResolvedValue({ role: "member" });
	m.execute.mockResolvedValue(true);
	m.readSkills.mockResolvedValue(true);
	m.instance.mockResolvedValue({ id: "example-agent" });
	m.project.mockResolvedValue({
		organizationId: actor.organizationId,
		organizationDeleted: false,
		permissions: ["context:read"],
	});
	m.projectAccess.mockResolvedValue(true);
	m.deleted.mockResolvedValue(false);
	m.workspace.mockResolvedValue(undefined);
	m.documents.mockResolvedValue(1);
	m.skill.mockResolvedValue({
		id: "example-skill",
		scope: "ORGANIZATION",
		organizationId: actor.organizationId,
	});
	m.skillFiles.mockResolvedValue(0);
});
describe("draft preview current resource authority", () => {
	it("scopes every selected object to the current actor and organization", async () => {
		await expect(
			assertAgentPreviewAccess(actor, draft),
		).resolves.toBeUndefined();
		expect(m.member).toHaveBeenCalledWith({
			where: { ...actor, organization: { deletedAt: null } },
			select: { role: true },
		});
		expect(m.execute).toHaveBeenCalledWith(
			actor.userId,
			actor.organizationId,
		);
		expect(m.instance).toHaveBeenCalledWith({
			...actor,
			instanceId: draft.instanceId,
		});
		expect(m.projectAccess).toHaveBeenCalledWith(
			draft.projectId,
			actor.userId,
			actor.organizationId,
		);
		expect(m.workspace).toHaveBeenCalledWith({
			...actor,
			workspaceId: "example-workspace",
		});
		expect(m.documents).toHaveBeenCalledWith({
			where: {
				id: { in: ["example-document"] },
				workspaceId: "example-workspace",
			},
		});
		expect(m.skill).toHaveBeenCalledWith("example-skill", actor);
	});
	it.each(["member", "execute"])(
		"refuses lost %s authority before resource reads",
		async (kind) => {
			if (kind === "member") {
				m.member.mockResolvedValue(null);
			} else {
				m.execute.mockResolvedValue(false);
			}
			await expect(
				assertAgentPreviewAccess(actor, draft),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(m.instance).not.toHaveBeenCalled();
			expect(m.workspace).not.toHaveBeenCalled();
		},
	);
	it("refuses an inaccessible saved-agent base", async () => {
		m.instance.mockResolvedValue(null);
		await expect(
			assertAgentPreviewAccess(actor, draft),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it.each([
		{ organizationId: "example-other-org", permissions: ["context:read"] },
		{
			organizationId: actor.organizationId,
			organizationDeleted: true,
			permissions: ["context:read"],
		},
		{ organizationId: actor.organizationId, permissions: [] },
	])(
		"refuses project tenant/permission/deletion mismatch %j",
		async (value) => {
			m.project.mockResolvedValue(value);
			await expect(
				assertAgentPreviewAccess(actor, draft),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(m.workspace).not.toHaveBeenCalled();
		},
	);
	it.each(["projectAccess", "deleted"])(
		"refuses current project object denial %s",
		async (kind) => {
			if (kind === "projectAccess") {
				m.projectAccess.mockResolvedValue(false);
			} else {
				m.deleted.mockResolvedValue(true);
			}
			await expect(
				assertAgentPreviewAccess(actor, draft),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		},
	);
	it("maps workspace authorization errors to safe transport errors", async () => {
		const error = new WorkspaceDocumentContentError("FORBIDDEN");
		error.message = "private workspace details";
		m.workspace.mockRejectedValue(error);
		await expect(
			assertAgentPreviewAccess(actor, draft),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Workspace not found or access denied.",
		});
		expect(m.documents).not.toHaveBeenCalled();
	});
	it("rejects a selected document outside its workspace", async () => {
		m.documents.mockResolvedValue(0);
		await expect(
			assertAgentPreviewAccess(actor, draft),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it.each([
		{
			workspaceDocumentFilters: [
				{
					workspaceId: "example-other-workspace",
					documentIds: ["example-document"],
				},
			],
		},
		{ workspaceIds: ["example-workspace", "example-workspace"] },
		{
			workspaceDocumentFilters: [
				{
					workspaceId: "example-workspace",
					documentIds: ["example-document", "example-document"],
				},
			],
		},
	])("refuses ambiguous or cross-workspace selections %j", async (extra) => {
		await expect(
			assertAgentPreviewAccess(actor, { ...draft, ...extra }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.workspace).not.toHaveBeenCalled();
	});
	it.each([
		null,
		{
			id: "example-other-skill",
			scope: "ORGANIZATION",
			organizationId: "example-other-org",
		},
	])("refuses inaccessible selected skills", async (skill) => {
		m.skill.mockResolvedValue(skill);
		await expect(
			assertAgentPreviewAccess(actor, draft),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("accepts system skill instructions but refuses silently omitting attached files", async () => {
		m.skill.mockResolvedValue({
			id: "example-skill",
			scope: "SYSTEM",
			organizationId: null,
		});
		await expect(
			assertAgentPreviewAccess(actor, draft),
		).resolves.toBeUndefined();
		m.skillFiles.mockResolvedValue(1);
		await expect(
			assertAgentPreviewAccess(actor, draft),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("attached files"),
		});
	});
	it("binds idempotency identity to actor and the complete normalized request", () => {
		const request = agentPreviewStartSchema.parse({
			draft,
			userMessage: "Summarize",
			idempotencyKey: "f41587c3-1015-41a4-b5dd-3559cd8aa9b5",
		});
		const first = previewRequestHash(request);
		expect(
			previewRequestHash({ ...request, userMessage: "Changed" }),
		).not.toBe(first);
		expect(
			previewRequestHash({
				...request,
				history: [{ role: "user", content: "Earlier instruction" }],
			}),
		).not.toBe(first);
		expect(
			previewWorkflowId(
				{ ...actor, userId: "example-other-user" },
				request.idempotencyKey,
			),
		).not.toBe(previewWorkflowId(actor, request.idempotencyKey));
		expect(
			previewWorkflowId(
				{ ...actor, organizationId: "example-other-org" },
				request.idempotencyKey,
			),
		).not.toBe(previewWorkflowId(actor, request.idempotencyKey));
	});
});

it("requires the current skill-read permission independently of agent execution", async () => {
	m.readSkills.mockResolvedValue(false);
	await expect(assertAgentPreviewAccess(actor, draft)).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	expect(m.skill).not.toHaveBeenCalled();
});
