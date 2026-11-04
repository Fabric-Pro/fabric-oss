import { describe, expect, it, vi } from "vitest";
import { createFabric, FabricError } from "../src/index.js";

function fixture(
	status = 200,
	body: unknown = {
		data: { text: "A😀", revision: "a".repeat(64), nextOffset: 2 },
	},
) {
	const fetch = vi.fn<typeof globalThis.fetch>(
		async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
	);
	return {
		fetch,
		client: createFabric({
			apiKey: "synthetic-key",
			baseUrl: "https://example.com",
			fetch,
		}),
	};
}
describe("Workspace document SDK", () => {
	it("encodes document/workspace IDs, actor organization, code-point page and pinned revision", async () => {
		const { client, fetch } = fixture();
		await expect(
			client.workspaces.readDocument("workspace/1", "document 1", {
				org: "example org",
				offset: 2,
				limit: 20,
				expectedRevision: "a".repeat(64),
			}),
		).resolves.toMatchObject({ text: "A😀", nextOffset: 2 });
		const url = new URL(String(fetch.mock.calls[0][0]));
		expect(url.pathname).toBe(
			"/api/v1/workspaces/workspace%2F1/documents/document%201/content",
		);
		expect(url.searchParams.get("org")).toBe("example org");
		expect(url.searchParams.get("expectedRevision")).toBe("a".repeat(64));
		expect(url.searchParams.get("offset")).toBe("2");
		expect(url.searchParams.get("limit")).toBe("20");
		expect(fetch.mock.calls[0][1]?.method).toBe("GET");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("discovers document IDs without a query or AI call", async () => {
		const { client, fetch } = fixture(200, {
			data: {
				documents: [{ id: "example-document", status: "READY" }],
				total: 1,
				nextOffset: null,
			},
		});
		await expect(
			client.workspaces.listDocuments("workspace/1", {
				limit: 10,
				offset: 5,
			}),
		).resolves.toMatchObject({ total: 1 });
		expect(String(fetch.mock.calls[0][0])).toBe(
			"https://example.com/api/v1/workspaces/workspace%2F1/documents?limit=10&offset=5",
		);
	});
	it.each([400, 403, 404, 409])(
		"propagates refusal %s without retrying or fetching a different revision",
		async (status) => {
			const { client, fetch } = fixture(status, {
				error: {
					code: "STALE_REVISION",
					message:
						"Document content changed. Restart at offset 0 before continuing.",
				},
			});
			await expect(
				client.workspaces.readDocument("workspace", "document", {
					offset: 2,
					expectedRevision: "a".repeat(64),
				}),
			).rejects.toBeInstanceOf(FabricError);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
});
