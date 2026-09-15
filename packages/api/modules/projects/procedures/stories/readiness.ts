/**
 * Story Readiness
 *
 * AUTHORIZATION: requireProjectPermission(STORY_READ).
 *
 * Read-only readiness snapshot for the UI (readiness panel, StartWorkButton,
 * transition dialog). Always computed, never enforced here — enforcement
 * happens in the stage writers and run-start procedures.
 */

import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	loadStoryReadiness,
	storyReadinessOutputSchema,
	toReadinessOutput,
} from "../../lib/run-readiness";

export const storyReadinessProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/{storyId}/readiness",
		tags: ["Projects", "Features", "Governance"],
		summary: "Compute readiness gates for a feature",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(storyReadinessOutputSchema)
	.handler(async ({ input }) => {
		const snapshot = await loadStoryReadiness({
			storyId: input.storyId,
			projectId: input.projectId,
		});
		return toReadinessOutput(snapshot);
	});
