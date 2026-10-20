import { afterEach, describe, expect, it, vi } from "vitest";
import { LettaClient } from "../../letta/src/client";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
const options = {
	baseUrl: "https://memory.example.com",
	apiKey: "synthetic-key",
};
const metadata = { type: "orchestrator-memory", organizationId: "org-a" };
const page = (count: number, prefix: string) =>
	Array.from({ length: count }, (_, index) => ({
		id: `${prefix}-${index}`,
		metadata: { ...metadata, organizationId: "org-b" },
	}));

describe("Letta metadata lookup", () => {
	it("pages beyond the first hundred and rejects other tenants", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json(page(100, "first")))
			.mockResolvedValueOnce(Response.json([{ id: "match", metadata }]));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			new LettaClient(options).findAgentByMetadata(metadata),
		).resolves.toMatchObject({ id: "match" });
		expect(fetchMock.mock.calls[1]?.[0]).toContain("after=first-99");
	});

	it("fails closed on a repeated cursor instead of returning not-found", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(page(100, "same"))),
		);
		await expect(
			new LettaClient(options).findAgentByMetadata(metadata),
		).rejects.toMatchObject({ code: "AGENT_SEARCH_INCOMPLETE" });
	});

	it("fails closed at the bounded page limit", async () => {
		let cursor = 0;
		const fetchMock = vi.fn(async () =>
			Response.json(page(100, `page-${cursor++}`)),
		);
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			new LettaClient(options).findAgentByMetadata(metadata),
		).rejects.toMatchObject({ code: "AGENT_SEARCH_INCOMPLETE" });
		expect(fetchMock).toHaveBeenCalledTimes(20);
	});

	it("aborts the entire search at ten seconds", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init.signal?.addEventListener(
							"abort",
							() => reject(new Error("aborted")),
							{ once: true },
						);
					}),
			),
		);
		const assertion = expect(
			new LettaClient(options).findAgentByMetadata(metadata),
		).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
		await vi.advanceTimersByTimeAsync(10_000);
		await assertion;
	});

	it.each([
		{ payload: null },
		{ payload: "unexpected" },
		{ payload: 42 },
		{ payload: true },
		{ payload: {} },
		{ payload: { agents: null } },
		{ payload: { agents: "unexpected" } },
		{ payload: { agents: [null] } },
		{ payload: [null] },
		{ payload: [42] },
		{ payload: ["unexpected"] },
		{ payload: [{ id: 42 }] },
		{ payload: [{ id: "" }] },
		{ payload: [{ metadata }] },
	])("refuses incomplete list payloads: $payload", async ({ payload }) => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json(payload)),
		);
		await expect(
			new LettaClient(options).findAgentByMetadata(metadata),
		).rejects.toMatchObject({ code: "INVALID_AGENT_LIST" });
	});

	it("accepts a populated agents envelope", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					Response.json({ agents: [{ id: "match", metadata }] }),
				),
		);
		await expect(
			new LettaClient(options).findAgentByMetadata(metadata),
		).resolves.toMatchObject({ id: "match" });
	});

	it("preserves safe typed HTTP diagnostics without echoing a provider body or query", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response("private credential and HTML", {
					status: 503,
					statusText: "sensitive response",
				}),
			),
		);
		await expect(
			new LettaClient(options).listAgents({ after: "private-cursor" }),
		).rejects.toMatchObject({
			code: "LIST_AGENTS_FAILED",
			status: 503,
			message: "Failed to list agents (HTTP 503)",
		});
	});

	it("does not echo an agent-create failure body", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response("private configuration and credential", {
					status: 400,
				}),
			),
		);
		await expect(
			new LettaClient(options).createAgent({
				name: "example",
				memoryBlocks: [],
			}),
		).rejects.toMatchObject({
			code: "CREATE_AGENT_FAILED",
			status: 400,
			message: "Failed to create agent (HTTP 400)",
		});
	});

	it("does not echo network exceptions containing a URL or credential", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockRejectedValue(
					new Error(
						"https://example:password@example.com/?key=private",
					),
				),
		);
		await expect(
			new LettaClient(options).listAgents(),
		).rejects.toMatchObject({
			code: "REQUEST_FAILED",
			message: "Letta request failed",
		});
	});
});
