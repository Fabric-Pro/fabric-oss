/**
 * The organization a project-scoped procedure runs in: the project row's own.
 *
 * `requireProjectPermission` (or `assertProjectPermission`) authorizes the
 * PROJECT, so the project's organization is the tenant the caller was
 * authorized in. A caller-supplied `input.organizationId` is never a
 * substitute: it can name an organization the caller has no tie to, and a
 * handler that hands it to an AI resolver, an AI token or a RAG provider would
 * run on that organization's provider key.
 *
 * A project with no organization is refused rather than served from a null
 * tenant. The organization is the only tenant context
 * (docs/adr/018-organization-is-the-only-tenant-context.md); a project row
 * without one is a resolution failure, and passing `undefined` on would select
 * the caller's personal provider and write null-tenant rows.
 *
 * The refusal sentence differs on purpose from the missing-organization-context
 * refusal (`lib/missing-organization-context.ts`): that one means the REQUEST
 * resolved no organization, which a client can fix by choosing a workspace.
 * This one means the stored project has none, which the caller cannot fix.
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import {
	peekAuthorizedProject,
	projectWithoutOrganizationError,
} from "../../../lib/authorized-project-binding";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";

/**
 * The organization id of an already-loaded project row. Throws NOT_FOUND for a
 * missing row and FORBIDDEN for a row with no organization, so a caller never
 * holds `undefined` afterwards.
 */
export function requireProjectOrganization(
	project: { organizationId: string | null } | null | undefined,
): string {
	if (!project) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}
	if (!project.organizationId) {
		throw projectWithoutOrganizationError();
	}
	return project.organizationId;
}

/** Load a project's organization id, refusing as `requireProjectOrganization`. */
export async function loadProjectOrganizationId(
	projectId: string,
): Promise<string> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true },
	});
	return requireProjectOrganization(project);
}

/**
 * The organization a project-scoped handler runs in, with the caller's
 * `input.organizationId` used only as a guard.
 *
 * For a handler that reads the input organization directly instead of through
 * `resolveOrganizationId` — the root enforcement in that resolver cannot reach
 * it. Call it at the top of the handler, BEFORE any write, dispatch or provider
 * resolution, so a mismatch leaves nothing behind:
 *
 *  - the organization comes from the project this request authorized (the
 *    binding `requireProjectPermission` records), or from the project row when
 *    the request authorized a different project or none (a handler called
 *    outside an oRPC call);
 *  - a non-null input organization that differs → BAD_REQUEST;
 *  - a project with no organization → FORBIDDEN; a missing one → NOT_FOUND.
 */
export async function resolveProjectOrganizationId(
	inputOrganizationId: string | null | undefined,
	projectId: string,
): Promise<string> {
	const authorized = peekAuthorizedProject();
	const project =
		authorized && authorized.projectId === projectId
			? authorized
			: await db.project.findUnique({
					where: { id: projectId },
					select: { organizationId: true },
				});
	// Same order as `resolveBoundOrganization`: a project with no
	// organization is refused whatever the input said.
	const organizationId = requireProjectOrganization(project);
	assertInputOrgMatchesProject(inputOrganizationId, { organizationId });
	return organizationId;
}
