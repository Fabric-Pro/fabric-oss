import { ORPCError } from "@orpc/client";
import {
	hasProjectAccess,
	listContextSummaries,
	parseSourceSelection,
	parseSummaryStats,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertContextSummarizationEnabled } from "../../lib/context-summarization-feature";

/**
 * Current summarization state for a project — powers the Context-tab poll,
 * status line, and "Summary" badge. Returns the most recent summary row (any
 * status) so the UI can show PENDING/GENERATING progress, the COMPLETED
 * watermark, or a FAILED error. Any project member can read.
 */
export const contextSummaryStatusProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/contexts/summary-status",
		tags: ["Projects", "Contexts"],
		summary: "Context summary status",
		description:
			"Latest context-summary status and metadata for a project (poll target).",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertContextSummarizationEnabled();
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const [latest] = await listContextSummaries({
			projectId: input.projectId,
			userId: user.id,
			organizationId,
			take: 1,
		});

		return {
			status: latest?.status ?? null,
			summary: latest
				? {
						id: latest.id,
						status: latest.status,
						trigger: latest.trigger,
						coveredThrough: latest.coveredThrough,
						coveredContextCount: latest.coveredContextCount,
						tokenCount: latest.tokenCount,
						error: latest.error,
						createdAt: latest.createdAt,
						updatedAt: latest.updatedAt,
						sourceSelection: parseSourceSelection(
							latest.sourceSelection,
						),
						progress: computeProgress(latest.status, latest.stats),
					}
				: null,
		};
	});

/**
 * Determinate progress for a run: percent of planned raw-context sources folded so
 * far. COMPLETED → 100; PENDING/GENERATING → processed/planned clamped to 0..99 (a
 * small baseline when the planned count isn't known yet so the bar always moves);
 * terminal-but-not-complete (FAILED/CANCELLED) → null.
 */
function computeProgress(
	status: string,
	statsJson: Parameters<typeof parseSummaryStats>[0],
): { processed: number; planned: number; percent: number } | null {
	if (status === "COMPLETED") {
		const s = parseSummaryStats(statsJson);
		const processed = s?.processedSourceCount ?? 0;
		return {
			processed,
			planned: s?.plannedSourceCount ?? processed,
			percent: 100,
		};
	}
	if (status !== "PENDING" && status !== "GENERATING") {
		return null;
	}
	const s = parseSummaryStats(statsJson);
	const processed = s?.processedSourceCount ?? 0;
	const planned = s?.plannedSourceCount ?? 0;
	const percent =
		planned > 0
			? Math.min(99, Math.round((processed / planned) * 100))
			: processed > 0
				? 95
				: 5;
	return { processed, planned, percent };
}
