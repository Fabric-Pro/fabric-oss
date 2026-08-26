import { ORPCError } from "@orpc/client";
import { dismissDuplicateLink, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const dismissDuplicateProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/dismiss-duplicate",
		tags: ["Projects", "Stories"],
		summary: "Dismiss a duplicate link",
		description:
			"Mark a flagged pair as not a duplicate. Persisted so future scans never re-surface it.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			linkId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId ?? undefined,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}
		const count = await dismissDuplicateLink(
			input.linkId,
			input.projectId,
			context.user.id,
		);
		if (count === 0) {
			throw new ORPCError("NOT_FOUND", {
				message: "Duplicate link not found",
			});
		}
		return { dismissed: true };
	});
