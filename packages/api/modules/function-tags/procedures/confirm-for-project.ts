import { ORPCError } from "@orpc/client";
import {
	confirmProjectUserFunctionTags,
	db,
	hasProjectAccess,
} from "@repo/database";
import { FunctionTagSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import { tenantProtectedProcedure } from "../../../orpc/procedures";

/**
 * Record the caller's confirmation of their OWN role on a project (Fizzy
 * #2264, AC8-AC10).
 *
 * Writes the caller's own row only: `userId` comes from `context.user.id` and
 * is never accepted from the client — there is no such input field.
 *
 * Tenancy is derived solely from `project.organizationId`, never from the
 * session's active org or a client-supplied value, matching
 * `setForProjectMember`. A disagreeing supplied `organizationId` is rejected,
 * not overridden.
 *
 * The write is conditional on `expectedVersion` (spec §5.7). A prompt can sit
 * open for minutes; in that window an admin can change the member's tags,
 * which by design clears their confirmation. An unconditional write would put
 * the prompt's stale tags back, mark them confirmed, and silently revert the
 * admin — success toast and all.
 *
 * FR9: an audit row is not a notification. Nothing here emits one.
 */
export const confirmForProjectProcedure = tenantProtectedProcedure
	.route({
		method: "POST",
		path: "/projects/:projectId/function-tags/me/confirm",
		tags: ["Function Tags"],
		summary: "Confirm my role on a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			tags: FunctionTagSchema.array(),
			expectedVersion: z.number().int().nullable(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	// `version` is the row's NEW `confirmationVersion`. It rides back so the
	// client can patch its cached status exactly instead of waiting on a
	// refetch that may fail — see the prompt's `onSuccess`.
	.output(
		z.object({
			success: z.boolean(),
			tags: FunctionTagSchema.array(),
			version: z.number(),
		}),
	)
	.handler(async ({ input, context }) => {
		// Access check FIRST, before the project is looked up. Reversed, this
		// handler answers two different codes for the same question — NOT_FOUND
		// for an id that does not exist, FORBIDDEN for one that does but is not
		// yours — which makes it a project-existence oracle for every
		// authenticated user. `setForProjectMember` has the same handler
		// ordering and leaks nothing only because `requireProjectPermission`
		// fires ahead of it; this procedure has no permission middleware, so
		// the ordering is load-bearing here. `hasProjectAccess` returns false
		// for a nonexistent project, so both cases land on the same FORBIDDEN,
		// matching the sibling `getMyProjectStatus`.
		const hasAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		if (
			input.organizationId !== undefined &&
			input.organizationId !== null &&
			input.organizationId !== project.organizationId
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: "organizationId does not match the project",
			});
		}

		const tags = [...new Set(input.tags)];
		if (tags.length === 0) {
			// The §5.8 floor. A confirmed-but-empty tag set is the precise
			// state this card exists to prevent: the member is never prompted
			// again and holds no role. Checked here rather than in the input
			// schema so the failure has a stable code and message a test can
			// pin, and so it never depends on cross-zod-instance refinements.
			throw new ORPCError("BAD_REQUEST", {
				message: "Pick at least one role to confirm",
			});
		}

		// `organizationId` MUST come from the project row, never from ambient
		// session context. On the create path the query layer stamps whatever
		// it is handed with no derivation of its own — there is no prior row to
		// inherit from — so a member confirming on a project that has no row yet
		// would create one under the wrong tenant: visible under that org's RLS
		// context and invisible under the right one. The admin procedure derives
		// it the same way and rejects a disagreeing supplied value; this must
		// match. No query-layer test can catch a mistake here, because the query
		// layer never reads the project.
		const result = await confirmProjectUserFunctionTags({
			projectId: input.projectId,
			userId: context.user.id,
			organizationId: project.organizationId,
			tags,
			expectedVersion: input.expectedVersion,
		});

		if (result.outcome === "conflict") {
			throw new ORPCError("CONFLICT", {
				message:
					"Your role on this project changed while this was open. Review the updated roles and confirm again.",
			});
		}

		// Audit tenancy is PROJECT-derived, not session-derived — otherwise an
		// actor acting on this project while a different org is active would
		// misfile the trail into that other org's audit view.
		recordAuditFromRequest(context, {
			action: "project.member.function_tags_confirmed",
			category: "project",
			organizationId: project.organizationId,
			projectId: input.projectId,
			resource: { type: "user", id: context.user.id, name: null },
			// `previousTags` matters because this procedure is a MEMBER-authored
			// write to the same column the admin path writes behind
			// PROJECT_MEMBERS_MANAGE. The version token guards staleness, not
			// authority: on CONFLICT the prompt refetches and the member may
			// then confirm something else, which succeeds. That is AC9 working
			// as specified — but without the previous value the trail cannot
			// tell "accepted what the administrator set" from "replaced it",
			// and those are the two cases anyone reading this row cares about.
			metadata: { tags, previousTags: result.previousTags },
		});

		return {
			success: true,
			tags: result.tags,
			version: result.version,
		};
	});
