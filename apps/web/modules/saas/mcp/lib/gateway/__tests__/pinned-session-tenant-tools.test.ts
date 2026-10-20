/**
 * The portal tools that name no project, on a service session limited to a
 * meeting's project. Whatever they are asked, they answer for the grant's user
 * in the grant's organization: a session cannot be walked into another
 * organization, listed another's memberships, or made to read another's chats,
 * workspaces or connected servers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	memberFindMany: vi.fn(),
	userUpdate: vi.fn(),
	aiChatFindMany: vi.fn(),
	isOrganizationMember: vi.fn(),
	getProjectSummaryById: vi.fn(),
	listProjects: vi.fn(),
	createProject: vi.fn(),
	canCreateProjectInOrganization: vi.fn(),
	getInstructionSummariesForProjects: vi.fn(),
	listWorkspaces: vi.fn(),
	listMcpConfigsForTenant: vi.fn(),
	getProjectAccessContext: vi.fn(),
}));

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));
vi.mock("@repo/api/lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: async () => ({ permissions: [] }),
}));
vi.mock("@repo/database", () => ({
	db: {
		member: { findMany: mocks.memberFindMany },
		user: { update: mocks.userUpdate },
		aiChat: { findMany: mocks.aiChatFindMany },
	},
	isOrganizationMember: mocks.isOrganizationMember,
	isProjectSoftDeleted: vi.fn().mockResolvedValue(false),
	getProjectAccessContext: mocks.getProjectAccessContext,
	getProjectSummaryById: mocks.getProjectSummaryById,
	listProjects: mocks.listProjects,
	createProject: mocks.createProject,
	canCreateProjectInOrganization: mocks.canCreateProjectInOrganization,
	getInstructionSummariesForProjects:
		mocks.getInstructionSummariesForProjects,
	listWorkspaces: mocks.listWorkspaces,
	listMcpConfigsForTenant: mocks.listMcpConfigsForTenant,
	hasPermission: () => true,
	Permissions: { INSTRUCTION_READ: "instruction:read" },
}));

import { PARLUME_GRANT_SCOPES } from "@repo/api/lib/agent-service-auth";
import { executePlatformTool } from "../platform-tools";
import { serviceSessionScopes } from "../tool-scope";
import type { GatewaySession } from "../types";

const PROJECT = "project-meeting";

function pinned(): GatewaySession {
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
		createdAt: new Date("2026-01-01T00:00:00Z"),
		expiresAt: new Date("2026-01-02T00:00:00Z"),
	};
}

function payload(result: { content: Array<{ text: string }> }) {
	return JSON.parse(result.content[0].text);
}

const membershipIn = (id: string) => ({
	role: "member",
	organization: { id, name: `Org ${id}`, slug: id },
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.memberFindMany.mockImplementation(
		async ({ where }: { where: { organizationId?: string } }) =>
			[membershipIn("org-1"), membershipIn("org-2")].filter(
				(membership) =>
					where.organizationId === undefined ||
					membership.organization.id === where.organizationId,
			),
	);
	mocks.isOrganizationMember.mockResolvedValue(true);
	mocks.getProjectAccessContext.mockResolvedValue({
		organizationId: "org-1",
	});
	mocks.getInstructionSummariesForProjects.mockResolvedValue(new Map());
	mocks.getProjectSummaryById.mockResolvedValue({
		id: PROJECT,
		name: "Meeting project",
		description: null,
		status: "ACTIVE",
		heroEmojis: [],
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
	});
	mocks.listProjects.mockResolvedValue({
		projects: [],
		total: 0,
		hasMore: false,
	});
	mocks.canCreateProjectInOrganization.mockResolvedValue(true);
	mocks.createProject.mockResolvedValue({ id: "new", name: "New" });
	mocks.aiChatFindMany.mockResolvedValue([]);
	mocks.listWorkspaces.mockResolvedValue({
		workspaces: [],
		total: 0,
		hasMore: false,
	});
	mocks.listMcpConfigsForTenant.mockResolvedValue([]);
});

describe("fabric_switch_organization on a pinned session", () => {
	it.each([
		["another organization the person belongs to", "org-2"],
		["the organization it already acts in", "org-1"],
		["an organization the person does not belong to", "org-9"],
	])(
		"is refused for %s, and the session stays where it was",
		async (_name, target) => {
			const session = pinned();

			const result = await executePlatformTool(
				"fabric_switch_organization",
				{ organizationId: target },
				session,
			);

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("single organization");
			expect(session.organizationId).toBe("org-1");
			expect(mocks.userUpdate).not.toHaveBeenCalled();
			expect(mocks.isOrganizationMember).not.toHaveBeenCalled();
		},
	);

	it("does not move the organization the next tool call answers for", async () => {
		const session = pinned();

		await executePlatformTool(
			"fabric_switch_organization",
			{ organizationId: "org-2" },
			session,
		);
		await executePlatformTool("fabric_list_chats", {}, session);

		expect(mocks.aiChatFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { organizationId: "org-1", userId: "user-1" },
			}),
		);
	});
});

describe("the organizations a pinned session is told about", () => {
	it("is the one it acts in, though the person belongs to others", async () => {
		const result = await executePlatformTool(
			"fabric_list_organizations",
			{},
			pinned(),
		);

		expect(mocks.memberFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { userId: "user-1", organizationId: "org-1" },
			}),
		);
		expect(payload(result)).toMatchObject({
			count: 1,
			activeOrganizationId: "org-1",
		});
		expect(
			payload(result).organizations.map((org: { id: string }) => org.id),
		).toEqual(["org-1"]);
	});

	it("is the one it acts in for the identity too, whatever organization the call names", async () => {
		const result = await executePlatformTool(
			"fabric_get_identity",
			{ organizationId: "org-2" },
			pinned(),
		);

		expect(
			payload(result).organizations.map((org: { id: string }) => org.id),
		).toEqual(["org-1"]);
		expect(payload(result).organizationId).toBe("org-1");
	});
});

describe("fabric_list_projects on a pinned session", () => {
	it("lists the meeting's project alone, however the call filters", async () => {
		const result = await executePlatformTool(
			"fabric_list_projects",
			{ search: "other", status: "ARCHIVED", limit: 50 },
			pinned(),
		);

		expect(mocks.listProjects).not.toHaveBeenCalled();
		expect(mocks.getProjectSummaryById).toHaveBeenCalledWith(
			PROJECT,
			"user-1",
			"org-1",
		);
		expect(
			payload(result).projects.map(
				(project: { id: string }) => project.id,
			),
		).toEqual([PROJECT]);
		expect(payload(result)).toMatchObject({ total: 1, hasMore: false });
	});

	it("lists nothing when the person can no longer open the meeting's project", async () => {
		mocks.getProjectSummaryById.mockResolvedValue(null);

		const result = await executePlatformTool(
			"fabric_list_projects",
			{},
			pinned(),
		);

		expect(payload(result)).toMatchObject({ projects: [], total: 0 });
	});
});

describe("fabric_create_project on a pinned session", () => {
	it("creates in the session's organization, whatever organization the call names", async () => {
		const session = pinned();

		const result = await executePlatformTool(
			"fabric_create_project",
			{ name: "Roadmap", organizationId: "org-2" },
			session,
		);

		expect(result.isError).toBeUndefined();
		expect(mocks.canCreateProjectInOrganization).toHaveBeenCalledWith(
			"user-1",
			"org-1",
		);
		expect(mocks.createProject).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
			}),
		);
	});

	it("leaves the session on the meeting's project, not the new one", async () => {
		const session = pinned();

		await executePlatformTool(
			"fabric_create_project",
			{ name: "Roadmap" },
			session,
		);

		expect(session.pinnedProjectId).toBe(PROJECT);
		expect(session.organizationId).toBe("org-1");
	});

	it("is refused for someone who may not create projects in the organization", async () => {
		mocks.canCreateProjectInOrganization.mockResolvedValue(false);

		const result = await executePlatformTool(
			"fabric_create_project",
			{ name: "Roadmap" },
			pinned(),
		);

		expect(result.isError).toBe(true);
		expect(mocks.createProject).not.toHaveBeenCalled();
	});
});

describe("the tenant-wide reads on a pinned session", () => {
	it("lists chats of the grant's user in the grant's organization only", async () => {
		await executePlatformTool(
			"fabric_list_chats",
			{ userId: "user-2", organizationId: "org-2" },
			pinned(),
		);

		expect(mocks.aiChatFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { organizationId: "org-1", userId: "user-1" },
			}),
		);
	});

	it("lists workspaces of the grant's user in the grant's organization only", async () => {
		await executePlatformTool(
			"fabric_list_workspaces",
			{ organizationId: "org-2" },
			pinned(),
		);

		expect(mocks.listWorkspaces).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
			}),
		);
	});

	it("lists connected servers of the grant's user in the grant's organization only", async () => {
		await executePlatformTool(
			"fabric_list_connected_servers",
			{ organizationId: "org-2" },
			pinned(),
		);

		expect(mocks.listMcpConfigsForTenant).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
	});
});
