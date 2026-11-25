import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: {
		member: { findFirst: vi.fn(), findMany: vi.fn() },
		projectMember: { findFirst: vi.fn() },
		user: { findUnique: vi.fn() },
		userApiKey: { findFirst: vi.fn(), update: vi.fn() },
	},
	model: vi.fn(),
}));

vi.mock("@repo/database/prisma/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database/prisma/client")>()),
	db: mocks.db,
}));
vi.mock("@repo/ai/model-selector", () => ({
	getAIModelWithMetadata: mocks.model,
}));

import { createVscodeAuthRoutes } from "../routes";

const app = createVscodeAuthRoutes();
const token = "fab_example_secret";
const userId = "example-user";
const organizationId = "example-org";

function key(scopes: string[]) {
	mocks.db.userApiKey.findFirst.mockResolvedValue({
		id: "example-key",
		userId,
		keyHash: createHash("sha256").update(token).digest("hex"),
		isActive: true,
		expiresAt: null,
		scopes,
	});
}

function get(path: string) {
	return app.request(path, { headers: { Authorization: `Bearer ${token}` } });
}

function complete(body: string, org = organizationId) {
	return app.request("/openrouter/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"x-fabriccode-organizationid": org,
		},
		body,
	});
}

beforeEach(() => {
	vi.resetAllMocks();
	key(["*"]);
	mocks.db.userApiKey.update.mockResolvedValue({});
	mocks.db.member.findFirst.mockResolvedValue(null);
	mocks.db.projectMember.findFirst.mockResolvedValue(null);
});

it.each([
	"/profile",
	"/profile/balance",
	"/defaults",
	"/organizations/example-org/defaults",
	"/openrouter/models",
])("%s refuses a key without the read scope", async (path) => {
	key(["mcp:write"]);
	const response = await get(path);
	expect(response.status).toBe(401);
	expect(await response.json()).toEqual({ error: "Unauthorized" });
	expect(mocks.db.member.findFirst).not.toHaveBeenCalled();
});

it("refuses completions without write scope before checking tenant access", async () => {
	key(["mcp:read"]);
	const response = await complete("{}");
	expect(response.status).toBe(401);
	expect(await response.json()).toEqual({ error: "Unauthorized" });
	expect(mocks.db.member.findFirst).not.toHaveBeenCalled();
	expect(mocks.model).not.toHaveBeenCalled();
});

it.each(["*", "mcp:read"])(
	"refuses organization defaults without a current tie (%s)",
	async (scope) => {
		key([scope]);
		const response = await get("/organizations/other-org/defaults");
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Forbidden",
			message: "You are not a member of this organization",
		});
		expect(mocks.db.member.findFirst).toHaveBeenCalledExactlyOnceWith({
			where: { userId, organizationId: "other-org" },
			select: { id: true },
		});
		expect(
			mocks.db.projectMember.findFirst,
		).toHaveBeenCalledExactlyOnceWith({
			where: {
				userId,
				acceptedAt: { not: null },
				OR: [
					{ expiresAt: null },
					{ expiresAt: { gt: expect.any(Date) } },
				],
				project: { organizationId: "other-org" },
			},
			select: { id: true },
		});
	},
);

it("refuses wildcard completions for an organization the creator cannot access", async () => {
	const response = await complete("{}", "other-org");
	expect(response.status).toBe(403);
	expect(await response.json()).toEqual({
		error: "Forbidden",
		message: "You are not a member of this organization",
	});
	expect(mocks.db.member.findFirst).toHaveBeenCalledWith({
		where: { userId, organizationId: "other-org" },
		select: { id: true },
	});
	expect(mocks.model).not.toHaveBeenCalled();
});

it("returns organization defaults for a current project guest", async () => {
	mocks.db.projectMember.findFirst.mockResolvedValue({
		id: "example-project-membership",
	});
	const response = await get("/organizations/example-org/defaults");
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		defaultModel: "fabric/auto",
		defaultFreeModel: "fabric/fast",
	});
});

it.each([
	["viewer", ["mcp:write"], false],
	["project guest", ["mcp:write"], true],
	["wildcard viewer", ["*"], false],
])("refuses %s without AI_CHAT", async (_label, scopes, guest) => {
	key(scopes as string[]);
	if (guest) {
		mocks.db.projectMember.findFirst.mockResolvedValue({
			id: "example-project-member",
		});
	} else {
		mocks.db.member.findFirst.mockImplementation(async ({ select }) =>
			select.id ? { id: "example-member" } : { role: "viewer" },
		);
	}
	const response = await complete(
		JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
	);
	expect(response.status).toBe(403);
	expect((await response.json()).message).toContain("ai:chat");
	expect(mocks.model).not.toHaveBeenCalled();
});

it("resolves a model in the organization for a member with AI_CHAT", async () => {
	mocks.db.member.findFirst.mockImplementation(async ({ select }) =>
		select.id ? { id: "example-membership" } : { role: "member" },
	);
	mocks.model.mockRejectedValue(new Error("example provider unavailable"));
	const response = await complete(
		JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
	);
	expect(response.status).toBe(400);
	expect(mocks.model).toHaveBeenCalledWith(
		{ taskType: "CHAT", complexity: "medium" },
		{ userId, organizationId },
	);
});

it("rejects a JSON null completion body after tenant authorization", async () => {
	mocks.db.member.findFirst.mockImplementation(async ({ select }) =>
		select.id ? { id: "example-membership" } : { role: "member" },
	);
	const response = await complete("null");
	expect(response.status).toBe(400);
	expect(await response.json()).toEqual({ error: "Invalid JSON body" });
	expect(mocks.model).not.toHaveBeenCalled();
});

it("loads the profile and membership list for the verified creator", async () => {
	mocks.db.user.findUnique.mockResolvedValue({
		id: userId,
		email: "dev@example.com",
		name: "Example Developer",
	});
	mocks.db.member.findMany.mockResolvedValue([
		{
			role: "member",
			organization: { id: organizationId, name: "Example Organization" },
		},
	]);
	const response = await get("/profile");
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		user: { email: "dev@example.com", name: "Example Developer" },
		organizations: [
			{
				id: organizationId,
				name: "Example Organization",
				role: "member",
			},
		],
	});
	expect(mocks.db.user.findUnique).toHaveBeenCalledExactlyOnceWith({
		where: { id: userId },
		select: { id: true, email: true, name: true },
	});
	expect(mocks.db.member.findMany).toHaveBeenCalledExactlyOnceWith({
		where: { userId },
		include: { organization: { select: { id: true, name: true } } },
	});
});
