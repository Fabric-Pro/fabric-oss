import { listUserDraftProjects } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * List recent DRAFT projects for the current user (for "Continue draft" banner).
 * Returns at most 3 drafts from the last 7 days.
 */
export const listDraftProjectsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/drafts",
		tags: ["Projects"],
		summary: "List draft projects",
		description: "List recent DRAFT projects for the current user",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const drafts = await listUserDraftProjects({
			userId: context.user.id,
			organizationId,
			limit: 3,
		});

		return { drafts };
	});
