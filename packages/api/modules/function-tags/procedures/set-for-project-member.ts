import { ORPCError } from "@orpc/client";
import {
	db,
	hasProjectAccess,
	upsertProjectUserFunctionTags,
} from "@repo/database";
import { FunctionTagSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Set a project member's function tags. `PROJECT_MEMBERS_MANAGE` gates it,
 * mirroring `update-member-role.ts`.
 *
 * Tenancy (both the persisted row and the audit row) is derived ONLY from
 * `project.organizationId` — never from the session's active org or a
 * client-supplied `organizationId` — so an actor acting on this project
 * while a different org is active in their session never misfiles the
 * write or the audit trail into that other org (Codex plan finding).
 */
export const setForProjectMemberProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_MEMBERS_MANAGE))
	.route({
		method: "PUT",
		path: "/projects/:projectId/members/:userId/function-tags",
		tags: ["Function Tags"],
		summary: "Set a member's function tags",
	})
	.input(
		z.object({
			projectId: z.string(),
			userId: z.string(),
			tags: FunctionTagSchema.array(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(z.object({ success: z.boolean(), tags: FunctionTagSchema.array() }))
	.handler(async ({ input, context }) => {
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { userId: true, organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		// Defense-in-depth: `requireProjectPermission` grants org admins this
		// permission via the org-role fallback even without project access, but
		// member operations require ACTUAL project access (ownership or an active
		// membership) — mirror the read path (`listForProject` / `list-members.ts`).
		const hasAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Persisted tenancy is project-derived; reject a disagreeing supplied
		// org rather than silently overriding it.
		if (
			input.organizationId !== undefined &&
			input.organizationId !== null &&
			input.organizationId !== project.organizationId
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: "organizationId does not match the project",
			});
		}

		// Target must be the creator or an accepted, unexpired member.
		let validTarget = project.userId === input.userId;
		if (!validTarget) {
			const member = await db.projectMember.findUnique({
				where: {
					projectId_userId: {
						projectId: input.projectId,
						userId: input.userId,
					},
				},
				select: { acceptedAt: true, expiresAt: true },
			});
			validTarget =
				!!member &&
				member.acceptedAt !== null &&
				(member.expiresAt === null || member.expiresAt > new Date());
		}
		if (!validTarget) {
			throw new ORPCError("NOT_FOUND", {
				message: "Member not found on this project",
			});
		}

		const tags = [...new Set(input.tags)];
		const { changed } = await upsertProjectUserFunctionTags({
			projectId: input.projectId,
			userId: input.userId,
			organizationId: project.organizationId,
			tags,
		});

		// Audit only a real change (Fizzy #2264). The write skips entirely when
		// the normalized tag SET and the org both already match, so firing this
		// unconditionally would record `…function_tags_changed` — an action
		// whose name asserts a change in the past tense — for an admin who
		// opened the dialog and saved the same tags. Nothing was written, and a
		// trail that reports changes that did not happen is worse than one row
		// short: it makes every row in it a question.
		//
		// Audit tenancy is PROJECT-derived, not session-derived — otherwise an
		// actor acting on this project while a different org is active would
		// misfile the trail (and leak the target user + tags) into that
		// other org's audit view.
		if (changed) {
			recordAuditFromRequest(context, {
				action: "project.member.function_tags_changed",
				category: "project",
				organizationId: project.organizationId,
				projectId: input.projectId,
				resource: { type: "user", id: input.userId, name: null },
				metadata: { tags },
			});
		}

		// `success: true` either way, deliberately: nothing failed, and the
		// member's tags are exactly what the admin asked for. A no-op is not an
		// error and must not surface to the client as one.
		return { success: true, tags };
	});
