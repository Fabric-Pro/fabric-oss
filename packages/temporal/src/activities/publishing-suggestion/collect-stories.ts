/**
 * Publishing Suggestion — Story Collector Activity
 *
 * Reads UserStory rows created or genuinely edited inside the given window for a
 * project, bounded by `PER_SOURCE_CAP`. Mirrors the tenant-scoping and
 * window pattern of `daily-brief/collect-story-activity.ts`.
 *
 * M5 (deferred to 1C): stories do NOT drive sufficiency in 1A. The schema has
 * no durable "story completed in-window" signal — `FeatureVersion` is a
 * per-edit snapshot that carries the current drafting stage forward, so no
 * FeatureVersion-derived query reliably distinguishes a real close from a
 * later edit of an already-closed story. Rather than ship a false-positive
 * signal, story-completion moves to 1C behind a real transition log. Stories
 * are still returned as LLM CONTEXT (`items`); `qualifyingCount` is a fixed
 * `0` and ignored by `evaluateSufficiency` (which counts only PRs /
 * transcripts / documents).
 */

import { db, PER_SOURCE_CAP } from "@repo/database";
import { Context } from "@temporalio/activity";
import { byteBoundItems } from "./lib/byte-bound";

export interface CollectStoriesInput {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	windowStart: string;
	windowEnd: string;
}

export interface CollectStoriesOutput {
	items: { id: string; identifier: string; title: string; updatedAt: Date }[];
	count: number;
	qualifyingCount: number; // ALWAYS 0 in 1A — stories are LLM context only; completion signal deferred to 1C (M5)
	newestQualifyingIso: string | null; // always null — stories do not qualify (F7)
	capExhausted: boolean;
}

export async function collectStories(
	input: CollectStoriesInput,
): Promise<CollectStoriesOutput> {
	Context.current().heartbeat();
	const { projectId, organizationId, windowStart, windowEnd } = input;
	const start = new Date(windowStart);
	const end = new Date(windowEnd);
	const scope = { projectId, project: { organizationId } }; // explicit tenant guard (worker bypasses RLS)
	const select = {
		id: true,
		identifier: true,
		title: true,
		createdAt: true,
		lastEditedAt: true,
	} as const;
	const [editedRows, createdRows] = await Promise.all([
		db.userStory.findMany({
			where: {
				...scope,
				lastEditedAt: { gte: start, lte: end },
			},
			select,
			orderBy: { lastEditedAt: "desc" },
			take: PER_SOURCE_CAP + 1,
		}),
		db.userStory.findMany({
			where: {
				...scope,
				lastEditedAt: null,
				createdAt: { gte: start, lte: end },
			},
			select,
			orderBy: { createdAt: "desc" },
			take: PER_SOURCE_CAP + 1,
		}),
	]);
	const rows = [...editedRows, ...createdRows].sort(
		(a, b) =>
			(b.lastEditedAt ?? b.createdAt).getTime() -
			(a.lastEditedAt ?? a.createdAt).getTime(),
	);
	const capExhaustedByCount = rows.length > PER_SOURCE_CAP;
	const selectedRows = capExhaustedByCount
		? rows.slice(0, PER_SOURCE_CAP)
		: rows;
	const items = selectedRows.map(({ createdAt, lastEditedAt, ...row }) => ({
		...row,
		updatedAt: lastEditedAt ?? createdAt,
	}));

	// M5 (deferred to 1C): see file header. qualifyingCount is fixed at 0 — stories
	// never drive sufficiency in 1A regardless of status/state.
	const qualifyingCount = 0;

	// H3: item-count caps do NOT bound Temporal's 4MB gRPC payload — byte-bound the
	// serialized items before returning (reuses the #1750 helper). A byte-trim is a
	// source INCOMPLETENESS: OR its `trimmed` flag into `capExhausted` so the
	// workflow records a source failure and does NOT advance this source's coverage
	// (dropped context is never silently skipped).
	const { items: bounded, trimmed } = byteBoundItems(items);
	return {
		items: bounded,
		count: bounded.length,
		qualifyingCount,
		newestQualifyingIso: null,
		capExhausted: capExhaustedByCount || trimmed,
	};
}
