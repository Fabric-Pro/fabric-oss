/**
 * The Advisor's chat routes when every ChatGPT plan serving the member is
 * spent (Fizzy #2770): Direct and Orchestrator answer the plan's own 429 with
 * when it resets, before model resolution, so a plan-only organization never
 * reads "No AI provider configured" and no run starts that can only fail.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();
const getAIModelWithMetadataMock = vi.fn();
const planSpentMock = vi.fn();
const startWorkflowMock = vi.fn();

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => getSessionMock(),
}));

vi.mock("@repo/ai/lib/chatgpt-plan/plan-spent-response", () => ({
	chatGptPlanSpentChatResponse: (...args: unknown[]) =>
		planSpentMock(...args),
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
	getCurrentDateContext: () => "Today is 2026-10-08.",
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
	decodeHeartbeatDetails: vi.fn(() => undefined),
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: startWorkflowMock, getHandle: vi.fn() },
	})),
	isTemporalAvailable: vi.fn(async () => true),
}));

vi.mock("@repo/database", async () => ({
	...(
		await import("./_helpers/conversation-turn-db-mocks")
	).conversationTurnDbMocks(),
	CARRIED_OVER_MARKER_PREFIX: "[carried-over]",
	db: {
		agentConversation: { findFirst: vi.fn(async () => null) },
		member: { findFirst: vi.fn(async () => ({ id: "member-1" })) },
		aiChat: { findFirst: vi.fn(async () => null) },
	},
	hasOrganizationTie: vi.fn(async () => true),
	getConversationWorkspaces: vi.fn(async () => []),
	getConversationProject: vi.fn(async () => null),
	getProjectAccessContext: vi.fn(async () => null),
	hasProjectAccess: vi.fn(async () => true),
	filterAccessibleWorkspaceIds: vi.fn(async () => ({
		allowed: [],
		dropped: [],
	})),
}));

const ORGANIZATION_ID = "example-org";
const SPENT_BODY = {
	error: "Every ChatGPT plan this work may use has no usage left in this window.",
	code: "subscription_sharing_usage_limit_exceeded",
	resetAt: "2026-10-08T17:50:00.000Z",
	apiBillingOption: false,
};

function postBody(body: Record<string, unknown>) {
	return { json: async () => body } as never;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	getSessionMock.mockResolvedValue({
		user: { id: "user-1" },
		session: { activeOrganizationId: ORGANIZATION_ID },
	});
	getAIModelWithMetadataMock.mockResolvedValue({ trackUsage: vi.fn() });
	planSpentMock.mockResolvedValue(
		new Response(JSON.stringify(SPENT_BODY), {
			status: 429,
			headers: { "Content-Type": "application/json" },
		}),
	);
});

describe.each([
	["Direct", "../../app/api/agents/fabric-ai/stream/route"],
	[
		"Orchestrator",
		"../../app/api/agents/fabric-ai/orchestrator-temporal/stream/route",
	],
])("POST %s stream with every plan spent", (_mode, path) => {
	it("answers the plan's 429 with its reset, before resolving a model or starting a run", async () => {
		const { POST } = (await import(path)) as {
			POST: (request: never) => Promise<Response>;
		};
		const response = await POST(
			postBody({ message: "Hello", organizationId: ORGANIZATION_ID }),
		);

		expect(response.status).toBe(429);
		expect(await response.json()).toEqual(SPENT_BODY);
		expect(planSpentMock).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: ORGANIZATION_ID,
		});
		expect(getAIModelWithMetadataMock).not.toHaveBeenCalled();
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});
});
