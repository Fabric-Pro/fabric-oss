import {
	AI_SEGMENT_MIN_SAMPLE,
	getAiChangeAnnotations,
	getAiOutcomeSegments,
	getAiUsageAdoptionSummary,
	getAiUsageByFeature,
	getBacklogProposalAdoption,
	getMaturationAnswerAdoption,
} from "@repo/database";
import { z } from "zod";
import {
	adminProcedure,
	Permissions,
	requirePermission,
} from "../../../orpc/procedures";

/**
 * Aggregated AI-adoption metrics for the platform-admin dashboard
 * (Fizzy #2230, Phase 0): maturation answer acceptance (as-is / edited /
 * manual), AI Backlog Update proposal outcomes, and platform LLM call
 * volume as context. Read-only; no per-request writes.
 *
 * AUTHORIZATION: instance admin only (adminProcedure). Metrics are
 * platform-wide, not tenant-scoped.
 */
export const getAiAdoptionMetricsProcedure = adminProcedure
	// `adminProcedure` already gates on the instance-admin role. The explicit
	// permission decorator is additionally REQUIRED by packages/api/__tests__/
	// permission-coverage.test.ts; ORG_SETTINGS_READ mirrors the same
	// org-scoped-name / global-procedure precedent as feature-flags.ts.
	.use(requirePermission(Permissions.ORG_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/admin/ai-adoption",
		tags: ["Admin"],
		summary: "Get AI adoption metrics",
		description:
			"Platform-wide AI feature adoption and acceptance aggregates over a trailing window.",
	})
	.input(
		z.object({
			days: z.number().int().min(1).max(365).default(30),
		}),
	)
	.handler(async ({ input }) => {
		const to = new Date();
		const from = new Date(to.getTime() - input.days * 24 * 60 * 60 * 1000);
		const range = { from, to };

		const [
			maturation,
			backlog,
			usage,
			usageByFeature,
			outcomeSegments,
			changeAnnotations,
		] = await Promise.all([
			getMaturationAnswerAdoption(range),
			getBacklogProposalAdoption(range),
			getAiUsageAdoptionSummary(range),
			getAiUsageByFeature(range),
			getAiOutcomeSegments(range),
			getAiChangeAnnotations(range),
		]);

		return {
			periodDays: input.days,
			from: from.toISOString(),
			to: to.toISOString(),
			maturation,
			backlog,
			usage,
			usageByFeature,
			outcomeSegments,
			changeAnnotations,
			minSampleSize: AI_SEGMENT_MIN_SAMPLE,
		};
	});
