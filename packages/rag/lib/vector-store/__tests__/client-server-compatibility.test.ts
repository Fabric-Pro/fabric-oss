import { QdrantClient } from "@qdrant/js-client-rest";
import { afterEach, expect, it, vi } from "vitest";
import { withDenseSearch } from "../dense-search";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
it("client 1.20 warns for server 1.16.3 and still sends dense reads and writes", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const requests: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = new URL(
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url,
			).pathname;
			requests.push(`${init?.method ?? "GET"} ${path}`);
			const root = path === "/";
			return new Response(
				JSON.stringify(
					root
						? { title: "qdrant", version: "1.16.3" }
						: {
								status: "ok",
								time: 0,
								result: path.endsWith("/query")
									? { points: [] }
									: { operation_id: 1, status: "completed" },
							},
				),
				{ headers: { "content-type": "application/json" } },
			);
		}),
	);
	const client = withDenseSearch(
		new QdrantClient({ url: "http://localhost:6333" }),
	);
	await vi.waitFor(() =>
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("incompatible with server version 1.16.3"),
		),
	);
	await expect(
		client.upsert("example-collection", {
			wait: true,
			points: [{ id: 1, vector: [0.1, 0.2] }],
		}),
	).resolves.toMatchObject({ status: "completed" });
	await expect(
		client.search("example-collection", { vector: [0.1, 0.2], limit: 1 }),
	).resolves.toEqual([]);
	expect(requests).toContain("PUT /collections/example-collection/points");
	expect(requests).toContain(
		"POST /collections/example-collection/points/query",
	);
});
