/**
 * The AI Assistant's orchestrator run must carry an absolute wall-clock ceiling.
 *
 * Every activity in that workflow bounds itself (`startToCloseTimeout` +
 * `heartbeatTimeout`) and every human-in-the-loop `condition()` wait is bounded,
 * so no single step can hang. The RUN as a whole had no ceiling: this starter
 * was the only caller of `orchestratorExecutionWorkflow` that omitted
 * `workflowExecutionTimeout` — the weave starter passes one, and the sibling
 * document-refresh workflow uses an hour for the same reason. A wedged run
 * therefore stayed RUNNING with nothing to reclaim it, which is the "the worker
 * just keeps spinning" report.
 *
 * Harness mirrors orchestrator-soft-fail.test.ts — same mocks, different
 * assertion.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();
const getAIModelWithMetadataMock = vi.fn();
const trackUsageMock = vi.fn();
const getTemporalClientMock = vi.fn();
const getHandleMock = vi.fn();
const startWorkflowMock = vi.fn();

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
	// The route only uses this for an `instanceof` check on the chokepoint's
	// throw, which never happens here.
	AiUsageLimitExceededError: class AiUsageLimitExceededError extends Error {},
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: () => getTemporalClientMock(),
}));

vi.mock("@repo/database", () => ({
	CARRIED_OVER_MARKER_PREFIX: "[carried-over]",
	db: {
		agentConversation: { findFirst: vi.fn(async () => null) },
		member: { findFirst: vi.fn(async () => ({ id: "member-1" })) },
		aiChat: { findFirst: vi.fn(async () => null) },
	},
	getConversationWorkspaces: vi.fn(async () => []),
	getConversationProject: vi.fn(async () => null),
	hasProjectAccess: vi.fn(async () => true),
}));

const SESSION_USER_ID = "user-exec-timeout-1";

function postBody(b: Record<string, unknown>) {
	return { json: async () => b } as never;
}

describe("POST orchestrator-temporal/stream — run has an absolute ceiling", () => {
	const originalCacheHost = process.env.CACHE_HOST;
	const originalRedisUrl = process.env.REDIS_URL;

	beforeEach(() => {
		vi.clearAllMocks();
		// Keep `getRedisUrl()` at null so the route never reaches for ioredis.
		delete process.env.CACHE_HOST;
		delete process.env.REDIS_URL;

		getSessionMock.mockResolvedValue({ user: { id: SESSION_USER_ID } });
		getAIModelWithMetadataMock.mockResolvedValue({
			trackUsage: trackUsageMock,
		});
		startWorkflowMock.mockResolvedValue({
			workflowId: "wf-exec-timeout",
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

	it("passes workflowExecutionTimeout so a wedged run cannot stay RUNNING forever", async () => {
		const { POST } = await import(
			"../../app/api/agents/fabric-ai/orchestrator-temporal/stream/route"
		);
		const response = await POST(postBody({ message: "hello" }));
		await response.text();

		expect(startWorkflowMock).toHaveBeenCalled();
		const options = startWorkflowMock.mock.calls[0]?.[1] as {
			workflowExecutionTimeout?: string;
			taskQueue?: string;
		};
		expect(options.taskQueue).toBe("fabric-orchestrator");
		// The weave starter of this same workflow already passes one; this
		// starter was the only one that did not.
		expect(options.workflowExecutionTimeout).toBeTruthy();
	});
});
