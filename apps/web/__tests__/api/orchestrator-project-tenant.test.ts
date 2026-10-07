/**
 * The orchestrator stream must not run one organization's chat with another
 * organization's project.
 *
 * The route checks membership of the organization the request names and access
 * to the project, but project access admits an invited guest and ignores the
 * organization argument it is given. A member of one organization who is a
 * guest on another organization's project could therefore pair the two, either
 * by naming the project in the body or through a conversation that carries it.
 * The comparison in `resolve-request-tenant.ts` is unit-tested beside the
 * route; these tests pin what the route does with it: the workflow starts in
 * the named organization with no project.
 *
 * Harness mirrors orchestrator-workspace-access.test.ts. Its project-access
 * mock admits every project, so the organization comparison is the only thing
 * that can keep a project out here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();
const getAIModelWithMetadataMock = vi.fn();
const trackUsageMock = vi.fn();
const getTemporalClientMock = vi.fn();
const getHandleMock = vi.fn();
const startWorkflowMock = vi.fn();
const memberFindFirstMock = vi.fn();
const conversationFindFirstMock = vi.fn();
const getConversationProjectMock = vi.fn();
const projectFindUniqueMock = vi.fn();
const hasProjectAccessMock = vi.fn();

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => getSessionMock(),
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: (...args: unknown[]) =>
		getAIModelWithMetadataMock(...args),
}));

vi.mock("@repo/agent-core/backend", () => ({
	getDefaultEnabledMcpConfigIds: vi.fn(async () => []),
}));

vi.mock("@repo/observability", () => ({
	metricsTracker: { trackAiLimitSignal: vi.fn() },
}));

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class AiUsageLimitExceededError extends Error {},
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: () => getTemporalClientMock(),
}));

vi.mock("@repo/database", async () => ({
	// Turn admission (see ./_helpers/conversation-turn-db-mocks.ts).
	...(
		await import("./_helpers/conversation-turn-db-mocks")
	).conversationTurnDbMocks(),
	CARRIED_OVER_MARKER_PREFIX: "[carried-over]",
	db: {
		agentConversation: {
			findFirst: (...args: unknown[]) =>
				conversationFindFirstMock(...args),
		},
		member: {
			findFirst: (...args: unknown[]) => memberFindFirstMock(...args),
		},
		project: {
			findUnique: (...args: unknown[]) => projectFindUniqueMock(...args),
		},
		aiChat: { findFirst: vi.fn(async () => null) },
	},
	getConversationWorkspaces: vi.fn(async () => []),
	getConversationProject: (...args: unknown[]) =>
		getConversationProjectMock(...args),
	hasProjectAccess: (...args: unknown[]) => hasProjectAccessMock(...args),
	filterAccessibleWorkspaceIds: vi.fn(async () => ({
		allowed: [],
		dropped: [],
	})),
}));

const SESSION_USER_ID = "user-1";
const ORGANIZATION_ID = "example-org";
const OTHER_ORGANIZATION_ID = "another-example-org";

/** Which organization each synthetic project belongs to. */
const PROJECT_ORGANIZATIONS: Record<string, string> = {
	"project-of-example-org": ORGANIZATION_ID,
	"project-of-another-org": OTHER_ORGANIZATION_ID,
};

function postBody(b: Record<string, unknown>) {
	return { json: async () => b } as never;
}

async function post(body: Record<string, unknown>) {
	const { POST } = await import(
		"../../app/api/agents/fabric-ai/orchestrator-temporal/stream/route"
	);
	const response = await POST(postBody(body));
	await response.text();
	return response;
}

function startedInput(): Record<string, unknown> | undefined {
	return startWorkflowMock.mock.calls[0]?.[1]?.args?.[0] as
		| Record<string, unknown>
		| undefined;
}

function startedMemo(): unknown {
	return startWorkflowMock.mock.calls[0]?.[1]?.memo;
}

describe("POST orchestrator-temporal/stream — project within the request's organization", () => {
	const originalCacheHost = process.env.CACHE_HOST;
	const originalRedisUrl = process.env.REDIS_URL;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		// Keep `getRedisUrl()` at null so the route never reaches for ioredis.
		delete process.env.CACHE_HOST;
		delete process.env.REDIS_URL;

		// A real session always carries its `session` record.
		getSessionMock.mockResolvedValue({
			user: { id: SESSION_USER_ID },
			session: {},
		});
		getAIModelWithMetadataMock.mockResolvedValue({
			trackUsage: trackUsageMock,
		});
		memberFindFirstMock.mockResolvedValue({ id: "member-1" });
		// A guest on the other organization's project can open it.
		hasProjectAccessMock.mockResolvedValue(true);
		getConversationProjectMock.mockResolvedValue(null);
		projectFindUniqueMock.mockImplementation(
			async (query: { where: { id: string } }) => {
				const organizationId = PROJECT_ORGANIZATIONS[query.where.id];
				return organizationId ? { organizationId } : null;
			},
		);
		// The caller owns "conversation-1" in ORGANIZATION_ID; nothing else.
		conversationFindFirstMock.mockImplementation(
			async (query: {
				where: { id: string; userId: string; organizationId?: string };
			}) =>
				query.where.id === "conversation-1" &&
				query.where.userId === SESSION_USER_ID &&
				query.where.organizationId === ORGANIZATION_ID
					? {
							id: "conversation-1",
							organizationId: ORGANIZATION_ID,
							parentConversationId: null,
							carriedOverSummary: null,
						}
					: null,
		);
		startWorkflowMock.mockResolvedValue({
			workflowId: "wf-project-tenant",
			describe: async () => ({
				status: { name: "COMPLETED" },
				memo: { userId: SESSION_USER_ID },
			}),
			query: async () => {
				throw new Error("workflow closed");
			},
			result: async () => ({ status: "completed", response: "ok" }),
		});
		getTemporalClientMock.mockResolvedValue({
			workflow: { getHandle: getHandleMock, start: startWorkflowMock },
		});
	});

	afterEach(() => {
		if (originalCacheHost === undefined) {
			delete process.env.CACHE_HOST;
		} else {
			process.env.CACHE_HOST = originalCacheHost;
		}
		if (originalRedisUrl === undefined) {
			delete process.env.REDIS_URL;
		} else {
			process.env.REDIS_URL = originalRedisUrl;
		}
	});

	it("starts the chat in the named organization without a body project of another organization", async () => {
		const response = await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			projectId: "project-of-another-org",
		});

		expect(response.status).toBe(200);
		expect(startWorkflowMock).toHaveBeenCalledTimes(1);
		expect(startedInput()?.organizationId).toBe(ORGANIZATION_ID);
		expect(startedInput()?.projectId).toBeUndefined();
		// The memo carries no project field at all; pin its exact shape so a
		// project added to it later has to come through the same check.
		expect(startedMemo()).toEqual({
			userId: SESSION_USER_ID,
			organizationId: ORGANIZATION_ID,
			turnId: "turn-example-1",
		});
		// Dropped before the access check, which never sees it.
		expect(hasProjectAccessMock).not.toHaveBeenCalled();
	});

	it("drops a project of another organization that comes from the conversation", async () => {
		getConversationProjectMock.mockResolvedValue({
			project: { id: "project-of-another-org" },
		});

		await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			conversationId: "conversation-1",
		});

		expect(getConversationProjectMock).toHaveBeenCalledWith(
			"conversation-1",
		);
		expect(projectFindUniqueMock).toHaveBeenCalledWith({
			where: { id: "project-of-another-org" },
			select: { organizationId: true },
		});
		expect(startedInput()?.conversationId).toBe("conversation-1");
		expect(startedInput()?.projectId).toBeUndefined();
	});

	it("keeps a project of the named organization", async () => {
		await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			projectId: "project-of-example-org",
		});

		expect(hasProjectAccessMock).toHaveBeenCalledWith(
			"project-of-example-org",
			SESSION_USER_ID,
			ORGANIZATION_ID,
		);
		expect(startedInput()?.projectId).toBe("project-of-example-org");
	});

	it("keeps a conversation's project of the named organization", async () => {
		getConversationProjectMock.mockResolvedValue({
			project: { id: "project-of-example-org" },
		});

		await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			conversationId: "conversation-1",
		});

		expect(startedInput()?.projectId).toBe("project-of-example-org");
	});

	it("drops a project of another organization from a request that runs in the session's organization", async () => {
		getSessionMock.mockResolvedValue({
			user: { id: SESSION_USER_ID },
			session: { activeOrganizationId: ORGANIZATION_ID },
		});

		await post({
			message: "hello",
			projectId: "project-of-another-org",
		});

		expect(startedInput()?.organizationId).toBe(ORGANIZATION_ID);
		expect(startedInput()?.projectId).toBeUndefined();
		expect(hasProjectAccessMock).not.toHaveBeenCalled();
	});

	// The body is parsed by hand. An id that is an object would read as a
	// Prisma filter in the membership check (`{ not: "" }` matches any
	// membership the caller has) and in the tenant filters after it.
	it.each([
		["organizationId", { not: "" }],
		["organizationId", [ORGANIZATION_ID]],
		["organizationId", 1],
		["organizationId", true],
		["projectId", { not: "" }],
		["projectId", ["project-of-example-org"]],
		["projectId", 1],
	])("refuses a %s of %j before reading anything", async (field, value) => {
		const { POST } = await import(
			"../../app/api/agents/fabric-ai/orchestrator-temporal/stream/route"
		);
		const response = await POST(
			postBody({
				message: "hello",
				organizationId: ORGANIZATION_ID,
				projectId: "project-of-example-org",
				conversationId: "conversation-1",
				[field]: value,
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "Invalid request body",
			message: `${field} must be a string`,
		});
		expect(conversationFindFirstMock).not.toHaveBeenCalled();
		expect(projectFindUniqueMock).not.toHaveBeenCalled();
		expect(hasProjectAccessMock).not.toHaveBeenCalled();
		expect(memberFindFirstMock).not.toHaveBeenCalled();
		expect(getAIModelWithMetadataMock).not.toHaveBeenCalled();
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});

	it("treats a null organization and project as absent", async () => {
		getSessionMock.mockResolvedValue({
			user: { id: SESSION_USER_ID },
			session: { activeOrganizationId: ORGANIZATION_ID },
		});
		const withNull = await post({
			message: "hello",
			organizationId: null,
			projectId: null,
		});
		const nullInput = startedInput();
		const nullMemo = startedMemo();
		startWorkflowMock.mockClear();

		const omitted = await post({ message: "hello" });

		expect(withNull.status).toBe(omitted.status);
		expect(nullInput).toBeDefined();
		// Only the run's own id differs between the two starts.
		expect({ ...nullInput, executionId: undefined }).toEqual({
			...startedInput(),
			executionId: undefined,
		});
		expect(nullMemo).toEqual(startedMemo());
		expect(startedInput()?.organizationId).toBe(ORGANIZATION_ID);
	});

	it("still refuses a guest who names the project's own organization", async () => {
		memberFindFirstMock.mockResolvedValue(null);

		const response = await post({
			message: "hello",
			organizationId: OTHER_ORGANIZATION_ID,
			projectId: "project-of-another-org",
		});

		expect(response.status).toBe(403);
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});
});
