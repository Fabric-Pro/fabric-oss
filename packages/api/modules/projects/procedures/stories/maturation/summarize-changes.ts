import { ORPCError } from "@orpc/client";
import { hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { summarizeSpecChanges } from "../../../lib/summarize-spec-changes";

/**
 * `maturation.summarizeChanges` — turn a before→after spec pair into a short,
 * section-tagged change summary for the confirm-time review (so the PO reads ~4
 * lines instead of scanning the agent's full inline diff). Read-only: never
 * writes the spec, so it does not trigger PM sync (§7.7).
 */
export const summarizeChangesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/maturation/summarize-changes",
		tags: ["Projects", "Features", "Maturation"],
		summary: "Summarize a pending spec change for confirm-time review",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			before: z.string().max(200_000),
			after: z.string().max(200_000),
		}),
	)
	.output(z.object({ changeSummary: z.array(z.string()) }))
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const changeSummary = await summarizeSpecChanges({
			before: input.before,
			after: input.after,
			tenantFilter: {
				organizationId: organizationId ?? null,
				userId: context.user.id,
			},
			projectId: input.projectId,
		});
		return { changeSummary };
	});
