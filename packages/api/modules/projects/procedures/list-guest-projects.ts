import { listGuestProjects } from "@repo/database";
import { protectedProcedure } from "../../../orpc/procedures";

/**
 * List "Shared with me" projects: org-context projects where the caller is a
 * project-scoped guest (accepted, unexpired ProjectMember row on the project,
 * no Member row in the host organization).
 *
 * Uses `protectedProcedure` (session-keyed, NOT tenant-scoped) because this
 * is a cross-org personal surface — guests by definition hold no membership
 * in the host orgs and would fail any org permission check against them.
 * Authorization is row-level: `listGuestProjects` only returns projects the
 * caller's own accepted memberships grant access to.
 * Exempted from permission-coverage.test via the explicit allowlist.
 */
export const listGuestProjectsProcedure = protectedProcedure
	.route({
		method: "GET",
		path: "/projects/shared",
		tags: ["Projects"],
		summary: "List shared (guest) projects",
		description:
			"List organization projects shared with the authenticated user as a project-scoped guest",
	})
	.handler(async ({ context }) => {
		const projects = await listGuestProjects(context.user.id);
		return { projects };
	});
