import { ORPCError } from "@orpc/client";
import { db, mergeStoryMarkers } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	buildScopeEstimate,
	renderScopeEstimateCsv,
	renderScopeEstimateMarkdown,
	scopeEstimateFilename,
} from "../../lib/scope-estimate";

const exportScopeEstimateInputSchema = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
	format: z.enum(["markdown", "csv"]),
});

/**
 * Export the project's scope estimate (plan Slice 7): one row per feature
 * grouped by phase, with per-phase and per-track point totals. Phases that
 * contain a LOW-confidence item are reported as a `min–max` range.
 *
 * AUTHORIZATION: `requireProjectPermission(STORY_READ)`.
 */
export const exportScopeEstimateProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/export-scope-estimate",
		tags: ["Projects", "Features"],
		summary: "Export scope estimate",
		description:
			"Render the project's features as a scope estimate grouped by phase (markdown or CSV) with point totals and confidence ranges.",
	})
	.input(exportScopeEstimateInputSchema)
	.output(
		z.object({
			content: z.string(),
			filename: z.string(),
			rowCount: z.number().int(),
		}),
	)
	.handler(async ({ input }) => {
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { id: true, name: true, quotedPhases: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		const stories = await db.userStory.findMany({
			where: {
				projectId: input.projectId,
				draftingStage: { not: "DECLINED" },
			},
			select: {
				identifier: true,
				title: true,
				sourceRef: true,
				labels: true,
				// `phase:`/`priority:` markers are StoryTag rows in fabric-dev.
				tags: { select: { value: true } },
				deliveryTrack: true,
				priority: true,
				size: true,
				storyPoints: true,
				estimateConfidence: true,
				dependsOnPhases: true,
				dependsOnRefs: true,
			},
		});

		const estimate = buildScopeEstimate(
			stories.map((story) => ({
				...story,
				labels: mergeStoryMarkers(story.labels, story.tags),
			})),
			project.quotedPhases,
		);
		const now = new Date();
		const content =
			input.format === "csv"
				? renderScopeEstimateCsv(estimate)
				: renderScopeEstimateMarkdown(estimate, {
						projectName: project.name,
						generatedAt: now,
					});

		return {
			content,
			filename: scopeEstimateFilename(project.name, input.format, now),
			rowCount: estimate.rows.length,
		};
	});
