import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: {
		aiChat: { findFirst: vi.fn(), findMany: vi.fn() },
		member: { findFirst: vi.fn(), findMany: vi.fn() },
		organization: { findFirst: vi.fn() },
		organizationApiKey: { findFirst: vi.fn(), update: vi.fn() },
		project: { findFirst: vi.fn() },
		prompt: { findFirst: vi.fn() },
		user: { findUnique: vi.fn() },
		userApiKey: { findFirst: vi.fn(), update: vi.fn() },
	},
	projectAccess: vi.fn(),
	editProject: vi.fn(),
	createStoryPermission: vi.fn(),
	updateStoryPermission: vi.fn(),
	story: vi.fn(),
	document: vi.fn(),
	workflow: vi.fn(),
	registry: { get: vi.fn() },
}));

vi.mock("@repo/database/prisma/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database/prisma/client")>()),
	db: mocks.db,
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	getProjectAccessById: mocks.projectAccess,
	canEditProject: mocks.editProject,
	canCreateProjectStory: mocks.createStoryPermission,
	canUpdateProjectStory: mocks.updateStoryPermission,
	getVisibleStoryById: mocks.story,
	hasProjectAccess: mocks.projectAccess,
	getDocumentById: mocks.document,
	getWorkflowById: mocks.workflow,
}));

vi.mock("@repo/integrations", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/integrations")>()),
	channelRegistry: mocks.registry,
}));

vi.mock("../../external-api/middleware/api-rate-limit", () => ({
	externalApiRateLimit:
		() => async (_c: unknown, next: () => Promise<void>) =>
			next(),
}));

import { createPublicV1Routes } from "../routes";

const app = createPublicV1Routes();
const organizationId = "example-org";
const userId = "example-user";
const userKey = "fab_example_secret";
const orgKey = "org_example_secret";
const organizationKey = {
	id: "example-key",
	organizationId,
	createdByUserId: userId,
	scopes: ["*"],
};

function request(method: string, path: string, key = orgKey, body?: string) {
	return app.request(path, {
		method,
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		body,
	});
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.db.organizationApiKey.findFirst.mockResolvedValue(organizationKey);
	mocks.db.organizationApiKey.update.mockResolvedValue(organizationKey);
	mocks.db.member.findFirst.mockResolvedValue({
		id: "example-membership",
		role: "owner",
	});
	mocks.db.organization.findFirst.mockResolvedValue({ id: organizationId });
	mocks.db.userApiKey.update.mockResolvedValue({});
	mocks.projectAccess.mockResolvedValue({
		id: "example-project",
		organizationId,
	});
	mocks.editProject.mockResolvedValue(true);
	mocks.createStoryPermission.mockResolvedValue(true);
	mocks.updateStoryPermission.mockResolvedValue(true);
	mocks.story.mockResolvedValue({
		id: "example-story",
		projectId: "example-project",
	});
	mocks.document.mockResolvedValue({
		id: "example-document",
		projectId: "example-project",
	});
	mocks.registry.get.mockReturnValue({ providerKey: "SLACK" });
	mocks.db.prompt.findFirst.mockResolvedValue({
		id: "example-prompt",
		organizationId,
		userId,
		scope: "ORG",
	});
	mocks.db.aiChat.findFirst.mockResolvedValue({
		id: "example-chat",
		userId,
		organizationId,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	});
	mocks.db.aiChat.findMany.mockResolvedValue([]);
	mocks.workflow.mockResolvedValue({
		id: "example-workflow",
		status: "PUBLISHED",
		publishedVersion: 1,
		version: 1,
	});
});

function personalKey(scopes: string[]) {
	const storedKey = {
		id: "example-personal-key",
		userId,
		keyHash: createHash("sha256").update(userKey).digest("hex"),
		isActive: true,
		expiresAt: null,
		scopes,
	};
	mocks.db.userApiKey.findFirst.mockResolvedValue(storedKey);
	return storedKey;
}

const scopedRoutes = [
	...new Set(
		app.routes
			.filter(
				({ method, path }) =>
					method !== "ALL" && path !== "/auth/whoami",
			)
			.map(({ method, path }) => `${method} ${path}`),
	),
].sort();

it.each(scopedRoutes)(
	"%s refuses a credential with no scopes",
	async (route) => {
		const [method, pattern] = route.split(" ", 2);
		const path = pattern.replace(/:[^/]+/g, "example-id");
		mocks.db.organizationApiKey.findFirst.mockResolvedValue({
			...organizationKey,
			scopes: [],
		});
		const response = await request(method, path);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: expect.stringMatching(/^Missing required scope: .+$/),
		});
	},
);

it.each([...scopedRoutes, "GET /auth/whoami"])(
	"%s rejects a wildcard organization key whose creator has left",
	async (route) => {
		const [method, pattern] = route.split(" ", 2);
		mocks.db.member.findFirst.mockResolvedValue(null);
		const response = await request(
			method,
			pattern.replace(/:[^/]+/g, "example-id"),
		);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: "Invalid or expired organization API key",
		});
		expect(mocks.db.member.findFirst).toHaveBeenCalledExactlyOnceWith({
			where: { organizationId, userId },
			select: { id: true },
		});
	},
);

it.each([
	["GET", "/chats", "chats:read", undefined],
	["GET", "/chats/example-chat", "chats:read", undefined],
	["POST", "/chats", "chats:write", {}],
	["PATCH", "/chats/example-chat", "chats:write", { title: "Example" }],
	["DELETE", "/chats/example-chat", "chats:write", undefined],
	[
		"POST",
		"/chats/example-chat/messages",
		"chats:write",
		{ content: "Example" },
	],
	[
		"POST",
		"/channels/slack/send",
		"channels:write",
		{ channelId: "example-channel", text: "Example" },
	],
	["POST", "/agents/example-agent/execute", "agents:execute", { input: {} }],
	["POST", "/workflows/example-workflow/trigger", "workflows:run", {}],
	[
		"POST",
		"/workflows/example-workflow/executions/example-run/cancel",
		"workflows:run",
		{},
	],
	[
		"POST",
		"/integrations/example-plugin/example-operation",
		"integrations:execute",
		{},
	],
	[
		"POST",
		"/integrations/approvals/example-approval/approve",
		"integrations:execute",
		{},
	],
	[
		"POST",
		"/integrations/approvals/example-approval/deny",
		"integrations:execute",
		{},
	],
	["POST", "/prompts", "prompts:write", { name: "Example", key: "example" }],
	["PATCH", "/prompts/example-prompt", "prompts:write", { name: "Example" }],
	[
		"POST",
		"/knowledge/search",
		"knowledge:read",
		{ query: "Example", scope: { kind: "chat", id: "example-chat" } },
	],
] as const)(
	"checks the personal wildcard creator's live permission for %s %s",
	async (method, path, scope, body) => {
		personalKey(["*"]);
		mocks.db.member.findFirst
			.mockResolvedValueOnce({ id: "example-membership" })
			.mockResolvedValueOnce({ role: "viewer" });
		const response = await request(
			method,
			`${path}?org=example-org`,
			userKey,
			JSON.stringify(body),
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: `The key's owner no longer holds the access required for ${scope} in this organization`,
		});
		expect(mocks.db.member.findFirst).toHaveBeenNthCalledWith(2, {
			where: { organizationId, userId },
			select: { role: true },
		});
	},
);

it.each([
	[
		"PUT",
		"/agent-instances/example-agent/run-schedule",
		"agents:execute",
		"agents:schedule",
	],
	[
		"POST",
		"/projects/example-project/contexts/workspace-documents",
		"projects:write",
		"workspaces:read",
	],
] as const)(
	"requires both declared scopes for %s %s",
	async (method, path, first, second) => {
		for (const [present, missing] of [
			[first, second],
			[second, first],
		]) {
			mocks.db.organizationApiKey.findFirst.mockResolvedValue({
				...organizationKey,
				scopes: [present],
			});
			const response = await request(method, path, orgKey, "{}");
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({
				error: `Missing required scope: ${missing}`,
			});
		}
	},
);

it.each(["*", "projects:write"])(
	"refuses project creation after the key creator is demoted (%j)",
	async (scope) => {
		mocks.db.organizationApiKey.findFirst.mockResolvedValue({
			...organizationKey,
			scopes: [scope],
		});
		mocks.db.member.findFirst.mockResolvedValue({
			id: "example-membership",
			role: "viewer",
		});
		const response = await request("POST", "/projects", orgKey, "{}");
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "The key's owner no longer holds the access required for projects:write in this organization",
		});
		expect(mocks.db.member.findFirst).toHaveBeenLastCalledWith({
			where: { organizationId, userId },
			select: { role: true },
		});
	},
);

it("checks the current project-creation permission for a personal wildcard key", async () => {
	personalKey(["*"]);
	mocks.db.member.findFirst
		.mockResolvedValueOnce({ id: "example-membership" })
		.mockResolvedValueOnce({ role: "viewer" });
	const response = await request(
		"POST",
		"/projects?org=example-org",
		userKey,
		"{}",
	);
	expect(response.status).toBe(403);
	expect(await response.json()).toEqual({
		error: "The key's owner no longer holds the access required for projects:write in this organization",
	});
	expect(mocks.db.member.findFirst).toHaveBeenNthCalledWith(2, {
		where: { organizationId, userId },
		select: { role: true },
	});
});

it("refuses a personal wildcard key when its creator is outside the named organization", async () => {
	personalKey(["*"]);
	mocks.db.organization.findFirst.mockResolvedValue({ id: "other-org" });
	mocks.db.member.findFirst.mockResolvedValue(null);
	const response = await request(
		"GET",
		"/projects/example-project?org=other-org",
		userKey,
	);
	expect(response.status).toBe(403);
	expect(await response.json()).toEqual({
		error: { message: "You are not a member of this organization" },
	});
	expect(mocks.db.member.findFirst).toHaveBeenCalledExactlyOnceWith({
		where: { organizationId: "other-org", userId },
		select: { id: true },
	});
	expect(mocks.db.project.findFirst).not.toHaveBeenCalled();
});

it("fails closed when a personal wildcard key has no organization to resolve", async () => {
	personalKey(["*"]);
	mocks.db.user.findUnique.mockResolvedValue({
		lastActiveOrganizationId: null,
		members: [],
	});
	const response = await request("GET", "/projects/example-project", userKey);
	expect(response.status).toBe(403);
	expect(await response.json()).toEqual({
		error: {
			message: expect.stringContaining("its owner belongs to none"),
		},
	});
	expect(mocks.db.user.findUnique).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ where: { id: userId } }),
	);
	expect(mocks.db.project.findFirst).not.toHaveBeenCalled();
});

it("uses the bound organization when a wildcard key names another organization", async () => {
	mocks.db.project.findFirst.mockResolvedValue(null);
	const response = await request(
		"GET",
		"/projects/other-project?org=other-org",
	);
	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({
		error: { message: "Project not found" },
	});
	expect(mocks.db.organization.findFirst).not.toHaveBeenCalled();
	expect(mocks.db.project.findFirst).toHaveBeenCalledWith(
		expect.objectContaining({
			where: expect.objectContaining({
				id: "other-project",
				organizationId,
			}),
		}),
	);
});

it("does not let an account key revoke another user's key", async () => {
	const storedKey = personalKey(["*"]);
	mocks.db.userApiKey.findFirst
		.mockResolvedValueOnce(storedKey)
		.mockResolvedValueOnce(null);
	const response = await request("DELETE", "/auth/keys/other-key", userKey);
	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({
		error: { message: "API key not found" },
	});
	expect(mocks.db.userApiKey.findFirst).toHaveBeenLastCalledWith({
		where: { id: "other-key", userId },
		select: { id: true, isActive: true },
	});
});

it("checks the caller's chat permission before reading its messages", async () => {
	personalKey(["chats:read"]);
	mocks.db.member.findFirst
		.mockResolvedValueOnce({ id: "example-membership" })
		.mockResolvedValueOnce({ role: "viewer" });
	const response = await request(
		"GET",
		"/chats/example-chat?org=example-org",
		userKey,
	);
	expect(response.status).toBe(403);
	expect(await response.json()).toEqual({
		error: "The key's owner no longer holds the access required for chats:read in this organization",
	});
	expect(mocks.db.aiChat.findFirst).not.toHaveBeenCalled();
});

it("reads only the verified creator's chat in the key's organization", async () => {
	const response = await request("GET", "/chats/example-chat?org=other-org");
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		data: { id: "example-chat", organizationId, userId },
	});
	expect(mocks.db.aiChat.findFirst).toHaveBeenCalledExactlyOnceWith({
		where: { id: "example-chat", organizationId, userId },
	});
});

const nullBodyRoutes = [
	["POST", "/auth/keys"],
	["POST", "/projects"],
	["PATCH", "/projects/example-project"],
	["POST", "/projects/example-project/features"],
	["PATCH", "/projects/example-project/features/example-story"],
	["POST", "/projects/example-project/documents"],
	["PATCH", "/documents/example-document"],
	["POST", "/chats"],
	["PATCH", "/chats/example-chat"],
	["POST", "/chats/example-chat/messages"],
	["POST", "/prompts"],
	["PATCH", "/prompts/example-prompt"],
	["POST", "/channels/slack/send"],
	["POST", "/knowledge/search"],
	["POST", "/workspaces/example-workspace/query"],
	["POST", "/workflows/example-workflow/trigger"],
] as const;

it.each(nullBodyRoutes)(
	"%s %s rejects a JSON null body",
	async (method, path) => {
		const response = await request(method, path, orgKey, "null");
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: { message: "Invalid JSON body" },
		});
	},
);
