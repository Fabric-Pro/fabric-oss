/**
 * Publishing Suggestion — Meeting Transcript Collector Activity
 *
 * `ProjectMeetingTranscript` has NO `createdAt` column — the window filters
 * on `syncedAt` (non-null, `@default(now())`). `qualifyingCount` = rows with
 * a non-empty trimmed `summary`. `newestQualifyingIso` (F7) uses
 * `insightsExtractedAt ?? syncedAt` per qualifying row, so a transcript
 * synced long ago whose summary/insights landed recently still counts as
 * fresh.
 *
 * (N4) The window `where` must mirror the cost-guard's freshness OR
 * (`countNewContextSince` in `packages/database/prisma/queries/projects/
 * publishing-suite.ts`, F5): a row is IN-WINDOW when EITHER `syncedAt` OR
 * `insightsExtractedAt` falls in `[windowStart, windowEnd]`. A `syncedAt`-only
 * window would exclude a transcript synced >180 days ago but reprocessed
 * (summarized) inside the window — the guard would see it as new and
 * dispatch a cycle, but this collector would never select it, so coverage
 * never advances and the cycle repeats INSUFFICIENT_CONTEXT daily.
 */

import { db, PER_SOURCE_CAP } from "@repo/database";
import { Context } from "@temporalio/activity";
import { byteBoundItems } from "./lib/byte-bound";

export interface CollectTranscriptsInput {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	windowStart: string;
	windowEnd: string;
}

export interface CollectTranscriptsOutput {
	items: {
		id: string;
		summary: string | null;
		syncedAt: Date;
		insightsExtractedAt: Date | null;
	}[];
	count: number;
	qualifyingCount: number;
	newestQualifyingIso: string | null;
	capExhausted: boolean;
}

export async function collectTranscripts(
	input: CollectTranscriptsInput,
): Promise<CollectTranscriptsOutput> {
	Context.current().heartbeat();
	const { projectId, organizationId, windowStart, windowEnd } = input;
	const start = new Date(windowStart);
	const end = new Date(windowEnd);
	const scope = { projectId, project: { organizationId } }; // explicit tenant guard (worker bypasses RLS)

	const rows = await db.projectMeetingTranscript.findMany({
		where: {
			...scope,
			// NO createdAt on this model — window on syncedAt OR insightsExtractedAt
			// (N4), mirroring the cost-guard's freshness OR so a transcript reprocessed
			// inside the window is collected even if it originally synced outside it.
			OR: [
				{ syncedAt: { gte: start, lte: end } },
				{ insightsExtractedAt: { gte: start, lte: end } },
			],
		},
		select: {
			id: true,
			summary: true,
			syncedAt: true,
			insightsExtractedAt: true,
		},
		orderBy: { syncedAt: "desc" },
		take: PER_SOURCE_CAP + 1, // +1 sentinel to detect exhaustion
	});
	const capExhaustedByCount = rows.length > PER_SOURCE_CAP;
	const items = capExhaustedByCount ? rows.slice(0, PER_SOURCE_CAP) : rows;

	const qualifying = items.filter((r) => (r.summary ?? "").trim().length > 0);
	const qualifyingCount = qualifying.length;
	const newestQualifyingIso =
		qualifying.length > 0
			? new Date(
					Math.max(
						...qualifying.map((r) =>
							(r.insightsExtractedAt ?? r.syncedAt).getTime(),
						),
					),
				).toISOString()
			: null;

	// H3: byte-bound the returned `items` before returning. A byte-trim is source
	// INCOMPLETENESS — OR it into `capExhausted`.
	const { items: bounded, trimmed } = byteBoundItems(items);
	return {
		items: bounded,
		count: bounded.length,
		qualifyingCount,
		newestQualifyingIso,
		capExhausted: capExhaustedByCount || trimmed,
	};
}
