import { QdrantClient } from "@qdrant/js-client-rest";
import { expect, it, vi } from "vitest";
import { withDenseSearch } from "../dense-search";

it.each([null, "dense"])(
	"translates dense search %s to the typed query API with legacy defaults",
	async (name) => {
		const client = new QdrantClient({
			url: "http://localhost:6333",
			checkCompatibility: false,
		});
		const points = [
			{ id: 1, score: 0.8, version: 1, payload: { content: "keyword" } },
		];
		const query = vi.spyOn(client, "query").mockResolvedValue({ points });
		const search = withDenseSearch(client);
		expect(
			await search.search("example-collection", {
				vector: name ? { name, vector: [0.1] } : [0.1],
			}),
		).toEqual(points);
		expect(query).toHaveBeenCalledWith("example-collection", {
			query: [0.1],
			using: name ?? undefined,
			limit: 10,
			offset: 0,
			with_payload: true,
			with_vector: false,
		});
		query.mockClear();
		await search.search("example-collection", {
			vector: [0.2],
			limit: 2,
			offset: 3,
			with_payload: false,
			with_vector: true,
			score_threshold: 0.7,
			filter: {
				must: [
					{ key: "projectId", match: { value: "example-project" } },
				],
			},
		});
		expect(query).toHaveBeenCalledWith("example-collection", {
			query: [0.2],
			using: undefined,
			limit: 2,
			offset: 3,
			with_payload: false,
			with_vector: true,
			score_threshold: 0.7,
			filter: {
				must: [
					{ key: "projectId", match: { value: "example-project" } },
				],
			},
		});
	},
);
