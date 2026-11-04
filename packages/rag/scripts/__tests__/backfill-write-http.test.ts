import { QdrantClient } from "@qdrant/js-client-rest";
import { afterEach, expect, it, vi } from "vitest";
import { backfillSparseVectors } from "../backfill-sparse-vectors";

afterEach(() => vi.unstubAllGlobals());
it("keeps a live re-embed's sparse vector by sending update_filter in the HTTP write", async () => {
	const newerSparse = { indices: [42], values: [2] };
	let storedSparse = newerSparse;
	let requestBody: Record<string, unknown> | undefined;
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
			let result: unknown;
			if (path.endsWith("/points/scroll")) {
				// Scroll's snapshot predates a live re-embed, which has already written newerSparse.
				result = {
					points: [
						{ id: 1, payload: { content: "old keyword content" } },
					],
					next_page_offset: null,
				};
			} else if (path.endsWith("/points/vectors")) {
				expect(init?.method).toBe("PUT");
				requestBody = JSON.parse(String(init?.body));
				const guard = requestBody?.update_filter;
				if (
					JSON.stringify(guard) !==
					JSON.stringify({ must_not: [{ has_vector: "sparse" }] })
				) {
					const point = (
						requestBody?.points as Array<{
							vector: { sparse: typeof newerSparse };
						}>
					)[0];
					if (!point) {
						throw new Error("missing point in vector update");
					}
					storedSparse = point.vector.sparse;
				}
				result = { operation_id: 1, status: "completed" };
			} else {
				result = {
					config: { params: { sparse_vectors: { sparse: {} } } },
				};
			}
			return new Response(
				JSON.stringify({ result, status: "ok", time: 0 }),
				{ headers: { "content-type": "application/json" } },
			);
		}),
	);
	const client = new QdrantClient({
		url: "http://localhost:6333",
		checkCompatibility: false,
	});
	await backfillSparseVectors(
		client,
		{ collection: "project-contexts", dryRun: false, batchSize: 2 },
		vi.fn(),
	);
	expect(storedSparse).toEqual(newerSparse);
	expect(requestBody?.update_filter).toEqual({
		must_not: [{ has_vector: "sparse" }],
	});
});
