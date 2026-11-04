import type { QdrantClient } from "@qdrant/js-client-rest";

type DenseSearchOptions = Omit<
	Parameters<QdrantClient["query"]>[1],
	"query" | "using" | "prefetch"
> & {
	vector: number[] | { name: string; vector: number[] };
};

/**
 * Retain Fabric's dense-search interface after the SDK removed search().
 * The query request uses SDK types; defaults match js-client-rest 1.16.2's
 * QdrantClient.search, including payloads (query itself defaults them off).
 */
export function withDenseSearch(client: QdrantClient) {
	return Object.assign(client, {
		async search(
			collection: string,
			{
				vector,
				limit = 10,
				offset = 0,
				with_payload = true,
				with_vector = false,
				...options
			}: DenseSearchOptions,
		) {
			const named = !Array.isArray(vector);
			const result = await client.query(collection, {
				...options,
				query: named ? vector.vector : vector,
				using: named ? vector.name : undefined,
				limit,
				offset,
				with_payload,
				with_vector,
			});
			return result.points;
		},
	});
}
