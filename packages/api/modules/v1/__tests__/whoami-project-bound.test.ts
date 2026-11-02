/**
 * `GET /auth/whoami` for an agent that signed in for one project.
 *
 * The route stays open to every credential, and says who the person is. It
 * names the organization hosting the project and the project, and none of the
 * person's other organizations: what the agent was given is one project.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		findUser: vi.fn(),
		createUserApiKey: vi.fn(),
		context: {} as Record<string, unknown>,
	},
}));

vi.mock("@repo/database", () => ({
	createUserApiKey: mocks.createUserApiKey,
	db: { user: { findUnique: mocks.findUser } },
	listUserApiKeys: vi.fn(),
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireApiKey:
		() =>
		async (
			c: { set: (key: string, value: unknown) => void },
			next: () => Promise<void>,
		) => {
			c.set("externalApiContext", mocks.context);
			await next();
		},
	requireScope: () => async (_c: unknown, next: () => Promise<void>) =>
		next(),
}));

vi.mock("../../external-api/middleware/api-rate-limit", () => ({
	externalApiRateLimit:
		() => async (_c: unknown, next: () => Promise<void>) =>
			next(),
}));

for (const [modulePath, name] of [
	["../agents", "registerAgentRoutes"],
	["../channels", "registerChannelRoutes"],
	["../chats", "registerChatRoutes"],
	["../contexts", "registerContextRoutes"],
	["../documents", "registerDocumentRoutes"],
	["../features", "registerFeatureRoutes"],
	["../frames", "registerFrameRoutes"],
	["../instruction-checkouts", "registerInstructionCheckoutRoutes"],
	["../instructions", "registerInstructionRoutes"],
	["../integrations", "registerIntegrationRoutes"],
	["../knowledge", "registerKnowledgeRoutes"],
	["../mcp", "registerMcpRoutes"],
	["../projects", "registerProjectRoutes"],
	["../prompts", "registerPromptRoutes"],
	["../reports", "registerReportRoutes"],
	["../skills", "registerSkillRoutes"],
	["../workflows", "registerWorkflowRoutes"],
	["../workspaces", "registerWorkspaceRoutes"],
] as const) {
	vi.doMock(modulePath, () => ({ [name]: () => undefined }));
}

const { createPublicV1Routes } = await import("../routes");

function member(organizationId: string) {
	return {
		id: `member-${organizationId}`,
		role: "member",
		createdAt: new Date("2026-10-01T00:00:00Z"),
		organization: {
			id: organizationId,
			name: `Organization ${organizationId}`,
			slug: organizationId,
			logo: null,
			createdAt: new Date("2026-09-01T00:00:00Z"),
		},
	};
}

async function whoami() {
	const response = await createPublicV1Routes().fetch(
		new Request("http://localhost/auth/whoami"),
	);
	return (await response.json()) as {
		data: {
			orgs: Array<{ id: string }>;
			organizationContext?: string;
			projectContext?: string;
		};
	};
}

beforeEach(() => {
	mocks.findUser.mockResolvedValue({
		id: "user-1",
		name: "Example Developer",
		email: "dev@example.com",
		role: "user",
		createdAt: new Date("2026-08-01T00:00:00Z"),
		members: [member("org-example-alpha"), member("org-example-beta")],
	});
});

describe("GET /auth/whoami", () => {
	it("names only the organization hosting the project, and the project, for a project-bound agent", async () => {
		mocks.context = {
			keyType: "oauth",
			keyPrefix: "fat_client-r",
			userId: "user-1",
			organizationId: "org-example-alpha",
			boundProjectId: "project-example-one",
			scopes: ["instructions:read"],
		};

		const { data } = await whoami();

		expect(data.orgs.map((org) => org.id)).toEqual(["org-example-alpha"]);
		expect(data.organizationContext).toBe("org-example-alpha");
		expect(data.projectContext).toBe("project-example-one");
	});

	it("names a guest's host organization as nothing, when the guest belongs to none of the person's organizations", async () => {
		mocks.context = {
			keyType: "oauth",
			keyPrefix: "fat_client-r",
			userId: "user-1",
			organizationId: "org-example-elsewhere",
			boundProjectId: "project-example-one",
			scopes: ["instructions:read"],
		};

		const { data } = await whoami();

		expect(data.orgs).toEqual([]);
		expect(data.organizationContext).toBe("org-example-elsewhere");
	});

	it("is unchanged for an organization-wide agent", async () => {
		mocks.context = {
			keyType: "oauth",
			keyPrefix: "fat_client-r",
			userId: "user-1",
			organizationId: "org-example-alpha",
			scopes: ["instructions:read"],
		};

		const { data } = await whoami();

		expect(data.orgs.map((org) => org.id)).toEqual([
			"org-example-alpha",
			"org-example-beta",
		]);
		expect(data).not.toHaveProperty("projectContext");
	});
});

describe("POST /auth/keys", () => {
	it("accepts the dedicated Kanban scopes when the caller holds both", async () => {
		mocks.context = {
			keyType: "personal",
			keyPrefix: "fab_example",
			userId: "user-1",
			organizationId: null,
			scopes: ["keys:write", "kanban:read", "kanban:write"],
		};
		mocks.createUserApiKey.mockResolvedValue({
			id: "key-kanban",
			name: "Fabric Kanban",
			keyPrefix: "fab_example",
			scopes: ["kanban:read", "kanban:write"],
			expiresAt: null,
			createdAt: new Date("2026-11-01T00:00:00Z"),
		});

		const response = await createPublicV1Routes().fetch(
			new Request("http://localhost/auth/keys", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: "Fabric Kanban",
					scopes: ["kanban:read", "kanban:write"],
				}),
			}),
		);

		expect(response.status).toBe(201);
		expect(mocks.createUserApiKey).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				scopes: ["kanban:read", "kanban:write"],
			}),
		);
	});
});
