/**
 * A workflow that soft-fails (Temporal reports COMPLETED, but the
 * workflow's own return value has `status: "failed"`) must surface as an
 * `error` SSE event, not a `completed` one.
 *
 * Without this, the client's `completed` handler renders the run as
 * successful and can display a partial response stub as if it were the
 * real answer — this is exactly how staging execution orch-9294c339 (the
 * dropped-tool-call incident) stayed silent end-to-end: the orchestrator
 * activity correctly returned `stream_error`/a failed workflow result, but
 * this route still forwarded it as `completed`.
 *
 * Mirrors the harness in orchestrator-resume-no-rebill.test.ts (issue
 * #2269) — same mocks, reused for a different assertion.
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

const SESSION_USER_ID = "user-soft-fail-1";
const EXECUTION_ID = "orch-9294c339-2222-4333-8444-555555555555";

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

describe("POST orchestrator-temporal/stream — soft-failed workflow result", () => {
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

	it("emits `error` (not `completed`) when Temporal COMPLETED but the workflow result carries status: failed", async () => {
		getHandleMock.mockReturnValue({
			workflowId: EXECUTION_ID,
			describe: async () => ({
				status: { name: "COMPLETED" },
				memo: { userId: SESSION_USER_ID },
			}),
			query: async () => {
				throw new Error("workflow closed");
			},
			result: async () => ({
				status: "failed",
				error: "provider signalled finishReason=tool-calls but streamed no tool-call parts (text: 15 chars)",
				response: "Let me check", // the partial stub that must NOT render as success
				toolCalls: [],
				totalDurationMs: 1,
			}),
		});

		const { POST } = await import(
			"../../app/api/agents/fabric-ai/orchestrator-temporal/stream/route"
		);
		const response = await POST(postBody({ executionId: EXECUTION_ID }));
		const events = await readEvents(response);

		const errorEvent = events.find((e) => e.type === "error");
		expect(errorEvent).toMatchObject({
			type: "error",
			message:
				"provider signalled finishReason=tool-calls but streamed no tool-call parts (text: 15 chars)",
		});
		// The partial-stub response must never reach the client as a
		// successful completion.
		expect(events.find((e) => e.type === "completed")).toBeUndefined();
	});

	it("falls back to a generic message when the failed result carries no `error` string", async () => {
		getHandleMock.mockReturnValue({
			workflowId: EXECUTION_ID,
			describe: async () => ({
				status: { name: "COMPLETED" },
				memo: { userId: SESSION_USER_ID },
			}),
			query: async () => {
				throw new Error("workflow closed");
			},
			result: async () => ({
				status: "failed",
				toolCalls: [],
				totalDurationMs: 1,
			}),
		});

		const { POST } = await import(
			"../../app/api/agents/fabric-ai/orchestrator-temporal/stream/route"
		);
		const response = await POST(postBody({ executionId: EXECUTION_ID }));
		const events = await readEvents(response);

		expect(events.find((e) => e.type === "error")).toMatchObject({
			type: "error",
			message: "Workflow execution failed",
		});
		expect(events.find((e) => e.type === "completed")).toBeUndefined();
	});

	it("still emits `completed` for a cancelled-status result (unaffected by the failed-status branch)", async () => {
		getHandleMock.mockReturnValue({
			workflowId: EXECUTION_ID,
			describe: async () => ({
				status: { name: "COMPLETED" },
				memo: { userId: SESSION_USER_ID },
			}),
			query: async () => {
				throw new Error("workflow closed");
			},
			result: async () => ({
				status: "cancelled",
				response: "",
				toolCalls: [],
				totalDurationMs: 1,
			}),
		});

		const { POST } = await import(
			"../../app/api/agents/fabric-ai/orchestrator-temporal/stream/route"
		);
		const response = await POST(postBody({ executionId: EXECUTION_ID }));
		const events = await readEvents(response);

		expect(events.find((e) => e.type === "completed")).toMatchObject({
			type: "completed",
			status: "cancelled",
		});
		expect(events.find((e) => e.type === "error")).toBeUndefined();
	});
});
