import { ORPCError } from "@orpc/client";
import {
	getMyProjectFunctionTagStatus,
	hasProjectAccess,
} from "@repo/database";
import { FunctionTagSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import { tenantProtectedProcedure } from "../../../orpc/procedures";

/**
 * The caller's own role-confirmation status on one project (Fizzy #2264,
 * AC6-AC10).
 *
 * SELF-SERVICE: gated on `hasProjectAccess` alone, deliberately not on
 * `PROJECT_MEMBERS_READ`. This procedure returns the caller's own row and
 * nothing else, so no permission key is a meaningful gate on it; the boundary
 * is `hasProjectAccess` plus the absence of a `userId` input.
 *
 * Not because `PROJECT_MEMBERS_READ` is an administrator's key — it is not. It
 * lives in the VIEWER org and VIEWER project blocks in
 * `packages/permissions/lib/roles.ts` and every higher role inherits it.
 * Declaring it is avoided because nobody has verified that every caller who
 * passes `hasProjectAccess` also holds it (owner-sourced access, and
 * `ProjectMember` rows with a null role, are the open cases), not because it
 * would lock members out.
 *
 * Not gated on `ROLE_TAG_ENFORCEMENT`. The flag governs the prompts, not the
 * data — the card's rollback note asks for enforcement to be disabled "without
 * reverting the underlying role-tag data model".
 */
export const getMyProjectStatusProcedure = tenantProtectedProcedure
	.route({
		method: "GET",
		path: "/projects/:projectId/function-tags/me",
		tags: ["Function Tags"],
		summary: "Get my role confirmation status on a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	// `FunctionTagSchema.array()`, never `z.array(FunctionTagSchema)`: the
	// schema comes from @repo/database's own zod instance, pinned to a
	// different minor than @repo/api's, and the cross-instance combinator
	// fails `tsc` on a `_zod.version.minor` branding mismatch.
	.output(
		z.object({
			confirmed: z.boolean(),
			tags: FunctionTagSchema.array(),
			defaultTags: FunctionTagSchema.array(),
			version: z.number().nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		// `hasProjectAccess` is project-authoritative (ownership or an active
		// membership) and ignores its org argument — same reasoning as
		// `list-for-project.ts:45-52`.
		const hasAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		return getMyProjectFunctionTagStatus(input.projectId, context.user.id);
	});
