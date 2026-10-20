/**
 * The stream's `: ping` keeps its own clock. The chat treats a stream that
 * sends nothing for three pings as a dead connection and reconnects (and gives
 * up after a few), so a poll waiting on a slow Temporal call — a worker
 * restarting — must not stop the pings of a healthy run.
 *
 * Mirrors the harness in orchestrator-soft-fail.test.ts.
 */

import type {
	OrchestratorProgressUpdate,
	RoutingDecision,
} from "@repo/temporal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();
const getAIModelWithMetadataMock = vi.fn();
const getTemporalClientMock = vi.fn();
const getHandleMock = vi.fn();

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
	...(
		await import("./_helpers/conversation-turn-db-mocks")
	).conversationTurnDbMocks(),
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

const SESSION_USER_ID = "user-heartbeat-1";
const EXECUTION_ID = "orch-12345678-2222-4333-8444-555555555555";

describe("POST orchestrator-temporal/stream — progress polling and heartbeat", () => {
	const originalCacheHost = process.env.CACHE_HOST;
	const originalRedisUrl = process.env.REDIS_URL;

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.CACHE_HOST;
		delete process.env.REDIS_URL;
		getSessionMock.mockResolvedValue({
			user: { id: SESSION_USER_ID },
			session: { activeOrganizationId: "org-example-1" },
		});
		getAIModelWithMetadataMock.mockResolvedValue({ trackUsage: vi.fn() });
		getTemporalClientMock.mockResolvedValue({
			workflow: { getHandle: getHandleMock, start: vi.fn() },
		});
	});

	afterEach(() => {
		vi.useRealTimers();
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

	it.each([false, true])(
		"streams progress without unsupported queries when routing metadata is present: %s",
		async (includeRouting) => {
			const routingDecision: RoutingDecision = {
				primaryAgent: "example-agent",
				secondaryAgents: [],
				confidence: 0.9,
				reasoning: "Matches the requested read",
				riskLevel: "low",
				riskFactors: [],
				suggestedStrategy: "agent",
			};
			const progress: OrchestratorProgressUpdate = {
				executionId: EXECUTION_ID,
				phase: "planning",
				completedSteps: 0,
				totalSteps: 1,
				message: "Preparing the task",
				timestamp: "2026-01-01T00:00:00.000Z",
				...(includeRouting ? { routingDecision } : {}),
			};
			const query = vi.fn(async (name: string) => {
				if (name === "progress") {
					return progress;
				}
				if (
					[
						"plan",
						"pendingApproval",
						"pendingClarification",
					].includes(name)
				) {
					return null;
				}
				throw new Error(`Unsupported query: ${name}`);
			});
			let describeCalls = 0;
			getHandleMock.mockReturnValue({
				workflowId: EXECUTION_ID,
				describe: async () => ({
					status: {
						name: ++describeCalls < 3 ? "RUNNING" : "COMPLETED",
					},
					memo: { userId: SESSION_USER_ID },
				}),
				query,
				result: async () => ({
					status: "completed",
					response: "Done",
					toolCalls: [],
				}),
			});
			const { POST } = await import(
				"../../app/api/agents/fabric-ai/orchestrator-temporal/stream/route"
			);
			const response = await POST({
				json: async () => ({ executionId: EXECUTION_ID }),
			} as never);
			const events = (await response.text())
				.split("\n")
				.filter((line) => line.startsWith("data: "))
				.map((line) => JSON.parse(line.slice(6)));
			expect(events).toContainEqual(
				expect.objectContaining({ type: "progress" }),
			);
			expect(events).toContainEqual(
				expect.objectContaining({ type: "completed" }),
			);
			const routingEvents = events.filter(
				(event) => event.type === "routing",
			);
			expect(routingEvents).toHaveLength(includeRouting ? 1 : 0);
			if (includeRouting) {
				expect(routingEvents[0]).toMatchObject({
					primaryAgent: "example-agent",
					confidence: 0.9,
					riskLevel: "low",
				});
			}
			expect(query.mock.calls.map(([name]) => name)).toEqual([
				"progress",
				"plan",
				"pendingApproval",
				"pendingClarification",
				"progress",
			]);
		},
	);

	it("keeps pinging while a poll waits on a Temporal call that does not answer", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		let describeCalls = 0;
		let pollStarted: () => void = () => {};
		const polling = new Promise<void>((resolve) => {
			pollStarted = resolve;
		});
		getHandleMock.mockReturnValue({
			workflowId: EXECUTION_ID,
			describe: () => {
				describeCalls += 1;
				if (describeCalls === 1) {
					return Promise.resolve({
						status: { name: "RUNNING" },
						memo: { userId: SESSION_USER_ID },
					});
				}
				pollStarted();
				return new Promise(() => {});
			},
			query: async () => null,
			result: async () => ({}),
		});

		const { POST } = await import(
			"../../app/api/agents/fabric-ai/orchestrator-temporal/stream/route"
		);
		const response = await POST({
			json: async () => ({ executionId: EXECUTION_ID }),
		} as never);
		const reader = (
			response.body as ReadableStream<Uint8Array>
		).getReader();
		const decoder = new TextDecoder();
		await polling;

		let received = "";
		for (let tick = 0; tick < 3; tick++) {
			await vi.advanceTimersByTimeAsync(15_000);
			while (received.split(": ping").length - 1 <= tick) {
				const { value, done } = await reader.read();
				if (done) {
					break;
				}
				received += decoder.decode(value, { stream: true });
			}
		}

		expect(received.split(": ping").length - 1).toBe(3);
		expect(describeCalls).toBe(2);
		await reader.cancel();
	});
});
