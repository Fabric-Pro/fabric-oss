import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	organization: vi.fn(),
	instance: vi.fn(),
	execute: vi.fn(),
	read: vi.fn(),
	project: vi.fn(),
	deleted: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: { organization: { findFirst: h.organization } },
}));
vi.mock("../prisma/queries/agent-templates", () => ({
	getAgentTemplateInstance: h.instance,
}));
vi.mock("../prisma/queries/organization-permissions", () => ({
	canExecuteOrganizationAgents: h.execute,
	canReadOrganizationAgentTemplates: h.read,
}));
vi.mock("../prisma/queries/projects/projects", () => ({
	getProjectAccessContext: h.project,
	isProjectSoftDeleted: h.deleted,
}));

import {
	getAgentTemplateInstanceForExecution,
	getAgentTemplateInstanceForRead,
} from "../prisma/queries/agent-instance-execution-scope";

const actor = {
	instanceId: "example-agent",
	userId: "example-user",
	organizationId: "example-org",
};
beforeEach(() => {
	vi.clearAllMocks();
	h.organization.mockResolvedValue({ id: actor.organizationId });
	h.execute.mockResolvedValue(true);
	h.read.mockResolvedValue(true);
	h.instance.mockResolvedValue({
		organizationId: actor.organizationId,
		customInstructions: { projectId: "example-project" },
	});
	h.project.mockResolvedValue({ organizationId: actor.organizationId });
	h.deleted.mockResolvedValue(false);
});
describe("named agent current execution scope", () => {
	it("resolves the persisted project with live actor access", async () => {
		expect(await getAgentTemplateInstanceForExecution(actor)).toMatchObject(
			{ projectId: "example-project" },
		);
		expect(h.project).toHaveBeenCalledWith("example-project", actor.userId);
	});
	it("does not load an instance after execution permission revocation", async () => {
		h.execute.mockResolvedValue(false);
		expect(await getAgentTemplateInstanceForExecution(actor)).toBeNull();
		expect(h.instance).not.toHaveBeenCalled();
	});
	it("refuses deleted organizations", async () => {
		h.organization.mockResolvedValue(null);
		expect(await getAgentTemplateInstanceForExecution(actor)).toBeNull();
	});
	it("does not reuse a same-user instance from another organization", async () => {
		h.instance.mockResolvedValue({
			organizationId: "example-other",
			customInstructions: {},
		});
		expect(await getAgentTemplateInstanceForExecution(actor)).toBeNull();
	});
	it.each([null, { organizationId: "example-other" }])(
		"refuses inaccessible or differently scoped projects",
		async (access) => {
			h.project.mockResolvedValue(access);
			expect(
				await getAgentTemplateInstanceForExecution(actor),
			).toBeNull();
		},
	);
	it("refuses soft-deleted projects", async () => {
		h.deleted.mockResolvedValue(true);
		expect(await getAgentTemplateInstanceForExecution(actor)).toBeNull();
	});
	it("fails closed on conflicting legacy and current project metadata", async () => {
		h.instance.mockResolvedValue({
			organizationId: actor.organizationId,
			customInstructions: { projectId: "example-project" },
			toolConnections: {
				"project-context": { projectId: "example-other" },
			},
		});
		expect(await getAgentTemplateInstanceForExecution(actor)).toBeNull();
	});
	it("refuses a stale legacy binding after the canonical project was cleared", async () => {
		h.instance.mockResolvedValue({
			organizationId: actor.organizationId,
			customInstructions: { projectId: null },
			toolConnections: {
				"project-context": { projectId: "example-project" },
			},
		});
		expect(await getAgentTemplateInstanceForExecution(actor)).toBeNull();
	});
	it("uses current template-read permission for result inspection without requiring execute permission", async () => {
		h.execute.mockResolvedValue(false);
		expect(await getAgentTemplateInstanceForRead(actor)).not.toBeNull();
		h.read.mockResolvedValue(false);
		expect(await getAgentTemplateInstanceForRead(actor)).toBeNull();
	});
});
