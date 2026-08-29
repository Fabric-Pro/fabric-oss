/**
 * Daily Brief — List Release-Note Exclusions Procedure (Fizzy 1869 follow-up).
 *
 * Returns the project's current release-notes exclusions (by PR or story
 * identifier) so the settings UI can render and manage the hide list.
 *
 * **Editor-only** (`PROJECT_SETTINGS_EDIT`, not `PROJECT_READ`): the list
 * exposes hidden-target identities (repo/PR numbers, story identifiers,
 * reasons) — the same information a reader would otherwise be prevented from
 * recovering, since a hidden PR/story is by definition absent from the
 * regular release-notes panel a `PROJECT_READ` caller sees. Mirrors the
 * hide/unhide gate exactly.
 *
 * Tenant safety: the org is resolved from the session and the project is
 * re-fetched under the resolved tenant scope, so a foreign-tenant caller
 * gets NOT_FOUND and the query's tenant columns are derived from the
 * VERIFIED project (never raw input).
 */
import { ORPCError } from "@orpc/server";
import { db, listReleaseNoteExclusions } from "@repo/database";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const listReleaseNoteExclusionsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(inputSchema)
	.handler(async ({ input }) => {
		// `requireProjectPermission` above has already authorized this caller for
		// THIS project — as owner, active ProjectMember, or via an org role. Load
		// the project by id and take the tenant from the loaded row;
		// `input.organizationId` is a guard, never a scoping key.
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { id: true, organizationId: true, userId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		assertInputOrgMatchesProject(input.organizationId, project);

		const tenant = {
			projectId: project.id,
			organizationId: project.organizationId ?? null,
			userId: project.userId,
		};

		return listReleaseNoteExclusions(db, tenant);
	});
