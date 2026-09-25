import { ORPCError } from "@orpc/client";
import type { Permission } from "@repo/permissions";
import type { EffectiveProjectAccess } from "../../../../lib/effective-project-permissions";
import { resolveEffectiveProjectPermissions } from "../../../../lib/effective-project-permissions";

/**
 * The organization that HOSTS a project, resolved server-side, plus what the
 * same resolution already knows about the caller's permissions — for a
 * handler that answers differently per permission (the repository-sync `get`
 * decides what to show a configurer without a second lookup). Authorization
 * itself stays in the procedure's middleware; this only
 * decides which organization the handler acts in and what it may show.
 *
 * Every coding-instructions procedure is project-scoped, so the only
 * organization any of them may act in is the project's own. That is NOT what
 * `resolveOrganizationId` answers: it returns an explicit caller-supplied
 * `organizationId` verbatim and otherwise falls back to the session's active
 * organization (`packages/api/orpc/procedures.ts`). Neither value is the
 * project's host org for a caller who belongs to more than one, and the
 * `requireProjectPermission` middleware does not publish the org it resolved
 * onto the context, so a handler cannot read it back.
 *
 * The observable bug that closes: a multi-organization member begins an
 * upload for a project in organization A (`begin` already derives the host
 * org this way), then `createUploadUrls` resolves their ACTIVE organization
 * B, the tenant-scoped snapshot lookup misses, and the call 404s — with a
 * RECEIVING snapshot stranded and no way to finish it. Every sibling
 * procedure had the same shape, the read paths simply failing closed instead
 * of stranding a row.
 *
 * This is the SAME resolver `requireProjectPermission` ran for this caller a
 * moment ago (`lib/effective-project-permissions.ts`), so it does not itself
 * narrow who may call anything: it admits an organization-role admin with no
 * ProjectMember row, whom an object-level check would refuse. It only decides
 * which organization the handler acts in. Who gets that far is the
 * procedure's middleware: the permission guard, and on the repository-sync
 * and proposal procedures `projectNotFoundUnlessVisible` ahead of it, which
 * refuses that admin (Fizzy #2727).
 *
 * Throws FORBIDDEN for a personal project (`organizationId: null`): an
 * organization is the only tenant context coding instructions support, and
 * the null arm is fail-closed, never a second tenancy branch.
 */
export async function resolveHostingOrganizationAccess(
	projectId: string,
	userId: string,
): Promise<{
	organizationId: string;
	permissions: readonly Permission[];
	source: EffectiveProjectAccess["source"];
}> {
	const access = await resolveEffectiveProjectPermissions(projectId, userId);
	const organizationId = access?.organizationId ?? null;
	if (!access || !organizationId) {
		throw new ORPCError("FORBIDDEN", {
			message: "Coding instructions require an organization project",
		});
	}
	return {
		organizationId,
		permissions: access.permissions,
		source: access.source,
	};
}

/**
 * Just the organization id from `resolveHostingOrganizationAccess`, for the
 * handlers that don't need the caller's permission set alongside it.
 */
export async function requireHostingOrganizationId(
	projectId: string,
	userId: string,
): Promise<string> {
	return (await resolveHostingOrganizationAccess(projectId, userId))
		.organizationId;
}
