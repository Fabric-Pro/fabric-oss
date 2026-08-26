import { ORPCError } from "@orpc/client";
import { getProjectMemberFunctionTags, hasProjectAccess } from "@repo/database";
import { FunctionTagSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * List every project member's function tags (roster join). Read-only —
 * `PROJECT_MEMBERS_READ` gates it, plus an explicit `hasProjectAccess`
 * re-check (mirroring `list-members.ts`) so an org-role permission
 * fallback alone can't read a project the caller isn't a member of.
 * Nothing is persisted here, so there is no tenancy-derivation concern
 * (contrast with `setForProjectMember`, which derives the persisted and
 * audited org from `project.organizationId`).
 */
export const listForProjectProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_MEMBERS_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/function-tags",
		tags: ["Function Tags"],
		summary: "List project member function tags",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			members: z.array(
				z.object({
					userId: z.string(),
					functionTags: FunctionTagSchema.array(),
				}),
			),
		}),
	)
	.handler(async ({ input, context }) => {
		// `hasProjectAccess` is project-authoritative (ownership or an active
		// membership) and ignores its org argument, so it is omitted — the
		// org-role permission fallback alone must not grant read access to a
		// project the caller isn't a member of.
		const hasAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const roster = await getProjectMemberFunctionTags(input.projectId);
		return {
			members: roster.map((r) => ({
				userId: r.userId,
				functionTags: r.tags,
			})),
		};
	});
