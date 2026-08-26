import { getProjectCodeIndexes } from "@repo/database";
import { ensureCollection, getCollectionLayout } from "../collection-manager";
import { generateEmbedding } from "../embedding";
import { generateSparseVector } from "../embedding/sparse";
import { qdrantClient } from "./client";

export interface ProjectCodeSearchResult {
	filePath: string;
	content: string;
	score: number;
	language: string | null;
	symbolName: string | null;
	symbolType: string | null;
}

function payloadString(
	payload: Record<string, unknown> | null | undefined,
	key: string,
): string | null {
	const value = payload?.[key];
	return typeof value === "string" ? value : null;
}

/**
 * Search the AST-aware repository index and return bounded source excerpts.
 *
 * Callers must authorize project access before invoking this helper. The vector
 * query is project-scoped, and organization projects use their physically
 * isolated collection. Keeping this in @repo/rag gives script generation and
 * chat the same payload interpretation instead of another hand-rolled Qdrant
 * boundary.
 */
export async function searchProjectCodeIndex(input: {
	projectId: string;
	query: string;
	userId: string;
	organizationId?: string;
	limit?: number;
}): Promise<ProjectCodeSearchResult[]> {
	const indexes = await getProjectCodeIndexes(input.projectId);
	if (!indexes.some((index) => index.status === "READY")) {
		return [];
	}

	const limit = Math.min(input.limit ?? 8, 20);
	const [embeddingResult, collectionName, layout] = await Promise.all([
		generateEmbedding(input.query, {
			userId: input.userId,
			organizationId: input.organizationId,
			projectId: input.projectId,
			tags: ["qa-script-generation", "code-search"],
		}),
		ensureCollection("project-contexts", input.organizationId),
		getCollectionLayout("project-contexts", input.organizationId),
	]);
	const filter = {
		must: [
			{ key: "projectId", match: { value: input.projectId } },
			{
				key: "contextType",
				match: { any: ["CODE_FILE", "CODE_FILE_SUMMARY"] },
			},
		],
	};

	const points =
		layout.supportsHybrid && layout.denseVectorName
			? (
					await qdrantClient.query(collectionName, {
						prefetch: [
							{
								query: embeddingResult.embedding,
								using: layout.denseVectorName,
								limit: limit * 2,
								filter,
							},
							{
								query: generateSparseVector(input.query),
								using: layout.sparseVectorName ?? "sparse",
								limit: limit * 2,
								filter,
							},
						],
						query: { fusion: "rrf" },
						limit,
						with_payload: true,
					})
				).points
			: (
					await qdrantClient.query(collectionName, {
						query: embeddingResult.embedding,
						limit,
						filter,
						with_payload: true,
					})
				).points;

	return points.flatMap((point) => {
		const filePath = payloadString(point.payload, "filePath");
		const content = payloadString(point.payload, "content");
		if (!filePath || !content) {
			return [];
		}
		return [
			{
				filePath,
				content,
				score: point.score,
				language: payloadString(point.payload, "language"),
				symbolName: payloadString(point.payload, "symbolName"),
				symbolType: payloadString(point.payload, "symbolType"),
			},
		];
	});
}
