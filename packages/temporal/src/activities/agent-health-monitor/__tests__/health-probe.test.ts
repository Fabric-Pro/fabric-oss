import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	updateMock,
	updateAgentCardCacheMock,
	updateAgentEmbeddingMock,
	getRegisteredAgentByAgentIdMock,
	touchAgentCardCacheMock,
} = vi.hoisted(() => ({
	updateMock: vi.fn(),
	updateAgentCardCacheMock: vi.fn(),
	updateAgentEmbeddingMock: vi.fn(),
	getRegisteredAgentByAgentIdMock: vi.fn(),
	touchAgentCardCacheMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	updateRegisteredAgentHealthCheck: (...args: unknown[]) =>
		updateMock(...args),
	updateAgentCardCache: (...args: unknown[]) =>
		updateAgentCardCacheMock(...args),
	updateAgentEmbedding: (...args: unknown[]) =>
		updateAgentEmbeddingMock(...args),
	getRegisteredAgentByAgentId: (...args: unknown[]) =>
		getRegisteredAgentByAgentIdMock(...args),
	touchAgentCardCache: (...args: unknown[]) =>
		touchAgentCardCacheMock(...args),
}));

const generateEmbeddingMock = vi.fn();
vi.mock("@repo/rag/lib/embedding/generator", () => ({
	generateEmbedding: (...args: unknown[]) => generateEmbeddingMock(...args),
}));

const redisSetMock = vi.fn().mockResolvedValue(undefined);
// NOTE: three levels up — this file lives in __tests__/, one directory
// deeper than health-probe.ts itself, so the mock specifier must resolve
// to the same absolute path health-probe.ts's own "../../lib/redis-cache"
// import resolves to.
vi.mock("../../../lib/redis-cache", () => ({
	RedisCache: { set: (...args: unknown[]) => redisSetMock(...args) },
	CacheKeys: {
		agentCard: (agentId: string) => `agentcard:${agentId}`,
		agentEmbedding: (agentId: string, model?: string) =>
			`embed:agent:${agentId}:${model ?? ""}`,
	},
	CacheTTL: { agentCard: 1800, agentEmbedding: 1800 },
}));

import {
	AGENT_CARD_REFRESH_TTL_MS,
	AGENT_EMBEDDING_REFRESH_TTL_MS,
	checkAgentHealth,
	formatProbeError,
} from "../health-probe";

function fetchSwitch(handlers: {
	health?: () => unknown;
	card?: () => unknown;
}) {
	return vi.fn().mockImplementation((url: string) => {
		if (url.endsWith("/health")) {
			return Promise.resolve(
				(handlers.health ?? (() => ({ ok: true, status: 200 })))(),
			);
		}
		if (url.endsWith("/.well-known/agent.json")) {
			return Promise.resolve(
				(
					handlers.card ??
					(() => ({ ok: true, status: 200, json: async () => ({}) }))
				)(),
			);
		}
		return Promise.reject(new Error(`unexpected fetch url: ${url}`));
	});
}

describe("formatProbeError", () => {
	it("includes the resolved URL and the cause", () => {
		expect(
			formatProbeError("http://localhost:8124", "connection refused"),
		).toBe("connection refused probing http://localhost:8124/health");
	});
});

describe("checkAgentHealth", () => {
	beforeEach(() => {
		updateMock.mockReset();
		updateAgentCardCacheMock.mockReset();
		updateAgentEmbeddingMock.mockReset();
		getRegisteredAgentByAgentIdMock.mockReset();
		touchAgentCardCacheMock.mockReset();
		generateEmbeddingMock.mockReset();
		redisSetMock.mockClear();
		getRegisteredAgentByAgentIdMock.mockResolvedValue({ metadata: {} });
		process.env.DOCKER_CONTAINER = "false";
		process.env.DOCUMENT_GENERATOR_URL = "https://doc-gen.prod.svc";
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
		delete process.env.DOCUMENT_GENERATOR_URL;
		delete process.env.DOCKER_CONTAINER;
	});

	it("probes the RESOLVED url and records the failure reason", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
		vi.stubGlobal("fetch", fetchMock);

		const result = await checkAgentHealth({
			agentId: "document_generator",
			deploymentUrl: "http://localhost:8124", // stale DB url
		});

		expect(fetchMock.mock.calls[0][0]).toBe(
			"https://doc-gen.prod.svc/health",
		);
		expect(result.healthy).toBe(false);
		expect(updateMock).toHaveBeenCalledWith(
			"document_generator",
			false,
			expect.stringContaining("https://doc-gen.prod.svc/health"),
		);
	});

	it("records timeout reason and resolved url when fetch AbortErrors", async () => {
		const e = new Error("aborted");
		e.name = "AbortError";
		const fetchMock = vi.fn().mockRejectedValue(e);
		vi.stubGlobal("fetch", fetchMock);

		const result = await checkAgentHealth({
			agentId: "document_generator",
			deploymentUrl: "http://localhost:8124",
		});

		expect(result.healthy).toBe(false);
		expect(updateMock).toHaveBeenCalledWith(
			"document_generator",
			false,
			expect.stringContaining("timeout after 5000ms"),
		);
		expect(updateMock.mock.calls[0][2]).toContain(
			"https://doc-gen.prod.svc/health",
		);
	});

	it("records the error message when fetch rejects with a network error", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
		vi.stubGlobal("fetch", fetchMock);

		const result = await checkAgentHealth({
			agentId: "document_generator",
			deploymentUrl: "http://localhost:8124",
		});

		expect(result.healthy).toBe(false);
		expect(updateMock).toHaveBeenCalledWith(
			"document_generator",
			false,
			expect.stringContaining("ECONNREFUSED"),
		);
	});
});

describe("checkAgentHealth card + embedding refresh", () => {
	const NOW = new Date("2026-09-08T12:00:00.000Z").getTime();

	beforeEach(() => {
		updateMock.mockReset();
		updateAgentCardCacheMock.mockReset();
		updateAgentEmbeddingMock.mockReset();
		getRegisteredAgentByAgentIdMock.mockReset();
		touchAgentCardCacheMock.mockReset();
		generateEmbeddingMock.mockReset();
		redisSetMock.mockClear();
		process.env.DOCKER_CONTAINER = "false";
		process.env.DOCUMENT_GENERATOR_URL = "https://doc-gen.prod.svc";
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
		delete process.env.DOCUMENT_GENERATOR_URL;
		delete process.env.DOCKER_CONTAINER;
	});

	it("skips the card fetch when the stored card is within the refresh TTL", async () => {
		const cachedAt = new Date(NOW - 10 * 60_000).toISOString(); // 10 min old
		getRegisteredAgentByAgentIdMock.mockResolvedValue({
			metadata: {
				agentCard: { name: "Stored" },
				agentCardCachedAt: cachedAt,
			},
		});
		const fetchMock = fetchSwitch({});
		vi.stubGlobal("fetch", fetchMock);

		await checkAgentHealth({
			agentId: "agent-1",
			deploymentUrl: "http://localhost:8124",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:8124/health");
		expect(updateAgentCardCacheMock).not.toHaveBeenCalled();
		expect(touchAgentCardCacheMock).not.toHaveBeenCalled();
		expect(
			redisSetMock.mock.calls.some((call) =>
				String(call[0]).startsWith("agentcard:"),
			),
		).toBe(false);
	});

	it("touches the freshness stamp when the stale card is byte-identical modulo key order", async () => {
		const cachedAt = new Date(NOW - 31 * 60_000).toISOString(); // 31 min old, past TTL
		const storedCard = { a: 1, b: { x: 1, y: 2 } };
		const liveCard = { b: { y: 2, x: 1 }, a: 1 }; // same content, different key order
		getRegisteredAgentByAgentIdMock.mockResolvedValue({
			metadata: { agentCard: storedCard, agentCardCachedAt: cachedAt },
		});
		const fetchMock = fetchSwitch({
			card: () => ({ ok: true, status: 200, json: async () => liveCard }),
		});
		vi.stubGlobal("fetch", fetchMock);

		await checkAgentHealth({
			agentId: "agent-1",
			deploymentUrl: "http://localhost:8124",
		});

		expect(touchAgentCardCacheMock).toHaveBeenCalledTimes(1);
		expect(touchAgentCardCacheMock.mock.calls[0][0]).toBe("agent-1");
		expect(updateAgentCardCacheMock).not.toHaveBeenCalled();
		expect(
			redisSetMock.mock.calls.some((call) =>
				String(call[0]).startsWith("agentcard:"),
			),
		).toBe(true);
	});

	it("writes the new card when the stale card differs from the stored one", async () => {
		const cachedAt = new Date(NOW - 31 * 60_000).toISOString();
		const storedCard = { name: "Old" };
		const liveCard = { name: "New" };
		getRegisteredAgentByAgentIdMock.mockResolvedValue({
			metadata: { agentCard: storedCard, agentCardCachedAt: cachedAt },
		});
		const fetchMock = fetchSwitch({
			card: () => ({ ok: true, status: 200, json: async () => liveCard }),
		});
		vi.stubGlobal("fetch", fetchMock);

		await checkAgentHealth({
			agentId: "agent-1",
			deploymentUrl: "http://localhost:8124",
		});

		expect(updateAgentCardCacheMock).toHaveBeenCalledTimes(1);
		expect(updateAgentCardCacheMock.mock.calls[0][0]).toBe("agent-1");
		expect(updateAgentCardCacheMock.mock.calls[0][1]).toEqual(liveCard);
		expect(touchAgentCardCacheMock).not.toHaveBeenCalled();
		expect(
			redisSetMock.mock.calls.some((call) =>
				String(call[0]).startsWith("agentcard:"),
			),
		).toBe(true);
	});

	it("fetches and writes the card when nothing is stored at all", async () => {
		getRegisteredAgentByAgentIdMock.mockResolvedValue(null);
		const liveCard = { name: "Fresh" };
		const fetchMock = fetchSwitch({
			card: () => ({ ok: true, status: 200, json: async () => liveCard }),
		});
		vi.stubGlobal("fetch", fetchMock);

		await checkAgentHealth({
			agentId: "agent-1",
			deploymentUrl: "http://localhost:8124",
		});

		expect(updateAgentCardCacheMock).toHaveBeenCalledTimes(1);
		expect(updateAgentCardCacheMock.mock.calls[0][1]).toEqual(liveCard);
	});

	it("fetches the card and touches the stamp when the cached timestamp is in the future", async () => {
		// A stored timestamp in the future (clock skew or a hand-edited row)
		// must not be treated as fresh — the card is fetched, and since it is
		// identical to what's stored, touchAgentCardCache advances the stamp.
		const cachedAt = new Date(NOW + 10 * 60_000).toISOString(); // 10 min in the future
		const storedCard = { name: "Stored" };
		getRegisteredAgentByAgentIdMock.mockResolvedValue({
			metadata: { agentCard: storedCard, agentCardCachedAt: cachedAt },
		});
		const fetchMock = fetchSwitch({
			card: () => ({
				ok: true,
				status: 200,
				json: async () => storedCard,
			}),
		});
		vi.stubGlobal("fetch", fetchMock);

		await checkAgentHealth({
			agentId: "agent-1",
			deploymentUrl: "http://localhost:8124",
		});

		expect(
			fetchMock.mock.calls.some((call) =>
				String(call[0]).endsWith("/.well-known/agent.json"),
			),
		).toBe(true);
		expect(touchAgentCardCacheMock).toHaveBeenCalledTimes(1);
		expect(updateAgentCardCacheMock).not.toHaveBeenCalled();
	});

	it("fetches and writes the card when the stored timestamp is fresh but no card is stored", async () => {
		const cachedAt = new Date(NOW - 10 * 60_000).toISOString(); // 10 min old, within TTL
		const liveCard = { name: "Fresh" };
		getRegisteredAgentByAgentIdMock.mockResolvedValue({
			metadata: { agentCardCachedAt: cachedAt }, // no agentCard key
		});
		const fetchMock = fetchSwitch({
			card: () => ({ ok: true, status: 200, json: async () => liveCard }),
		});
		vi.stubGlobal("fetch", fetchMock);

		await checkAgentHealth({
			agentId: "agent-1",
			deploymentUrl: "http://localhost:8124",
		});

		expect(updateAgentCardCacheMock).toHaveBeenCalledTimes(1);
		expect(updateAgentCardCacheMock.mock.calls[0][1]).toEqual(liveCard);
	});

	it("regenerates the embedding when the stored generatedAt is in the future", async () => {
		const searchText = "Agent One: does things.";
		const hash = createHash("sha256").update(searchText).digest("hex");
		const generatedAt = new Date(NOW + 60 * 60_000).toISOString(); // 1 hour in the future
		getRegisteredAgentByAgentIdMock.mockResolvedValue({
			metadata: {
				descriptionEmbedding: [0.1],
				embeddingSourceHash: hash,
				embeddingGeneratedAt: generatedAt,
			},
		});
		generateEmbeddingMock.mockResolvedValue({
			embedding: [0.2],
			model: "openai/text-embedding-3-small",
		});
		const fetchMock = fetchSwitch({
			card: () => ({ ok: true, status: 200, json: async () => ({}) }),
		});
		vi.stubGlobal("fetch", fetchMock);

		await checkAgentHealth({
			agentId: "agent-1",
			deploymentUrl: "http://localhost:8124",
			userId: "user-1",
			agentSearchText: searchText,
		});

		expect(generateEmbeddingMock).toHaveBeenCalledTimes(1);
		expect(updateAgentEmbeddingMock).toHaveBeenCalledTimes(1);
	});

	it("regenerates the embedding when the hash matches but no embedding is stored", async () => {
		const searchText = "Agent One: does things.";
		const hash = createHash("sha256").update(searchText).digest("hex");
		const generatedAt = new Date(NOW - 60 * 60_000).toISOString(); // 1 hour old, within TTL
		getRegisteredAgentByAgentIdMock.mockResolvedValue({
			metadata: {
				embeddingSourceHash: hash,
				embeddingGeneratedAt: generatedAt,
				// no descriptionEmbedding key
			},
		});
		generateEmbeddingMock.mockResolvedValue({
			embedding: [0.2],
			model: "openai/text-embedding-3-small",
		});
		const fetchMock = fetchSwitch({
			card: () => ({ ok: true, status: 200, json: async () => ({}) }),
		});
		vi.stubGlobal("fetch", fetchMock);

		await checkAgentHealth({
			agentId: "agent-1",
			deploymentUrl: "http://localhost:8124",
			userId: "user-1",
			agentSearchText: searchText,
		});

		expect(generateEmbeddingMock).toHaveBeenCalledTimes(1);
		expect(updateAgentEmbeddingMock).toHaveBeenCalledTimes(1);
	});

	it("fails open to a refresh when reading the stored row rejects", async () => {
		getRegisteredAgentByAgentIdMock.mockRejectedValue(new Error("db down"));
		const liveCard = { name: "Fresh" };
		const fetchMock = fetchSwitch({
			card: () => ({ ok: true, status: 200, json: async () => liveCard }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await checkAgentHealth({
			agentId: "agent-1",
			deploymentUrl: "http://localhost:8124",
		});

		expect(result.healthy).toBe(true);
		expect(updateAgentCardCacheMock).toHaveBeenCalledTimes(1);
		expect(updateAgentCardCacheMock.mock.calls[0][1]).toEqual(liveCard);
	});

	it("skips regeneration when the embedding hash matches and is within the TTL", async () => {
		const searchText = "Agent One: does things. Skills: a, b. Tags: x";
		const hash = createHash("sha256").update(searchText).digest("hex");
		const generatedAt = new Date(NOW - 60 * 60_000).toISOString(); // 1 hour old
		getRegisteredAgentByAgentIdMock.mockResolvedValue({
			metadata: {
				descriptionEmbedding: [0.1, 0.2],
				embeddingSourceHash: hash,
				embeddingGeneratedAt: generatedAt,
			},
		});
		const fetchMock = fetchSwitch({
			card: () => ({ ok: true, status: 200, json: async () => ({}) }),
		});
		vi.stubGlobal("fetch", fetchMock);

		await checkAgentHealth({
			agentId: "agent-1",
			deploymentUrl: "http://localhost:8124",
			userId: "user-1",
			agentSearchText: searchText,
		});

		expect(generateEmbeddingMock).not.toHaveBeenCalled();
		expect(updateAgentEmbeddingMock).not.toHaveBeenCalled();
	});

	it("regenerates when the hash matches but the stored embedding is past the 24h TTL", async () => {
		const searchText = "Agent One: does things.";
		const hash = createHash("sha256").update(searchText).digest("hex");
		const generatedAt = new Date(NOW - 25 * 60 * 60_000).toISOString(); // 25 hours old
		getRegisteredAgentByAgentIdMock.mockResolvedValue({
			metadata: {
				embeddingSourceHash: hash,
				embeddingGeneratedAt: generatedAt,
			},
		});
		generateEmbeddingMock.mockResolvedValue({
			embedding: [0.1, 0.2],
			model: "openai/text-embedding-3-small",
		});
		const fetchMock = fetchSwitch({
			card: () => ({ ok: true, status: 200, json: async () => ({}) }),
		});
		vi.stubGlobal("fetch", fetchMock);

		await checkAgentHealth({
			agentId: "agent-1",
			deploymentUrl: "http://localhost:8124",
			userId: "user-1",
			agentSearchText: searchText,
		});

		expect(generateEmbeddingMock).toHaveBeenCalledTimes(1);
		expect(updateAgentEmbeddingMock).toHaveBeenCalledTimes(1);
		expect(updateAgentEmbeddingMock.mock.calls[0]).toEqual([
			"agent-1",
			[0.1, 0.2],
			expect.any(Date),
			"openai/text-embedding-3-small",
			hash,
		]);
	});

	it("regenerates when the search text hash differs from the stored one", async () => {
		const searchText = "Agent One: new description.";
		const newHash = createHash("sha256").update(searchText).digest("hex");
		getRegisteredAgentByAgentIdMock.mockResolvedValue({
			metadata: {
				embeddingSourceHash: "stale-hash-from-old-text",
				embeddingGeneratedAt: new Date(NOW - 60_000).toISOString(),
			},
		});
		generateEmbeddingMock.mockResolvedValue({
			embedding: [0.3],
			model: "openai/text-embedding-3-small",
		});
		const fetchMock = fetchSwitch({
			card: () => ({ ok: true, status: 200, json: async () => ({}) }),
		});
		vi.stubGlobal("fetch", fetchMock);

		await checkAgentHealth({
			agentId: "agent-1",
			deploymentUrl: "http://localhost:8124",
			userId: "user-1",
			agentSearchText: searchText,
		});

		expect(generateEmbeddingMock).toHaveBeenCalledTimes(1);
		expect(updateAgentEmbeddingMock.mock.calls[0][4]).toBe(newHash);
	});

	it("does nothing beyond the health-check write when the probe is unhealthy", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
		vi.stubGlobal("fetch", fetchMock);

		const result = await checkAgentHealth({
			agentId: "agent-1",
			deploymentUrl: "http://localhost:8124",
			userId: "user-1",
			agentSearchText: "some text",
		});

		expect(result.healthy).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(getRegisteredAgentByAgentIdMock).not.toHaveBeenCalled();
		expect(updateAgentCardCacheMock).not.toHaveBeenCalled();
		expect(touchAgentCardCacheMock).not.toHaveBeenCalled();
		expect(generateEmbeddingMock).not.toHaveBeenCalled();
		expect(updateAgentEmbeddingMock).not.toHaveBeenCalled();
	});
});

// Guard against the TTL constants silently drifting apart from the values
// this suite's timing assumptions (10 min fresh / 31 min stale, 1h fresh /
// 25h stale) are built on. The first case pins AGENT_CARD_REFRESH_TTL_MS to
// the REAL production CacheTTL.agentCard (bypassing the module mock above
// via importActual) so a change to the production constant itself — not just
// to this file's mocked value — is caught.
describe("refresh TTL constants", () => {
	it("agent card TTL matches the production CacheTTL.agentCard constant", async () => {
		const actual = await vi.importActual<
			typeof import("../../../lib/redis-cache")
		>("../../../lib/redis-cache");
		expect(actual.CacheTTL.agentCard).toBe(1800);
		expect(AGENT_CARD_REFRESH_TTL_MS).toBe(
			actual.CacheTTL.agentCard * 1000,
		);
	});

	it("agent embedding TTL is 24 hours", () => {
		expect(AGENT_EMBEDDING_REFRESH_TTL_MS).toBe(24 * 60 * 60_000);
	});
});
