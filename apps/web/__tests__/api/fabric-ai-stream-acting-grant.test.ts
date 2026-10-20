/**
 * The Direct chat route vouches for the turn it starts.
 *
 * Fabric's tools reach the person's data through the Fabric MCP gateway as the
 * worker, which holds a secret every internal service holds. What says "this
 * turn acts for this user in this organization" is the acting grant the route
 * mints from the session it just authenticated and puts in the workflow input.
 * If the route stopped minting it, every Fabric tool in a turn would be refused
 * at the gateway while every activity test, which sets the field by hand,
 * stayed green.
 *
 * Runs the real route with its Temporal, database, auth and rate-limit
 * modules mocked; the grant is signed and checked for real.
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

process.env.BETTER_AUTH_SECRET = "test-secret-that-is-at-least-32-chars-long";

const getSessionMock = vi.fn();
const getAIModelWithMetadataMock = vi.fn();
const hasOrganizationTieMock = vi.fn();
const startWorkflowMock = vi.fn();
const findConversationMock = vi.fn();
const getAccessibleFrameByIdMock = vi.fn();
const getProjectAccessContextMock = vi.fn();

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => getSessionMock(),
}));

vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: vi.fn(async () => ({
		allowed: true,
		remaining: 19,
		resetInSeconds: 60,
	})),
	RATE_LIMIT_PRESETS: { ai: { limit: 20, windowMs: 60_000 } },
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: (...args: unknown[]) =>
		getAIModelWithMetadataMock(...args),
	getCurrentDateContext: () => "Today is 2026-10-05.",
}));

vi.mock("@repo/agent-core/backend", () => ({
	getDefaultEnabledMcpConfigIds: vi.fn(async () => []),
}));

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class AiUsageLimitExceededError extends Error {},
}));

vi.mock("@repo/temporal", () => ({
	decodeHeartbeatDetails: vi.fn(() => undefined),
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: startWorkflowMock },
	})),
	isTemporalAvailable: vi.fn(async () => true),
}));

vi.mock("@repo/database", () => ({
	db: {
		agentConversation: {
			findFirst: (...args: unknown[]) => findConversationMock(...args),
		},
		project: { findUnique: vi.fn(async () => null) },
		userStory: { findMany: vi.fn(async () => []) },
		projectDocument: { findMany: vi.fn(async () => []) },
		codingRun: { findMany: vi.fn(async () => []) },
	},
	hasOrganizationTie: (...args: unknown[]) => hasOrganizationTieMock(...args),
	getConversationWorkspaces: vi.fn(async () => []),
	getConversationProject: vi.fn(async () => null),
	getProjectAccessContext: (...args: unknown[]) =>
		getProjectAccessContextMock(...args),
	getAccessibleFrameById: (...args: unknown[]) =>
		getAccessibleFrameByIdMock(...args),
	filterAccessibleWorkspaceIds: vi.fn(async () => ({
		allowed: [],
		dropped: [],
	})),
}));

const SESSION_USER_ID = "user-1";
const ORGANIZATION_ID = "example-org";
const CONVERSATION_ID = "conversation-1";
const SESSION_EMAIL = "member@example.com";
const PROJECT_ID = "project-1";
const FRAME_ID = "frame-1";

const CHAT_BODY = {
	message: "Make me a weekly status page",
	organizationId: ORGANIZATION_ID,
};

function postBody(b: Record<string, unknown>) {
	return { json: async () => b } as never;
}

const loadRoute = () => import("../../app/api/agents/fabric-ai/stream/route");

async function post(body: Record<string, unknown>) {
	const { POST } = await loadRoute();
	const response = await POST(postBody(body));
	await response.text();
	return response;
}

function startedInput(): Record<string, unknown> {
	const [, options] = startWorkflowMock.mock.calls[0] ?? [];
	return options?.args?.[0] as Record<string, unknown>;
}

describe("POST fabric-ai/stream — the acting grant", () => {
	// The route's module graph is large; load it once, outside any test's timeout.
	beforeAll(async () => {
		await loadRoute();
	}, 120_000);

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);

		getSessionMock.mockResolvedValue({
			user: { id: SESSION_USER_ID, email: SESSION_EMAIL },
			session: { activeOrganizationId: ORGANIZATION_ID },
		});
		hasOrganizationTieMock.mockResolvedValue(true);
		getAccessibleFrameByIdMock.mockResolvedValue(null);
		getProjectAccessContextMock.mockResolvedValue(null);
		findConversationMock.mockResolvedValue({
			id: CONVERSATION_ID,
			organizationId: ORGANIZATION_ID,
		});
		getAIModelWithMetadataMock.mockResolvedValue({ trackUsage: vi.fn() });
		startWorkflowMock.mockImplementation(
			async (_type: string, options: { workflowId: string }) => ({
				workflowId: options.workflowId,
				describe: async () => ({ status: { name: "COMPLETED" } }),
				result: async () => ({
					success: true,
					responseText: "ok",
					toolCalls: [],
				}),
			}),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("starts the turn with a grant minted for this user and organization", async () => {
		const { checkActingGrant } = await import(
			"@repo/api/lib/agent-service-auth"
		);

		const response = await post({
			message: "Make me a weekly status page",
			organizationId: ORGANIZATION_ID,
		});

		expect(response.status).toBe(200);
		const input = startedInput();
		expect(typeof input.actingGrant).toBe("string");
		expect(
			checkActingGrant(input.actingGrant as string, {
				userId: SESSION_USER_ID,
				organizationId: ORGANIZATION_ID,
			}),
		).toEqual({ ok: true });
	});

	it("binds the grant to the person and the organization of this turn alone", async () => {
		const { checkActingGrant } = await import(
			"@repo/api/lib/agent-service-auth"
		);

		await post({
			message: "Make me a weekly status page",
			organizationId: ORGANIZATION_ID,
		});

		const grant = startedInput().actingGrant as string;
		expect(
			checkActingGrant(grant, {
				userId: "someone-else",
				organizationId: ORGANIZATION_ID,
			}),
		).toEqual({ ok: false, reason: "mismatch" });
		expect(
			checkActingGrant(grant, {
				userId: SESSION_USER_ID,
				organizationId: "another-org",
			}),
		).toEqual({ ok: false, reason: "mismatch" });
	});

	it.each(["workspace", "artifact"] as const)(
		"authorizes the current %s frame before starting with its usage origin",
		async (surface) => {
			getProjectAccessContextMock.mockResolvedValue({
				organizationId: ORGANIZATION_ID,
			});
			getAccessibleFrameByIdMock.mockResolvedValue({
				id: FRAME_ID,
				projectId: PROJECT_ID,
			});
			const response = await post({
				...CHAT_BODY,
				projectId: PROJECT_ID,
				launchFrameId: FRAME_ID,
				workspaceId: surface === "workspace" ? FRAME_ID : undefined,
				surface,
				usageFrameId: "client-forged-frame",
			});

			expect(response.status).toBe(200);
			expect(getProjectAccessContextMock).toHaveBeenCalledWith(
				PROJECT_ID,
				SESSION_USER_ID,
			);
			expect(getAccessibleFrameByIdMock).toHaveBeenCalledWith({
				id: FRAME_ID,
				userId: SESSION_USER_ID,
				userEmail: SESSION_EMAIL,
				organizationId: ORGANIZATION_ID,
			});
			expect(startWorkflowMock).toHaveBeenCalledTimes(1);
			expect(startedInput()).toMatchObject({
				projectId: PROJECT_ID,
				usageFrameId: FRAME_ID,
				surface,
			});
			expect(startedInput().workspaceId).toBe(
				surface === "workspace" ? FRAME_ID : undefined,
			);
		},
	);

	it("validates the legacy Workspace launcher before deriving usage origin", async () => {
		getAccessibleFrameByIdMock.mockResolvedValue({
			id: FRAME_ID,
			projectId: null,
		});
		const response = await post({
			...CHAT_BODY,
			workspaceId: FRAME_ID,
			surface: "workspace",
		});

		expect(response.status).toBe(200);
		expect(startedInput().usageFrameId).toBe(FRAME_ID);
		expect(getAccessibleFrameByIdMock).toHaveBeenCalledWith({
			id: FRAME_ID,
			userId: SESSION_USER_ID,
			userEmail: SESSION_EMAIL,
			organizationId: ORGANIZATION_ID,
		});
	});

	it.each(["launchFrameId", "workspaceId"])(
		"refuses malformed %s before charging or starting",
		async (field) => {
			const response = await post({ ...CHAT_BODY, [field]: { not: "" } });

			expect(response.status).toBe(400);
			expect(getAccessibleFrameByIdMock).not.toHaveBeenCalled();
			expect(getAIModelWithMetadataMock).not.toHaveBeenCalled();
			expect(startWorkflowMock).not.toHaveBeenCalled();
		},
	);

	it("refuses conflicting explicit and legacy launch frames", async () => {
		const response = await post({
			...CHAT_BODY,
			launchFrameId: FRAME_ID,
			workspaceId: "another-frame",
		});

		expect(response.status).toBe(400);
		expect(getAccessibleFrameByIdMock).not.toHaveBeenCalled();
		expect(getAIModelWithMetadataMock).not.toHaveBeenCalled();
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});

	it.each(["missing-frame", "inaccessible-frame", "foreign-tenant-frame"])(
		"refuses a canonical access denial for %s before charging or starting",
		async (launchFrameId) => {
			const response = await post({ ...CHAT_BODY, launchFrameId });

			expect(response.status).toBe(403);
			expect(getAccessibleFrameByIdMock).toHaveBeenCalledWith({
				id: launchFrameId,
				userId: SESSION_USER_ID,
				userEmail: SESSION_EMAIL,
				organizationId: ORGANIZATION_ID,
			});
			expect(getAIModelWithMetadataMock).not.toHaveBeenCalled();
			expect(startWorkflowMock).not.toHaveBeenCalled();
		},
	);

	it("refuses a frame attached to a different authorized project", async () => {
		getProjectAccessContextMock.mockResolvedValue({
			organizationId: ORGANIZATION_ID,
		});
		getAccessibleFrameByIdMock.mockResolvedValue({
			id: FRAME_ID,
			projectId: "another-project",
		});
		const response = await post({
			...CHAT_BODY,
			projectId: PROJECT_ID,
			launchFrameId: FRAME_ID,
		});

		expect(response.status).toBe(403);
		expect(getProjectAccessContextMock).toHaveBeenCalledWith(
			PROJECT_ID,
			SESSION_USER_ID,
		);
		expect(getAIModelWithMetadataMock).not.toHaveBeenCalled();
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});

	it("refuses an attached frame after current project access is denied", async () => {
		getAccessibleFrameByIdMock.mockResolvedValue({
			id: FRAME_ID,
			projectId: PROJECT_ID,
		});
		const response = await post({
			...CHAT_BODY,
			projectId: PROJECT_ID,
			launchFrameId: FRAME_ID,
		});

		expect(response.status).toBe(403);
		expect(getAIModelWithMetadataMock).not.toHaveBeenCalled();
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});

	it.each([{}, { usageFrameId: "client-forged-frame" }])(
		"leaves the usage frame absent without a launch origin (%j)",
		async (body) => {
			const response = await post({ ...CHAT_BODY, ...body });

			expect(response.status).toBe(200);
			expect(getAccessibleFrameByIdMock).not.toHaveBeenCalled();
			expect(startWorkflowMock).toHaveBeenCalledTimes(1);
			expect(startedInput()).not.toHaveProperty("usageFrameId");
		},
	);

	it("binds the grant to the conversation the turn belongs to", async () => {
		const { checkActingGrant } = await import(
			"@repo/api/lib/agent-service-auth"
		);

		await post({
			message: "Make me a weekly status page",
			organizationId: ORGANIZATION_ID,
			conversationId: CONVERSATION_ID,
		});

		const input = startedInput();
		expect(input.conversationId).toBe(CONVERSATION_ID);
		expect(
			checkActingGrant(input.actingGrant as string, {
				userId: SESSION_USER_ID,
				organizationId: ORGANIZATION_ID,
				conversationId: CONVERSATION_ID,
			}),
		).toEqual({ ok: true });
		expect(
			checkActingGrant(input.actingGrant as string, {
				userId: SESSION_USER_ID,
				organizationId: ORGANIZATION_ID,
				conversationId: "a-different-conversation",
			}),
		).toEqual({ ok: false, reason: "mismatch" });
	});
});
