/**
 * A reconnect to a running orchestrator workflow must not be billed again
 * (issue #2269).
 *
 * The resumable-stream protocol lets the client POST back a bare
 * `executionId` to re-attach to a Temporal workflow whose previous HTTP
 * window hit the Vercel function budget. That request runs the same route as
 * a fresh turn, so without a guard it would re-enter the AI usage chokepoint
 * (`getAIModelWithMetadata`) and fire `trackUsage()` once per reconnect —
 * charging a single run up to six times, and worse, letting the chokepoint
 * 429 a reconnect over a limit that run itself pushed past, leaving a live
 * workflow no client can attach to.
 *
 * This is the guard most likely to rot silently: nothing in the happy path
 * notices when a resume starts billing again.
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

const SESSION_USER_ID = "user-resume-1";
const EXECUTION_ID = "orch-11111111-2222-4333-8444-555555555555";

/** Drains an SSE response body and returns the parsed `data:` events. */
async function readEvents(response: Response) {
	const text = await response.text();
	return text
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => JSON.parse(line.slice(6)) as { type: string });
}

function postBody(body: Record<string, unknown>) {
	return {
		json: async () => body,
	} as never;
}

describe("POST orchestrator-temporal/stream — resume does not re-bill", () => {
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

		getHandleMock.mockReturnValue({
			workflowId: EXECUTION_ID,
			describe: async () => ({
				status: { name: "COMPLETED" },
				memo: { userId: SESSION_USER_ID },
			}),
			// The route queries progress for per-step results and tolerates a
			// rejection (a workflow that ended too quickly to answer).
			query: async () => {
				throw new Error("workflow closed");
			},
			result: async () => ({
				status: "completed",
				response: "already finished",
				toolCalls: [],
				totalDurationMs: 1,
			}),
		});
		startWorkflowMock.mockResolvedValue({
			workflowId: EXECUTION_ID,
			describe: async () => ({
				status: { name: "COMPLETED" },
				memo: { userId: SESSION_USER_ID },
			}),
			query: async () => {
				throw new Error("workflow closed");
			},
			result: async () => ({
				status: "completed",
				response: "fresh run",
				toolCalls: [],
				totalDurationMs: 1,
			}),
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

	it("skips the usage chokepoint and usage tracking for an executionId-only body", async () => {
		const { POST } = await import(
			"../../app/api/agents/fabric-ai/orchestrator-temporal/stream/route"
		);

		const response = await POST(postBody({ executionId: EXECUTION_ID }));
		const events = await readEvents(response);

		// The resume really did attach and run to completion — otherwise the
		// assertions below would pass for the wrong reason.
		expect(getHandleMock).toHaveBeenCalledWith(EXECUTION_ID);
		expect(startWorkflowMock).not.toHaveBeenCalled();
		expect(events.map((e) => e.type)).toContain("started");
		expect(events.map((e) => e.type)).toContain("completed");
		expect(events.find((e) => e.type === "started")).toMatchObject({
			resumed: true,
		});

		// The billing chokepoint was never entered, so nothing was counted.
		expect(getAIModelWithMetadataMock).not.toHaveBeenCalled();
		expect(trackUsageMock).not.toHaveBeenCalled();
	});

	it("still enters the usage chokepoint for a message-carrying body", async () => {
		const { POST } = await import(
			"../../app/api/agents/fabric-ai/orchestrator-temporal/stream/route"
		);

		const response = await POST(postBody({ message: "do the thing" }));
		await readEvents(response);

		// Guards the other direction: the `!executionId` condition must not
		// grow into something that skips billing for real turns too.
		expect(getAIModelWithMetadataMock).toHaveBeenCalledTimes(1);
		expect(trackUsageMock).toHaveBeenCalledTimes(1);
		expect(startWorkflowMock).toHaveBeenCalledTimes(1);
	});
});
