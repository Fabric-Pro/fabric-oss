/**
 * Context-summary injection for the RAG read path.
 *
 * When Context Summarization is enabled and a project has a current COMPLETED
 * summary, the compressed summary stands in for the OLDER raw context it covers:
 * we drop the retrieved raw contexts created at or before the summary's true
 * watermark and prepend the summary as a single labeled block. Recent raw context
 * (created after the watermark) is left untouched, so newer knowledge is always
 * available live. With the flag off or no summary present, the input list is
 * returned byte-for-byte (rollback-safe).
 *
 * Trust gate: only a v2 (map-reduce) summary — whose watermark is the true latest
 * folded source — is allowed to DROP raw context. A legacy v1 summary carries an
 * over-advanced, untrustworthy watermark, so it is injected ADDITIVELY (nothing
 * dropped) until the cron rebuilds it. This means no project knowledge is ever
 * silently hidden, even before a rebuild.
 *
 * AI drill-down: a v2 summary carries inline `[S#]` citation markers plus a
 * compact machine-readable reference legend appended to the injected block, so a
 * tool-enabled assistant can resolve a marker back to its original source via the
 * canonical resolver (`resolveContextSummaryReference` / the
 * `projects.contexts.resolveReference` procedure).
 *
 * This is the single shared helper for every retrieval seam (project-context
 * retrieval, document generation, spec update) so the behavior stays identical
 * across them.
 */

import {
	CONTEXT_SUMMARY_ENGINE_VERSION,
	type ContextSourceReference,
	db,
	getLatestCompletedContextSummary,
	parseSourceSelection,
	parseSummaryReferences,
} from "@repo/database";
import { logger } from "@repo/logs";
import { isContextSummarizationEnabled } from "@repo/utils/feature-flag";
import type { RetrievedContext } from "./retrieval";

/** Synthetic source-type label so the model knows this block is a digest. */
export const SUMMARY_CONTEXT_TYPE = "PROJECT_SUMMARY";
const SUMMARY_SOURCE_LABEL = "Compressed project history (summary)";

/** Cap on legend entries appended for AI drill-down (bounds injected size). */
const MAX_LEGEND_REFS = 100;

export type ContextSummaryScope = {
	projectId: string;
	userId?: string | null;
	organizationId?: string | null;
};

/**
 * Build the compact machine-readable reference legend appended to the injected
 * summary so a tool-enabled AI can resolve markers to original sources.
 */
function buildReferenceLegend(
	summaryId: string,
	references: ContextSourceReference[],
): string {
	if (references.length === 0) {
		return "";
	}
	const lines = references.slice(0, MAX_LEGEND_REFS).map((r) => {
		const label = r.label ? ` · ${r.label}` : "";
		return `${r.marker} = {type: ${r.sourceType}, sourceId: ${r.sourceId}, at: ${r.sourceTimestamp}${label}}`;
	});
	const truncated =
		references.length > MAX_LEGEND_REFS
			? `\n(+${references.length - MAX_LEGEND_REFS} more references omitted)`
			: "";
	return [
		"",
		"---",
		"SOURCE REFERENCES (each [S#] marker above maps to an original source you can retrieve for more detail;",
		`resolve via the context-summary reference resolver with summaryId "${summaryId}" and the sourceId below):`,
		...lines,
		truncated,
	]
		.filter((line) => line !== "")
		.join("\n");
}

export async function applyContextSummary(
	contexts: RetrievedContext[],
	scope: ContextSummaryScope,
): Promise<RetrievedContext[]> {
	if (!isContextSummarizationEnabled()) {
		return contexts;
	}

	const summary = await getLatestCompletedContextSummary({
		projectId: scope.projectId,
		userId: scope.userId,
		organizationId: scope.organizationId,
	});
	if (!summary?.content) {
		return contexts;
	}

	const trusted = summary.engineVersion >= CONTEXT_SUMMARY_ENGINE_VERSION;
	const references = parseSummaryReferences(summary.references);
	// A summary that EXCLUDED raw context (source selection with context off) never
	// incorporated it, so it must not stand in for it — inject additively even
	// though it is a trustworthy v2 summary. Legacy rows (null selection) covered
	// context by definition.
	const coversContext =
		parseSourceSelection(summary.sourceSelection).context !== false;

	// Only a trustworthy (v2) watermark that actually covered context may DROP raw
	// context. Otherwise the summary is additive-only, so no knowledge is hidden.
	const canDropCovered = trusted && coversContext;
	let survivors = contexts;
	if (canDropCovered && contexts.length > 0) {
		const covered = await db.projectContext.findMany({
			where: {
				projectId: scope.projectId,
				id: { in: contexts.map((c) => c.id) },
				createdAt: { lte: summary.coveredThrough },
			},
			select: { id: true },
		});
		if (covered.length > 0) {
			const coveredIds = new Set(covered.map((r) => r.id));
			survivors = contexts.filter((c) => !coveredIds.has(c.id));
		}
	} else if (!trusted) {
		logger.info(
			"[Context Summarization] legacy summary injected additively (watermark not trusted; awaiting rebuild)",
			{ projectId: scope.projectId, summaryId: summary.id },
		);
	} else if (!coversContext) {
		logger.info(
			"[Context Summarization] summary injected additively (raw context was excluded from this summary's sources)",
			{ projectId: scope.projectId, summaryId: summary.id },
		);
	}

	const content = trusted
		? `${summary.content}${buildReferenceLegend(summary.id, references)}`
		: summary.content;

	const summaryBlock: RetrievedContext = {
		id: summary.id,
		type: SUMMARY_CONTEXT_TYPE,
		content,
		score: 1,
		sourceTitle: SUMMARY_SOURCE_LABEL,
		metadata: {
			isSummary: true,
			summaryId: summary.id,
			engineVersion: summary.engineVersion,
			coveredThrough: summary.coveredThrough.toISOString(),
			coveredContextCount: summary.coveredContextCount,
			references,
		},
	};
	return [summaryBlock, ...survivors];
}
