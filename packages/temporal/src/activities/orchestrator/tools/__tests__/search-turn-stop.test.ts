/**
 * Advisor Stop during the tool, agent and integration lookups.
 *
 * Each lookup embeds the query (and sometimes its candidates) and used to
 * catch any embedding failure and carry on without it: a stopped chat turn's
 * refusal (`TurnNotDispatchable`) or cancellation was converted into keyword
 * results, an unscored agent list or an empty integration list, and the turn
 * went on. In a turn (`turnScope`, run inside the turn's dispatch guard the
 * way the worker's interceptor runs it) a stop must leave the activity; with
 * no turn the fallback is unchanged.
 */

import { getDispatchGuard } from "@repo/utils/dispatch-guard";
import { ApplicationFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
	generateEmbedding: vi.fn(),
	generateEmbeddings: vi.fn(),
	toolIndexSearch: vi.fn(),
	mcpConfigFindMany: vi.fn(),
	integrationFindMany: vi.fn(),
	getAgentsWithEmbeddings: vi.fn(),
	checkDispatchable: vi.fn(),
}));

// Explicit mock (no importOriginal): the real @repo/database would keep
// pg.Pool handles alive past vitest exit.
vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: hoisted.checkDispatchable,
	db: {
		mCPConfig: { findMany: hoisted.mcpConfigFindMany },
		workflowIntegration: {
			findFirst: vi.fn().mockResolvedValue(null),
			findMany: hoisted.integrationFindMany,
		},
	},
	canUseWorkflowIntegrations: vi.fn().mockResolvedValue(true),
	workflowIntegrationAccessWhere: () => ({}),
	getAgentsWithEmbeddings: hoisted.getAgentsWithEmbeddings,
	updateAgentEmbedding: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/database/prisma/queries/lib/oauth-app-row", () => ({
	OAUTH_APP_ROW_NAMES: [],
}));

vi.mock("@repo/rag/lib/embedding/generator", () => ({
	generateEmbedding: hoisted.generateEmbedding,
	generateEmbeddings: hoisted.generateEmbeddings,
}));

vi.mock("@repo/rag/lib/vector-store/capability-store", () => ({
	getCapabilitiesByTenant: vi.fn().mockResolvedValue([]),
	searchCapabilities: vi.fn().mockResolvedValue([]),
}));

vi.mock("@repo/ai", () => ({
	getSystemEmbeddingRAGProviderConfig: vi.fn().mockResolvedValue({}),
}));

vi.mock("@repo/agent-core/backend", () => ({
	getMcpClient: vi.fn(),
	closeMcpClientSafe: vi.fn(),
}));

vi.mock("@repo/mcp-registry", () => ({
	GITHUB_ACCOUNT: { version: "1.0.0" },
	MICROSOFT_TEAMS_ACCOUNT: { version: "1.0.0" },
}));

vi.mock("../../../oauth-tool-ingestion", () => ({
	ingestOAuthIntegrationToolsActivity: vi.fn(),
}));

vi.mock("../fabric-ai-tools", () => ({
	getFabricAiTools: vi.fn().mockReturnValue([]),
}));

vi.mock("../tool-index", () => ({
	toolIndex: {
		search: hoisted.toolIndexSearch,
		needsRebuild: vi.fn().mockReturnValue(false),
		loadFromQdrant: vi.fn().mockResolvedValue(true),
		getStats: vi.fn().mockReturnValue({ totalTools: 0, servers: 0 }),
		getServerTools: vi.fn().mockReturnValue([]),
		getAllEntries: vi.fn().mockReturnValue([]),
	},
}));

vi.mock("../../../../lib/redis-cache", () => ({
	CacheKeys: {
		queryEmbedding: () => "query-key",
		agentEmbedding: () => "agent-key",
	},
	CacheTTL: { queryEmbedding: 60, agentEmbedding: 60 },
	RedisCache: {
		get: vi.fn().mockResolvedValue(null),
		set: vi.fn().mockResolvedValue(undefined),
	},
}));

import {
	isTurnNotDispatchable,
	runWithTurnDispatch,
} from "../../turn-dispatch";
import { searchAvailableAgents } from "../search-agents";
import { searchAvailableIntegrations } from "../search-integrations";
import { searchAvailableTools } from "../search-tools";

const TURN_SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-example-1",
	userId: "user-example-1",
	organizationId: "org-example-1",
};

const TENANT = {
	userId: TURN_SCOPE.userId,
	organizationId: TURN_SCOPE.organizationId,
};

function turnStopped() {
	return ApplicationFailure.create({
		type: "TurnNotDispatchable",
		message: "Turn turn-example-1 may not make another model request",
		nonRetryable: true,
		details: [{ reason: "cancelled" }],
	});
}

/** Runs `fn` the way the worker runs a turn-scoped activity. */
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
	return runWithTurnDispatch(TURN_SCOPE, fn);
}

beforeEach(() => {
	vi.clearAllMocks();
	hoisted.mcpConfigFindMany.mockResolvedValue([]);
	hoisted.generateEmbeddings.mockResolvedValue({ embeddings: [] });
	hoisted.toolIndexSearch.mockResolvedValue([]);
});

describe("searchAvailableTools", () => {
	it("rethrows a stop from the semantic server search", async () => {
		const stop = turnStopped();
		hoisted.generateEmbeddings.mockRejectedValue(stop);

		await expect(
			inTurn(() =>
				searchAvailableTools({
					query: "create a ticket",
					...TENANT,
					turnScope: TURN_SCOPE,
				}),
			),
		).rejects.toBe(stop);
	});

	it("rethrows a stop from the semantic tool search instead of falling back to keywords", async () => {
		const stop = turnStopped();
		hoisted.toolIndexSearch
			// The indexed keyword pass finds nothing...
			.mockResolvedValueOnce([])
			// ...and the semantic pass is refused.
			.mockRejectedValueOnce(stop);

		await expect(
			inTurn(() =>
				searchAvailableTools({
					query: "create a ticket",
					...TENANT,
					turnScope: TURN_SCOPE,
				}),
			),
		).rejects.toBe(stop);
		expect(hoisted.toolIndexSearch).toHaveBeenCalledTimes(2);
	});

	it("still falls back to keyword search with no turn", async () => {
		hoisted.toolIndexSearch
			.mockResolvedValueOnce([])
			.mockRejectedValueOnce(turnStopped())
			.mockResolvedValueOnce([]);

		const result = await searchAvailableTools({
			query: "create a ticket",
			...TENANT,
		});

		expect(result.semanticSearchUsed).toBe(false);
		expect(hoisted.toolIndexSearch).toHaveBeenCalledTimes(3);
	});
});

describe("searchAvailableAgents", () => {
	const AGENT = {
		agentId: "agent-1",
		name: "researcher",
		displayName: "Researcher",
		description: "Researches things",
		status: "ACTIVE",
		lastHealthCheck: null,
		metadata: {},
		cachedEmbedding: null,
		cachedEmbeddingModel: null,
	};

	beforeEach(() => {
		hoisted.getAgentsWithEmbeddings.mockResolvedValue([AGENT]);
	});

	it("rethrows a stop from the query embedding", async () => {
		const stop = turnStopped();
		hoisted.generateEmbedding.mockRejectedValue(stop);

		await expect(
			inTurn(() =>
				searchAvailableAgents({
					query: "research the market",
					...TENANT,
					turnScope: TURN_SCOPE,
				}),
			),
		).rejects.toBe(stop);
	});

	it("rethrows a stop from an agent's embedding", async () => {
		const stop = turnStopped();
		hoisted.generateEmbedding
			.mockResolvedValueOnce({ embedding: [0.1, 0.2], model: "m" })
			.mockRejectedValueOnce(stop);

		await expect(
			inTurn(() =>
				searchAvailableAgents({
					query: "research the market",
					...TENANT,
					turnScope: TURN_SCOPE,
				}),
			),
		).rejects.toBe(stop);
	});

	it("aborts a sibling agent embedding in flight and returns only after it settles", async () => {
		// Two uncached agents. The query embedding and agent A's check pass;
		// the Stop is then recorded and agent B's check is refused, while A's
		// request is still in flight.
		hoisted.getAgentsWithEmbeddings.mockResolvedValue([
			{ ...AGENT, agentId: "agent-a" },
			{ ...AGENT, agentId: "agent-b" },
		]);
		hoisted.checkDispatchable
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValue({ ok: false, reason: "cancelled" });
		const events: string[] = [];
		let inFlight: AbortSignal | undefined;
		// Stands in for @repo/rag's generateEmbedding over a factory model:
		// the guard is checked, then the request carries the guard's signal.
		hoisted.generateEmbedding.mockImplementation(async (text: string) => {
			const guard = getDispatchGuard();
			await guard?.assertDispatchable();
			if (text === "research the market") {
				return { embedding: [0.1, 0.2], model: "m" };
			}
			const signal = guard?.abortSignal();
			inFlight = signal;
			return new Promise((_resolve, reject) => {
				// The provider takes a moment to give up the request.
				const giveUp = () =>
					setTimeout(() => {
						events.push("sibling settled");
						reject(new DOMException("aborted", "AbortError"));
					}, 20);
				if (signal?.aborted) {
					giveUp();
				} else {
					signal?.addEventListener("abort", giveUp);
				}
			});
		});

		const error = await inTurn(() =>
			searchAvailableAgents({
				query: "research the market",
				...TENANT,
				turnScope: TURN_SCOPE,
			}),
		).catch((caught: unknown) => {
			events.push("activity settled");
			return caught;
		});

		expect(inFlight?.aborted).toBe(true);
		expect(events).toEqual(["sibling settled", "activity settled"]);
		expect(isTurnNotDispatchable(error)).toBe(true);
	});

	it("still scores without embeddings with no turn", async () => {
		hoisted.generateEmbedding.mockRejectedValue(turnStopped());

		const result = await searchAvailableAgents({
			query: "research the market",
			...TENANT,
		});

		expect(result.totalAgentsSearched).toBe(1);
	});
});

describe("searchAvailableIntegrations", () => {
	beforeEach(() => {
		hoisted.integrationFindMany.mockResolvedValue([
			{
				id: "integration-1",
				name: "Example Jira",
				provider: "JIRA",
				userId: TURN_SCOPE.userId,
				organizationId: TURN_SCOPE.organizationId,
			},
		]);
	});

	it("rethrows a stop from the query embedding", async () => {
		const stop = turnStopped();
		hoisted.generateEmbedding.mockRejectedValue(stop);

		await expect(
			inTurn(() =>
				searchAvailableIntegrations({
					query: "file a jira issue",
					...TENANT,
					turnScope: TURN_SCOPE,
				}),
			),
		).rejects.toBe(stop);
	});

	it("rethrows a stop from the integration embeddings", async () => {
		const stop = turnStopped();
		hoisted.generateEmbedding.mockResolvedValue({ embedding: [0.1, 0.2] });
		hoisted.generateEmbeddings.mockRejectedValue(stop);

		await expect(
			inTurn(() =>
				searchAvailableIntegrations({
					query: "file a jira issue",
					...TENANT,
					turnScope: TURN_SCOPE,
				}),
			),
		).rejects.toBe(stop);
	});

	it("still scores without embeddings with no turn", async () => {
		hoisted.generateEmbedding.mockRejectedValue(turnStopped());

		const result = await searchAvailableIntegrations({
			query: "file a jira issue",
			...TENANT,
		});

		expect(result.totalIntegrationsSearched).toBe(1);
	});
});

describe("the heartbeat ticker of a lookup (searchAvailableAgents)", () => {
	const AGENT = {
		agentId: "agent-1",
		name: "researcher",
		displayName: "Researcher",
		description: "Researches things",
		status: "ACTIVE",
		lastHealthCheck: null,
		metadata: {},
		cachedEmbedding: null,
		cachedEmbeddingModel: null,
	};

	afterEach(() => {
		vi.useRealTimers();
	});

	/** Starts the activity in an activity context, counting heartbeats. */
	function start(withTurn: boolean) {
		const env = new MockActivityEnvironment();
		let beats = 0;
		env.on("heartbeat", () => {
			beats += 1;
		});
		const settled = env
			.run(() =>
				searchAvailableAgents({
					query: "research the market",
					...TENANT,
					...(withTurn ? { turnScope: TURN_SCOPE } : {}),
				}),
			)
			.then(
				() => "resolved",
				() => "rejected",
			);
		return { settled, beats: () => beats };
	}

	/** A query embedding that stays in flight until settled by the test. */
	function pendingEmbedding() {
		let settle: {
			resolve: (v: unknown) => void;
			reject: (e: unknown) => void;
		} = { resolve: () => undefined, reject: () => undefined };
		// The query embedding stays in flight; the agent's embedding that
		// follows a successful query embedding answers at once.
		hoisted.generateEmbedding
			.mockResolvedValue({ embedding: [0.3, 0.4], model: "m" })
			.mockImplementationOnce(
				() =>
					new Promise((resolve, reject) => {
						settle = { resolve, reject };
					}),
			);
		return () => settle;
	}

	beforeEach(() => {
		vi.useFakeTimers();
		hoisted.getAgentsWithEmbeddings.mockResolvedValue([AGENT]);
	});

	it("ticks every 5 seconds in a turn and stops when the activity succeeds", async () => {
		const settle = pendingEmbedding();
		const run = start(true);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(run.beats()).toBe(3);

		settle().resolve({ embedding: [0.1, 0.2], model: "m" });
		await expect(run.settled).resolves.toBe("resolved");
		const atEnd = run.beats();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(run.beats()).toBe(atEnd);
	});

	it("stops when the activity fails", async () => {
		let fail: (error: unknown) => void = () => undefined;
		hoisted.getAgentsWithEmbeddings.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					fail = reject;
				}),
		);
		const run = start(true);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(run.beats()).toBe(2);

		fail(new Error("database unavailable"));
		await expect(run.settled).resolves.toBe("rejected");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(run.beats()).toBe(2);
	});

	it("stops when the turn is stopped", async () => {
		const settle = pendingEmbedding();
		const run = start(true);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(run.beats()).toBe(2);

		settle().reject(turnStopped());
		await expect(run.settled).resolves.toBe("rejected");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(run.beats()).toBe(2);
	});

	it("does not start without a turn", async () => {
		const settle = pendingEmbedding();
		const run = start(false);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(run.beats()).toBe(0);

		settle().resolve({ embedding: [0.1, 0.2], model: "m" });
		await expect(run.settled).resolves.toBe("resolved");
		expect(run.beats()).toBe(0);
	});
});
