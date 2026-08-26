import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updateMock = vi.fn();
vi.mock("@repo/database", () => ({
	updateRegisteredAgentHealthCheck: (...args: unknown[]) =>
		updateMock(...args),
	updateAgentCardCache: vi.fn(),
	updateAgentEmbedding: vi.fn(),
}));

vi.mock("@repo/rag/lib/embedding/generator", () => ({
	generateEmbedding: vi.fn(),
}));

vi.mock("../../lib/redis-cache", () => ({
	RedisCache: { set: vi.fn().mockResolvedValue(undefined) },
	CacheKeys: { agentCard: vi.fn(), agentEmbedding: vi.fn() },
	CacheTTL: { agentCard: 300, agentEmbedding: 600 },
}));

import { checkAgentHealth, formatProbeError } from "../health-probe";

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
		process.env.DOCKER_CONTAINER = "false";
		process.env.DOCUMENT_GENERATOR_URL = "https://doc-gen.prod.svc";
	});
	afterEach(() => {
		vi.unstubAllGlobals();
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
