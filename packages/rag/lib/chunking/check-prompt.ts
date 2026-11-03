/**
 * When to offer a chunking check (spec 2026-10-28 §8d, variant B).
 *
 * Opening RAG Settings or the project overview must not cost a scan of the
 * index, so the decision uses counts and names only: how many sources the
 * project has now, how many were added since the last check, and which
 * embedding model is current, against the snapshot the last check kept.
 * Nothing is offered when the content barely changed, however long ago the
 * last check was.
 */

/** Share of sources added or removed that makes a check worth offering. */
export const CHECK_CHANGE_SHARE = 0.5;
/** Sources added since the last check that make it worth offering. */
export const CHECK_ADDED_SOURCES = 200;
/** After this long, a smaller change is enough. */
export const CHECK_STALE_DAYS = 90;
export const CHECK_STALE_CHANGE_SHARE = 0.2;
/** A project never checked is offered one once it has this many sources. */
export const CHECK_FIRST_SOURCES = 20;

export type ChunkingCheckReason =
	| "model-changed"
	| "content-changed"
	| "stale"
	| "never-checked";

export interface ChunkingCheckPrompt {
	reason: ChunkingCheckReason;
	/** When the last check ran; null when there has been none. */
	lastCheckedAt: string | null;
	sources: number;
	sourcesAtLastCheck: number | null;
	addedSince: number;
	embeddingModel: string | null;
	embeddingModelAtLastCheck: string | null;
}

export function chunkingCheckPrompt(input: {
	now: Date;
	lastCheck: {
		at: Date;
		sources: number | null;
		embeddingModel: string | null;
	} | null;
	current: {
		sources: number;
		addedSince: number;
		embeddingModel: string | null;
	};
}): ChunkingCheckPrompt | null {
	const { now, lastCheck, current } = input;
	const base = {
		lastCheckedAt: lastCheck?.at.toISOString() ?? null,
		sources: current.sources,
		sourcesAtLastCheck: lastCheck?.sources ?? null,
		addedSince: current.addedSince,
		embeddingModel: current.embeddingModel,
		embeddingModelAtLastCheck: lastCheck?.embeddingModel ?? null,
	};

	if (!lastCheck) {
		return current.sources >= CHECK_FIRST_SOURCES
			? { reason: "never-checked", ...base }
			: null;
	}

	if (
		lastCheck.embeddingModel &&
		current.embeddingModel &&
		lastCheck.embeddingModel !== current.embeddingModel
	) {
		return { reason: "model-changed", ...base };
	}

	// Added since the last check, plus what was removed when the snapshot
	// says how many there were.
	const removed =
		lastCheck.sources === null
			? 0
			: Math.max(
					0,
					lastCheck.sources + current.addedSince - current.sources,
				);
	const changed = current.addedSince + removed;
	const reference = Math.max(lastCheck.sources ?? current.sources, 1);
	const share = changed / reference;

	if (
		share >= CHECK_CHANGE_SHARE ||
		current.addedSince >= CHECK_ADDED_SOURCES
	) {
		return { reason: "content-changed", ...base };
	}

	const days = (now.getTime() - lastCheck.at.getTime()) / 86_400_000;
	if (days >= CHECK_STALE_DAYS && share >= CHECK_STALE_CHANGE_SHARE) {
		return { reason: "stale", ...base };
	}
	return null;
}
