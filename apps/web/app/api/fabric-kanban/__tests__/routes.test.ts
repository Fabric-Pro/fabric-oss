import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	organizationKeyFind: vi.fn(),
	organizationKeyUpdate: vi.fn(),
	userKeyFind: vi.fn(),
	userKeyUpdate: vi.fn(),
	projectFindMany: vi.fn(),
	queueFindMany: vi.fn(),
	queueFindFirst: vi.fn(),
	queueUpdate: vi.fn(),
	queueUpdateMany: vi.fn(),
	userFindUnique: vi.fn(),
	canUpdateProjectStory: vi.fn(),
	isOrganizationMember: vi.fn(),
	resolveProjectAccess: vi.fn(),
	resolveUserOrganization: vi.fn(),
	verifyLaunchToken: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		organizationApiKey: {
			findFirst: mocks.organizationKeyFind,
			update: mocks.organizationKeyUpdate,
		},
		userApiKey: {
			findFirst: mocks.userKeyFind,
			update: mocks.userKeyUpdate,
		},
		project: { findMany: mocks.projectFindMany },
		kanbanQueue: {
			findMany: mocks.queueFindMany,
			findFirst: mocks.queueFindFirst,
			update: mocks.queueUpdate,
			updateMany: mocks.queueUpdateMany,
		},
		user: { findUnique: mocks.userFindUnique },
	},
	canUpdateProjectStory: (...args: unknown[]) =>
		mocks.canUpdateProjectStory(...args),
	isOrganizationMember: (...args: unknown[]) =>
		mocks.isOrganizationMember(...args),
	resolveProjectAccess: (...args: unknown[]) =>
		mocks.resolveProjectAccess(...args),
	resolveUserOrganization: (...args: unknown[]) =>
		mocks.resolveUserOrganization(...args),
}));

vi.mock("@repo/api/modules/kanban/procedures/create-token", () => ({
	verifyKanbanLaunchToken: (...args: unknown[]) =>
		mocks.verifyLaunchToken(...args),
}));

import { POST as complete } from "../complete/route";
import { GET as me } from "../me/route";
import { GET as listQueue, POST as pullQueue } from "../queue/route";

const organizationKey = {
	id: "organization-key-1",
	organizationId: "example-org",
	createdByUserId: "user-owner",
	scopes: ["mcp:read", "kanban:read", "kanban:write"],
};
const personalKey = {
	id: "personal-key-1",
	userId: "user-owner",
	scopes: ["mcp:read", "mcp:write", "kanban:read", "kanban:write"],
};
const project = {
	id: "project-1",
	name: "Example Project",
	organizationId: "example-org",
	repositoryUrl: "https://example.com/example/project",
	repositoryOwner: "example",
	repositoryName: "project",
	defaultBranch: "main",
};
const queueItem = {
	id: "queue-item-1",
	projectId: project.id,
	storyId: "story-1",
	organizationId: organizationKey.organizationId,
	createdById: organizationKey.createdByUserId,
	status: "PULLED",
	context: {},
	queuedAt: new Date("2026-10-01T00:00:00.000Z"),
	project,
	user: { name: "Example User", email: "dev@example.com" },
};

function request(
	path: string,
	options: { body?: unknown; token?: string; method?: string } = {},
) {
	return new NextRequest(`https://fabric.example${path}`, {
		method: options.method ?? (options.body === undefined ? "GET" : "POST"),
		headers: {
			Authorization: `Bearer ${options.token ?? "org_example_secret_credential"}`,
			...(options.body === undefined
				? {}
				: { "content-type": "application/json" }),
		},
		body:
			options.body === undefined
				? undefined
				: JSON.stringify(options.body),
	});
}

function useLaunchToken() {
	mocks.organizationKeyFind.mockResolvedValue(null);
	mocks.userKeyFind.mockResolvedValue(null);
	mocks.verifyLaunchToken.mockResolvedValue({
		sub: "user-owner",
		organizationId: "example-org",
		projectId: project.id,
	});
}

function useOrganizationKeyScopes(scopes: string[]) {
	mocks.organizationKeyFind.mockResolvedValue({ ...organizationKey, scopes });
}

function usePersonalKeyScopes(scopes: string[]) {
	mocks.organizationKeyFind.mockResolvedValue(null);
	mocks.userKeyFind.mockResolvedValue({ ...personalKey, scopes });
}

const scopeCases = [
	{
		name: "POST /api/fabric-kanban/complete",
		requiredScope: "kanban:write",
		requiredScopeLabel: "Kanban Write",
		roleNote: " Read-only roles can select only Kanban Read.",
		invoke: () =>
			complete(
				request("/api/fabric-kanban/complete", {
					body: { queueItemId: queueItem.id },
				}),
			),
	},
	{
		name: "GET /api/fabric-kanban/queue",
		requiredScope: "kanban:read",
		requiredScopeLabel: "Kanban Read",
		roleNote: "",
		invoke: () =>
			listQueue(
				request(
					"/api/fabric-kanban/queue?repoUrl=https://example.com/example/project",
				),
			),
	},
	{
		name: "POST /api/fabric-kanban/queue",
		requiredScope: "kanban:write",
		requiredScopeLabel: "Kanban Write",
		roleNote: " Read-only roles can select only Kanban Read.",
		invoke: () =>
			pullQueue(
				request("/api/fabric-kanban/queue", {
					body: { itemIds: [queueItem.id] },
				}),
			),
	},
	{
		name: "GET /api/fabric-kanban/me",
		requiredScope: "kanban:read",
		requiredScopeLabel: "Kanban Read",
		roleNote: "",
		invoke: () => me(request("/api/fabric-kanban/me")),
	},
] as const;

function expectNoKanbanResourceLookup() {
	expect(mocks.projectFindMany).not.toHaveBeenCalled();
	expect(mocks.queueFindMany).not.toHaveBeenCalled();
	expect(mocks.queueFindFirst).not.toHaveBeenCalled();
	expect(mocks.queueUpdateMany).not.toHaveBeenCalled();
	expect(mocks.userFindUnique).not.toHaveBeenCalled();
	expect(mocks.resolveProjectAccess).not.toHaveBeenCalled();
	expect(mocks.canUpdateProjectStory).not.toHaveBeenCalled();
}

describe("API key scope enforcement", () => {
	it("keeps authentication failures distinct as a 401", async () => {
		const response = await me(
			new NextRequest("https://fabric.example/api/fabric-kanban/me"),
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Unauthorized" });
		expectNoKanbanResourceLookup();
	});

	it.each(scopeCases)(
		"$name refuses an mcp:read-only organization key before resource lookup",
		async ({ requiredScope, requiredScopeLabel, roleNote, invoke }) => {
			useOrganizationKeyScopes(["mcp:read"]);

			const response = await invoke();

			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({
				error: `Missing required scope: ${requiredScope}. Go to your organization's Settings → API keys and create a new key with ${requiredScopeLabel}.${roleNote}`,
				code: "INSUFFICIENT_SCOPE",
			});
			expectNoKanbanResourceLookup();
		},
	);

	it.each(scopeCases)(
		"$name refuses an mcp:read plus mcp:write personal key before resource lookup",
		async ({ requiredScope, requiredScopeLabel, roleNote, invoke }) => {
			usePersonalKeyScopes(["mcp:read", "mcp:write"]);

			const response = await invoke();

			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({
				error: `Missing required scope: ${requiredScope}. Go to your organization's Settings → API keys and create a new key with ${requiredScopeLabel}.${roleNote}`,
				code: "INSUFFICIENT_SCOPE",
			});
			expectNoKanbanResourceLookup();
		},
	);

	it.each([
		{
			name: "POST /api/fabric-kanban/complete",
			scopes: ["kanban:read"],
			invoke: scopeCases[0].invoke,
		},
		{
			name: "POST /api/fabric-kanban/queue",
			scopes: ["kanban:read"],
			invoke: scopeCases[2].invoke,
		},
		{
			name: "GET /api/fabric-kanban/queue",
			scopes: ["kanban:write"],
			invoke: scopeCases[1].invoke,
		},
		{
			name: "GET /api/fabric-kanban/me",
			scopes: ["kanban:write"],
			invoke: scopeCases[3].invoke,
		},
	])("$name requires its exact Kanban scope", async ({ scopes, invoke }) => {
		useOrganizationKeyScopes(scopes);

		const response = await invoke();

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			code: "INSUFFICIENT_SCOPE",
		});
		expectNoKanbanResourceLookup();
	});
});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.organizationKeyFind.mockResolvedValue(organizationKey);
	mocks.organizationKeyUpdate.mockResolvedValue(undefined);
	mocks.userKeyFind.mockResolvedValue(null);
	mocks.userKeyUpdate.mockResolvedValue(undefined);
	mocks.projectFindMany.mockResolvedValue([project]);
	mocks.queueFindMany.mockResolvedValue([queueItem]);
	mocks.queueFindFirst.mockResolvedValue(queueItem);
	mocks.queueUpdate.mockResolvedValue(queueItem);
	mocks.queueUpdateMany.mockResolvedValue({ count: 1 });
	mocks.userFindUnique.mockResolvedValue({
		name: "Example User",
		email: "dev@example.com",
	});
	mocks.canUpdateProjectStory.mockResolvedValue(true);
	mocks.isOrganizationMember.mockResolvedValue(true);
	mocks.resolveProjectAccess.mockResolvedValue({
		organizationId: organizationKey.organizationId,
		isVisible: true,
		permissions: ["story:read"],
		source: "org",
	});
	mocks.resolveUserOrganization.mockResolvedValue({
		kind: "resolved",
		organizationId: organizationKey.organizationId,
	});
	mocks.verifyLaunchToken.mockRejectedValue(new Error("not a launch token"));
});

describe("POST /api/fabric-kanban/complete", () => {
	it("refuses an organization key whose departed creator retains project access", async () => {
		mocks.isOrganizationMember.mockResolvedValue(false);

		const response = await complete(
			request("/api/fabric-kanban/complete", {
				body: { queueItemId: queueItem.id },
			}),
		);

		expect(response.status).toBe(401);
		expect(mocks.canUpdateProjectStory).not.toHaveBeenCalled();
		expect(mocks.queueUpdateMany).not.toHaveBeenCalled();
	});

	it("does not accept a valid launch token", async () => {
		useLaunchToken();

		const response = await complete(
			request("/api/fabric-kanban/complete", {
				token: "signed-launch-token-with-enough-length",
				body: { queueItemId: queueItem.id },
			}),
		);

		expect(response.status).toBe(401);
		expect(mocks.canUpdateProjectStory).not.toHaveBeenCalled();
		expect(mocks.queueUpdateMany).not.toHaveBeenCalled();
	});

	it("refuses a wildcard key after its creator loses STORY_UPDATE", async () => {
		mocks.organizationKeyFind.mockResolvedValue({
			...organizationKey,
			scopes: ["*"],
		});
		mocks.canUpdateProjectStory.mockResolvedValue(false);

		const response = await complete(
			request("/api/fabric-kanban/complete", {
				body: { queueItemId: queueItem.id, branchName: "fix/example" },
			}),
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "The credential owner no longer has permission to update this Kanban item",
			code: "INSUFFICIENT_PERMISSION",
		});
		expect(mocks.queueUpdate).not.toHaveBeenCalled();
		expect(mocks.queueUpdateMany).not.toHaveBeenCalled();
	});

	it("hides a pulled item queued by another user", async () => {
		mocks.queueFindFirst.mockResolvedValue(null);

		const response = await complete(
			request("/api/fabric-kanban/complete", {
				body: { queueItemId: queueItem.id, branchName: "fix/example" },
			}),
		);

		expect(response.status).toBe(404);
		expect(mocks.queueFindFirst).toHaveBeenCalledWith({
			where: {
				id: queueItem.id,
				organizationId: organizationKey.organizationId,
				createdById: organizationKey.createdByUserId,
				status: "PULLED",
			},
			select: {
				id: true,
				organizationId: true,
				projectId: true,
				storyId: true,
			},
		});
		expect(mocks.queueUpdate).not.toHaveBeenCalled();
		expect(mocks.queueUpdateMany).not.toHaveBeenCalled();
	});

	it("refuses a personal key when its owner lacks permission in the item's organization", async () => {
		mocks.organizationKeyFind.mockResolvedValue(null);
		mocks.userKeyFind.mockResolvedValue(personalKey);
		mocks.canUpdateProjectStory.mockResolvedValue(false);

		const response = await complete(
			request("/api/fabric-kanban/complete", {
				token: "fab_example_secret_credential",
				body: { queueItemId: queueItem.id },
			}),
		);

		expect(response.status).toBe(403);
		expect(mocks.canUpdateProjectStory).toHaveBeenCalledWith(
			project.id,
			personalKey.userId,
		);
		expect(mocks.queueUpdateMany).not.toHaveBeenCalled();
	});

	it("refuses an organization key for an item in another organization", async () => {
		mocks.queueFindFirst.mockResolvedValue({
			...queueItem,
			organizationId: "other-example-org",
		});

		const response = await complete(
			request("/api/fabric-kanban/complete", {
				body: { queueItemId: queueItem.id },
			}),
		);

		expect(response.status).toBe(403);
		expect(mocks.canUpdateProjectStory).not.toHaveBeenCalled();
		expect(mocks.queueUpdateMany).not.toHaveBeenCalled();
	});

	it("fails closed when the loaded item has no organization", async () => {
		mocks.organizationKeyFind.mockResolvedValue(null);
		mocks.userKeyFind.mockResolvedValue(personalKey);
		mocks.queueFindFirst.mockResolvedValue({
			...queueItem,
			organizationId: null,
		});

		const response = await complete(
			request("/api/fabric-kanban/complete", {
				token: "fab_example_secret_credential",
				body: { queueItemId: queueItem.id },
			}),
		);

		expect(response.status).toBe(403);
		expect(mocks.canUpdateProjectStory).not.toHaveBeenCalled();
		expect(mocks.queueUpdateMany).not.toHaveBeenCalled();
	});

	it("conditionally completes its owner's still-pulled item", async () => {
		const response = await complete(
			request("/api/fabric-kanban/complete", {
				body: { queueItemId: queueItem.id, branchName: "fix/example" },
			}),
		);

		expect(response.status).toBe(200);
		expect(mocks.canUpdateProjectStory).toHaveBeenCalledWith(
			project.id,
			organizationKey.createdByUserId,
		);
		expect(mocks.organizationKeyUpdate).toHaveBeenCalledWith({
			where: { id: organizationKey.id },
			data: {
				lastUsedAt: expect.any(Date),
				usageCount: { increment: 1 },
			},
		});
		expect(mocks.queueUpdateMany).toHaveBeenCalledWith({
			where: {
				id: queueItem.id,
				organizationId: organizationKey.organizationId,
				createdById: organizationKey.createdByUserId,
				status: "PULLED",
			},
			data: {
				status: "COMPLETED",
				completedAt: expect.any(Date),
				branchName: "fix/example",
			},
		});
		expect(mocks.queueUpdate).not.toHaveBeenCalled();
	});

	it("returns not found when the conditional completion loses a race", async () => {
		mocks.queueUpdateMany.mockResolvedValue({ count: 0 });

		const response = await complete(
			request("/api/fabric-kanban/complete", {
				body: { queueItemId: queueItem.id },
			}),
		);

		expect(response.status).toBe(404);
	});
});

describe("/api/fabric-kanban/queue", () => {
	it("keeps queue listing available to a launch token without API-key scopes", async () => {
		useLaunchToken();

		const response = await listQueue(
			request(
				"/api/fabric-kanban/queue?repoUrl=https://example.com/example/project",
				{ token: "signed-launch-token-with-enough-length" },
			),
		);

		expect(response.status).toBe(200);
		expect(mocks.resolveProjectAccess).toHaveBeenCalledWith(
			project.id,
			"user-owner",
		);
	});

	it("keeps queue pulls available to a launch token without API-key scopes", async () => {
		useLaunchToken();
		mocks.queueFindMany.mockResolvedValue([
			{
				id: queueItem.id,
				projectId: queueItem.projectId,
				organizationId: queueItem.organizationId,
			},
		]);

		const response = await pullQueue(
			request("/api/fabric-kanban/queue", {
				token: "signed-launch-token-with-enough-length",
				body: { itemIds: [queueItem.id] },
			}),
		);

		expect(response.status).toBe(200);
		expect(mocks.canUpdateProjectStory).toHaveBeenCalledWith(
			project.id,
			"user-owner",
		);
	});

	it("refuses queue listing for an organization key whose departed creator retains project access", async () => {
		mocks.isOrganizationMember.mockResolvedValue(false);

		const response = await listQueue(
			request(
				"/api/fabric-kanban/queue?repoUrl=https://example.com/example/project",
			),
		);

		expect(response.status).toBe(401);
		expect(mocks.resolveProjectAccess).not.toHaveBeenCalled();
		expect(mocks.queueFindMany).not.toHaveBeenCalled();
	});

	it("refuses queue listing for a launch token whose departed subject retains project access", async () => {
		useLaunchToken();
		mocks.isOrganizationMember.mockResolvedValue(false);

		const response = await listQueue(
			request(
				"/api/fabric-kanban/queue?repoUrl=https://example.com/example/project",
				{ token: "signed-launch-token-with-enough-length" },
			),
		);

		expect(response.status).toBe(401);
		expect(mocks.resolveProjectAccess).not.toHaveBeenCalled();
		expect(mocks.queueFindMany).not.toHaveBeenCalled();
	});

	it("refuses queue pulls for an organization key whose departed creator retains project access", async () => {
		mocks.isOrganizationMember.mockResolvedValue(false);

		const response = await pullQueue(
			request("/api/fabric-kanban/queue", {
				body: { itemIds: [queueItem.id] },
			}),
		);

		expect(response.status).toBe(401);
		expect(mocks.canUpdateProjectStory).not.toHaveBeenCalled();
		expect(mocks.queueUpdateMany).not.toHaveBeenCalled();
	});

	it("refuses queue pulls for a launch token whose departed subject retains project access", async () => {
		useLaunchToken();
		mocks.isOrganizationMember.mockResolvedValue(false);

		const response = await pullQueue(
			request("/api/fabric-kanban/queue", {
				token: "signed-launch-token-with-enough-length",
				body: { itemIds: [queueItem.id] },
			}),
		);

		expect(response.status).toBe(401);
		expect(mocks.canUpdateProjectStory).not.toHaveBeenCalled();
		expect(mocks.queueUpdateMany).not.toHaveBeenCalled();
	});

	it("pulls only items queued by a currently authorized credential owner", async () => {
		mocks.queueFindMany.mockResolvedValue([
			{
				id: queueItem.id,
				projectId: queueItem.projectId,
				organizationId: queueItem.organizationId,
			},
		]);

		const response = await pullQueue(
			request("/api/fabric-kanban/queue", {
				body: { itemIds: [queueItem.id] },
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ pulled: 1 });
		expect(mocks.queueFindMany).toHaveBeenCalledWith({
			where: {
				id: { in: [queueItem.id] },
				organizationId: organizationKey.organizationId,
				createdById: organizationKey.createdByUserId,
				status: "PENDING",
			},
			select: { id: true, projectId: true, organizationId: true },
		});
		expect(mocks.canUpdateProjectStory).toHaveBeenCalledWith(
			project.id,
			organizationKey.createdByUserId,
		);
		expect(mocks.queueUpdateMany).toHaveBeenCalledWith({
			where: {
				id: { in: [queueItem.id] },
				organizationId: organizationKey.organizationId,
				createdById: organizationKey.createdByUserId,
				status: "PENDING",
			},
			data: { status: "PULLED", pulledAt: expect.any(Date) },
		});
	});

	it("refuses a launch token after its subject loses project permission", async () => {
		mocks.organizationKeyFind.mockResolvedValue(null);
		mocks.userKeyFind.mockResolvedValue(null);
		mocks.verifyLaunchToken.mockResolvedValue({
			sub: "user-owner",
			organizationId: "example-org",
			projectId: project.id,
		});
		mocks.queueFindMany.mockResolvedValue([
			{
				id: queueItem.id,
				projectId: queueItem.projectId,
				organizationId: queueItem.organizationId,
			},
		]);
		mocks.canUpdateProjectStory.mockResolvedValue(false);

		const response = await pullQueue(
			request("/api/fabric-kanban/queue", {
				token: "signed-launch-token-with-enough-length",
				body: { itemIds: [queueItem.id] },
			}),
		);

		expect(response.status).toBe(403);
		expect(mocks.queueUpdateMany).not.toHaveBeenCalled();
	});

	it("updates only item ids that passed the owner and permission load", async () => {
		mocks.queueFindMany.mockResolvedValue([
			{
				id: queueItem.id,
				projectId: queueItem.projectId,
				organizationId: queueItem.organizationId,
			},
		]);

		const response = await pullQueue(
			request("/api/fabric-kanban/queue", {
				body: { itemIds: [queueItem.id, "queue-item-not-owned"] },
			}),
		);

		expect(response.status).toBe(200);
		expect(mocks.queueUpdateMany).toHaveBeenCalledWith({
			where: {
				id: { in: [queueItem.id] },
				organizationId: organizationKey.organizationId,
				createdById: organizationKey.createdByUserId,
				status: "PENDING",
			},
			data: { status: "PULLED", pulledAt: expect.any(Date) },
		});
	});

	it("lists only the credential owner's pending items", async () => {
		const response = await listQueue(
			request(
				"/api/fabric-kanban/queue?repoUrl=https://example.com/example/project.git",
			),
		);

		expect(response.status).toBe(200);
		expect(mocks.queueFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: { in: [project.id] },
					createdById: organizationKey.createdByUserId,
					status: "PENDING",
				},
			}),
		);
	});

	it("does not reveal whether an unreadable project exists", async () => {
		mocks.organizationKeyFind.mockResolvedValue(null);
		mocks.userKeyFind.mockResolvedValue(personalKey);
		mocks.projectFindMany.mockResolvedValueOnce([]);

		const missingResponse = await listQueue(
			request(
				"/api/fabric-kanban/queue?repoUrl=https://example.com/private/project.git",
				{ token: "fab_example_secret_credential" },
			),
		);
		const missingBody = await missingResponse.json();

		mocks.projectFindMany.mockResolvedValueOnce([project]);
		mocks.resolveProjectAccess.mockResolvedValueOnce(null);
		const unreadableResponse = await listQueue(
			request(
				"/api/fabric-kanban/queue?repoUrl=https://example.com/private/project.git",
				{ token: "fab_example_secret_credential" },
			),
		);
		const unreadableBody = await unreadableResponse.json();

		expect({ status: missingResponse.status, body: missingBody }).toEqual({
			status: 404,
			body: {
				error: "No project found for this repository URL in your organization",
				repoUrl: "https://example.com/private/project",
			},
		});
		expect({
			status: unreadableResponse.status,
			body: unreadableBody,
		}).toEqual({ status: missingResponse.status, body: missingBody });
	});

	it("refuses listing after the owner loses STORY_READ", async () => {
		mocks.resolveProjectAccess.mockResolvedValue({
			organizationId: organizationKey.organizationId,
			isVisible: false,
			permissions: [],
			source: "none",
		});

		const response = await listQueue(
			request(
				"/api/fabric-kanban/queue?repoUrl=https://example.com/example/project",
			),
		);

		expect(response.status).toBe(404);
		expect(mocks.queueFindMany).not.toHaveBeenCalled();
	});

	it("refuses a project access result from another organization", async () => {
		mocks.resolveProjectAccess.mockResolvedValue({
			organizationId: "other-example-org",
			isVisible: true,
			permissions: ["story:read"],
			source: "org",
		});

		const response = await listQueue(
			request(
				"/api/fabric-kanban/queue?repoUrl=https://example.com/example/project",
			),
		);

		expect(response.status).toBe(404);
		expect(mocks.queueFindMany).not.toHaveBeenCalled();
	});

	it("keeps listing available to an accepted project guest", async () => {
		mocks.resolveProjectAccess.mockResolvedValue({
			organizationId: organizationKey.organizationId,
			isVisible: true,
			permissions: ["story:read"],
			source: "project-member",
		});

		const response = await listQueue(
			request(
				"/api/fabric-kanban/queue?repoUrl=https://example.com/example/project",
			),
		);

		expect(response.status).toBe(200);
		expect(mocks.resolveProjectAccess).toHaveBeenCalledWith(
			project.id,
			organizationKey.createdByUserId,
		);
	});

	it("keeps listing available to a current organization member", async () => {
		const response = await listQueue(
			request(
				"/api/fabric-kanban/queue?repoUrl=https://example.com/example/project",
			),
		);

		expect(response.status).toBe(200);
		expect(mocks.resolveProjectAccess).toHaveBeenCalledWith(
			project.id,
			organizationKey.createdByUserId,
		);
	});

	it("fails closed when a personal key matches projects in multiple organizations", async () => {
		mocks.organizationKeyFind.mockResolvedValue(null);
		mocks.userKeyFind.mockResolvedValue(personalKey);
		mocks.projectFindMany.mockResolvedValue([
			project,
			{ ...project, id: "project-2", organizationId: "example-org-2" },
		]);
		mocks.resolveProjectAccess.mockImplementation(async (projectId) => ({
			organizationId:
				projectId === project.id ? "example-org" : "example-org-2",
			isVisible: true,
			permissions: ["story:read"],
			source: "org",
		}));

		const response = await listQueue(
			request(
				"/api/fabric-kanban/queue?repoUrl=https://example.com/example/project",
				{ token: "fab_example_secret_credential" },
			),
		);

		expect(response.status).toBe(403);
		expect(mocks.queueFindMany).not.toHaveBeenCalled();
	});
});

describe("GET /api/fabric-kanban/me", () => {
	it("does not accept a valid launch token", async () => {
		useLaunchToken();

		const response = await me(
			request("/api/fabric-kanban/me", {
				token: "signed-launch-token-with-enough-length",
			}),
		);

		expect(response.status).toBe(401);
		expect(mocks.userFindUnique).not.toHaveBeenCalled();
	});

	it("refuses an organization key after its creator leaves the organization", async () => {
		mocks.isOrganizationMember.mockResolvedValue(false);

		const response = await me(request("/api/fabric-kanban/me"));

		expect(response.status).toBe(401);
		expect(mocks.userFindUnique).not.toHaveBeenCalled();
	});

	it("returns a multi-organization personal-key owner with no organization context", async () => {
		mocks.organizationKeyFind.mockResolvedValue(null);
		mocks.userKeyFind.mockResolvedValue(personalKey);
		mocks.resolveUserOrganization.mockResolvedValue({ kind: "ambiguous" });

		const response = await me(
			request("/api/fabric-kanban/me", {
				token: "fab_example_secret_credential",
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			userId: personalKey.userId,
			organizationId: null,
			name: "Example User",
			email: "dev@example.com",
		});
		expect(mocks.resolveUserOrganization).not.toHaveBeenCalled();
	});

	it("returns a project-guest personal-key owner with no organization context", async () => {
		mocks.organizationKeyFind.mockResolvedValue(null);
		mocks.userKeyFind.mockResolvedValue(personalKey);
		mocks.isOrganizationMember.mockResolvedValue(false);

		const response = await me(
			request("/api/fabric-kanban/me", {
				token: "fab_example_secret_credential",
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			userId: personalKey.userId,
			organizationId: null,
			name: "Example User",
			email: "dev@example.com",
		});
	});

	it("returns a personal-key owner without organization context", async () => {
		mocks.organizationKeyFind.mockResolvedValue(null);
		mocks.userKeyFind.mockResolvedValue(personalKey);

		const response = await me(
			request("/api/fabric-kanban/me", {
				token: "fab_example_secret_credential",
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			userId: personalKey.userId,
			organizationId: null,
			name: "Example User",
			email: "dev@example.com",
		});
		expect(mocks.userKeyUpdate).toHaveBeenCalledWith({
			where: { id: personalKey.id },
			data: {
				lastUsedAt: expect.any(Date),
				usageCount: { increment: 1 },
			},
		});
	});
});
