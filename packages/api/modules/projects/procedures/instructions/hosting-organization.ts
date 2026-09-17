import { ORPCError } from "@orpc/client";
import { resolveEffectiveProjectPermissions } from "../../../../lib/effective-project-permissions";

/**
 * The organization that HOSTS a project, resolved server-side.
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
 * moment ago (`lib/effective-project-permissions.ts`), so it cannot narrow
 * who may call anything — including an organization-role admin with no
 * ProjectMember row, whom an object-level check would refuse. It only decides
 * which organization the handler acts in. The permission guard stays where it
 * is; this answers a different question.
 *
 * Throws FORBIDDEN for a personal project (`organizationId: null`): an
 * organization is the only tenant context coding instructions support, and
 * the null arm is fail-closed, never a second tenancy branch.
 */
export async function requireHostingOrganizationId(
	projectId: string,
	userId: string,
): Promise<string> {
	const access = await resolveEffectiveProjectPermissions(projectId, userId);
	const organizationId = access?.organizationId ?? null;
	if (!organizationId) {
		throw new ORPCError("FORBIDDEN", {
			message: "Coding instructions require an organization project",
		});
	}
	return organizationId;
}
