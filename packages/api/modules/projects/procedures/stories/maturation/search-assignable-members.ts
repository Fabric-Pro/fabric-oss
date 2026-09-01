import { ORPCError } from "@orpc/client";
import { hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { listProjectMentionableMembers } from "../../../lib/project-mentionable-members";

/**
 * The picker opens with nothing typed, so it needs a browsable roster rather
 * than the document popover's short typeahead. Still capped — a project with
 * hundreds of members should not ship them all to the client on open.
 */
const ASSIGNEE_PICKER_LIMIT = 50;

/**
 * `maturation.searchAssignableMembers` (Fizzy #1751, AC-3) — the people who can
 * be assigned to an open question, or named in an answer.
 *
 * A question-scoped sibling of `searchMentionables`: same candidate set (project
 * owner ∪ accepted, non-expired ProjectMembers), reached without a `documentId`,
 * because a maturation question is a Decision Log row rather than a node inside
 * a document.
 *
 * Groups are deliberately absent. The document picker offers function-tag
 * groups, but AC-3 scopes assignment to project *members* — you cannot make a
 * group accountable for answering.
 */
export const searchAssignableMembersProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/{storyId}/maturation/assignable-members",
		tags: ["Projects", "Features", "Maturation"],
		summary: "Search project members assignable to an open question",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			query: z.string().max(100).default(""),
		}),
	)
	.output(
		z.object({
			members: z.array(
				z.object({
					id: z.string(),
					name: z.string().nullable(),
					email: z.string().nullable(),
					avatarUrl: z.string().nullable(),
				}),
			),
		}),
	)
	.handler(async ({ input, context }) => {
		// Never from caller input — see the note in `set-question-assignees.ts`.
		// `hasProjectAccess` ignores the org it is handed, so trusting an
		// input org would let a reachable project be paired with an
		// unreachable organization.
		const organizationId = resolveOrganizationId(
			undefined,
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

		const members = await listProjectMentionableMembers({
			projectId: input.projectId,
			query: input.query,
			limit: ASSIGNEE_PICKER_LIMIT,
		});
		if (!members) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		return { members };
	});
