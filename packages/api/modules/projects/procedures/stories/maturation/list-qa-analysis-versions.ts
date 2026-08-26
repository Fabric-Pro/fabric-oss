import {
	listQaAnalysisVersions,
	type QaAnalysisVersionSummary,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../../lib/test-cases-feature";
import { QaAnalysisContentSchema } from "./schemas";

/**
 * `maturation.qaAnalysisVersions` — the QA-analysis version
 * history for one feature, newest first.
 *
 * Read-only: gated by `requireProjectPermission(STORY_UPDATE)` (the same
 * permission the QA tab already needs to be usable) and scoped to the project by
 * the query layer, so a cross-project story id resolves to an empty list rather
 * than another project's history. No `requireInputOrgPermission` because this
 * writes nothing — it is not on the SOC2 input-org ratchet, which governs
 * mutations.
 */
export const listQaAnalysisVersionsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/{storyId}/maturation/qa-analysis/versions",
		tags: ["Projects", "Features", "Maturation"],
		summary: "List the QA analysis version history for a feature",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			limit: z.number().int().min(1).max(50).optional(),
			offset: z.number().int().min(0).optional(),
		}),
	)
	.output(
		z.object({
			total: z.number(),
			versions: z.array(
				z.object({
					id: z.string(),
					depth: z.string(),
					specHash: z.string(),
					// `null` when a stored snapshot is malformed — dropped by the
					// parser, never a throw.
					content: QaAnalysisContentSchema.nullable(),
					generatedByUserId: z.string().nullable(),
					generatedByName: z.string().nullable(),
					generatedAt: z.string(),
				}),
			),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(STORY_UPDATE) gates project
		// access; the query is project-scoped so results never cross tenants.
		const {
			versions,
			total,
		}: { versions: QaAnalysisVersionSummary[]; total: number } =
			await listQaAnalysisVersions({
				projectId: input.projectId,
				userStoryId: input.storyId,
				limit: input.limit,
				offset: input.offset,
			});
		return { versions, total };
	});
