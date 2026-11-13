import {
	type RetrievedContext as Context,
	formatContextsForPrompt,
} from "./retrieval";

// Matches DEFAULT_RAG_SETTINGS.chunkOverlap in database queries/projects/rag-settings.
// The retrieval caller supplies the project override.
export const DEFAULT_CHUNK_OVERLAP = 500;
export const MIN_MERGE_OVERLAP = 50;
export interface AdjacentPairStats {
	mergedPairs: number;
	joinedPairs: number;
}
// Recursive splitting can reset overlap; adjacency alone is insufficient evidence.
export function mergeAdjacent(
	passages: NonNullable<Context["matchedPassages"]>,
	maxOverlap = DEFAULT_CHUNK_OVERLAP,
	stats: AdjacentPairStats = { mergedPairs: 0, joinedPairs: 0 },
) {
	let text = "";
	let previous: number | undefined;
	let previousContent = "";
	for (const p of [...passages].sort(
		(a, b) =>
			(a.chunkIndex ?? Number.POSITIVE_INFINITY) -
			(b.chunkIndex ?? Number.POSITIVE_INFINITY),
	)) {
		let overlap = 0;
		if (p.chunkIndex === (previous ?? Number.POSITIVE_INFINITY) + 1) {
			for (
				let n = Math.min(
					maxOverlap,
					previousContent.length,
					p.content.length,
				);
				n >= MIN_MERGE_OVERLAP;
				n--
			) {
				if (previousContent.endsWith(p.content.slice(0, n))) {
					overlap = n;
					break;
				}
			}
			if (overlap) {
				stats.mergedPairs++;
			} else {
				stats.joinedPairs++;
			}
		}
		text += overlap
			? p.content.slice(overlap)
			: `${text ? "\n\n" : ""}${p.content}`;
		previous = p.chunkIndex;
		previousContent = p.content;
	}
	return text;
}
export interface PoolChunk {
	id: string;
	sourceId: string;
	content: string;
	score: number;
	chunkIndex?: number;
}
export interface RankedChunk extends PoolChunk {
	rerankedScore: number;
}
// Match summary recognition in compactProjectContextPassages.
function isSummaryContext(context: Context): boolean {
	return (
		context.type === "PROJECT_SUMMARY" ||
		context.metadata?.isSummary === true
	);
}

export function chunkPool(contexts: Context[], limit: number) {
	const candidates = contexts
		.filter((context) => !isSummaryContext(context))
		.flatMap((c) =>
			(c.matchedPassages ?? []).map((p, i) => ({
				...p,
				id: `${c.id}:passage:${i}`,
				sourceId: c.id,
			})),
		);
	return {
		rawCandidates: candidates.length,
		chunks: candidates.sort((a, b) => b.score - a.score).slice(0, limit),
	};
}
export function rankedPool(
	contexts: Context[],
	chunks: RankedChunk[],
	keep: number,
	maxOverlap = DEFAULT_CHUNK_OVERLAP,
) {
	const selected = new Map<string, RankedChunk[]>();
	let count = 0;
	for (const chunk of [...chunks].sort(
		(a, b) => b.rerankedScore - a.rerankedScore,
	)) {
		if (count >= keep) {
			break;
		}
		const kept = selected.get(chunk.sourceId) ?? [];
		if (kept.length >= Math.ceil(keep / 2)) {
			continue;
		}
		selected.set(chunk.sourceId, [...kept, chunk]);
		count++;
	}
	const byId = new Map(contexts.map((c) => [c.id, c]));
	const adjacency: AdjacentPairStats = { mergedPairs: 0, joinedPairs: 0 };
	const sources = [...selected].map(([id, passages]) => {
		const source = byId.get(id);
		if (!source) {
			throw new Error("RANKED_SOURCE_MISSING");
		}
		return {
			...source,
			content: mergeAdjacent(passages, maxOverlap, adjacency),
		};
	});
	return {
		context: formatContextsForPrompt([
			...contexts.filter(isSummaryContext),
			...sources,
		]),
		keptChunks: count,
		keptSources: sources.length,
		...adjacency,
	};
}
