/**
 * The Direct chat route opts every turn in to the organization's company
 * context (Fizzy #2719).
 *
 * Every caller of this route is the Advisor: the Fabric AI page, the Fabric
 * Agent drawer, or a custom agent chosen in one of them. So the route starts
 * `directChatWorkflow` with `companyContextAdvisor: true` unconditionally,
 * and the chat activity checks membership, the feature gate and a ready
 * source itself. Without this test, dropping the field would turn company
 * context off in Direct mode while every activity test, which sets the flag
 * by hand, stays green.
 *
 * Runs the real route with its Temporal, database, auth and rate-limit
 * modules mocked; the organization resolver is real, over a mocked tie check.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();
const getAIModelWithMetadataMock = vi.fn();
const hasOrganizationTieMock = vi.fn();
const startWorkflowMock = vi.fn();

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
		agentConversation: { findFirst: vi.fn(async () => null) },
	},
	hasOrganizationTie: (...args: unknown[]) => hasOrganizationTieMock(...args),
	getConversationWorkspaces: vi.fn(async () => []),
	getConversationProject: vi.fn(async () => null),
	getProjectAccessContext: vi.fn(async () => null),
	filterAccessibleWorkspaceIds: vi.fn(async () => ({
		allowed: [],
		dropped: [],
	})),
}));

const SESSION_USER_ID = "user-1";
const ORGANIZATION_ID = "example-org";

function postBody(b: Record<string, unknown>) {
	return { json: async () => b } as never;
}

async function post(body: Record<string, unknown>) {
	const { POST } = await import(
		"../../app/api/agents/fabric-ai/stream/route"
	);
	const response = await POST(postBody(body));
	// Drains the SSE stream, which closes once the workflow reports done.
	await response.text();
	return response;
}

function started(): { workflowType: unknown; input: Record<string, unknown> } {
	const [workflowType, options] = startWorkflowMock.mock.calls[0] ?? [];
	return {
		workflowType,
		input: options?.args?.[0] as Record<string, unknown>,
	};
}

describe("POST fabric-ai/stream — the Advisor's company-context opt-in", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);

		getSessionMock.mockResolvedValue({
			user: { id: SESSION_USER_ID },
			session: { activeOrganizationId: ORGANIZATION_ID },
		});
		hasOrganizationTieMock.mockResolvedValue(true);
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

	it("starts the Direct workflow opted in", async () => {
		const response = await post({
			message: "Which case studies do we have in logistics?",
			organizationId: ORGANIZATION_ID,
		});

		expect(response.status).toBe(200);
		const { workflowType, input } = started();
		expect(workflowType).toBe("directChatWorkflow");
		expect(input.companyContextAdvisor).toBe(true);
		expect(input).toMatchObject({
			userId: SESSION_USER_ID,
			organizationId: ORGANIZATION_ID,
		});
	});

	// A custom agent picked in the Advisor runs through the same route.
	it("opts in a custom agent's turn too", async () => {
		await post({
			message: "What do we offer?",
			organizationId: ORGANIZATION_ID,
			instanceId: "instance-1",
		});

		const { input } = started();
		expect(input.instanceId).toBe("instance-1");
		expect(input.companyContextAdvisor).toBe(true);
	});
});
