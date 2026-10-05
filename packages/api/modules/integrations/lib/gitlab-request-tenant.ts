/**
 * The tenant a GitLab request acts in, resolved and authorized before
 * anything reads or writes the person's GitLab connection.
 *
 * A read of the connection can classify (write) a legacy
 * `WorkflowIntegration` row, and a disconnect writes one, so the tenant has
 * to be right before either runs:
 *
 *  - It is resolved the way every procedure resolves it
 *    (`resolveOrganizationId`: the input's organization, else a guest write
 *    organization set by the permission middleware this request
 *    (`effectiveWriteOrgId`), else the session's; an explicit null suppresses
 *    only the session fallback, not the guest write organization), so
 *    `gitlab.status({})` and the other
 *    GitLab surfaces agree on which organization an omitted input means.
 *  - Nothing resolved is refused, with the marked missing-organization
 *    error: under ADR-018 a request with no organization is a resolution
 *    failure, and acting on it would write a no-organization
 *    connection.
 *  - The caller must be a member of THAT organization whose role grants
 *    `permission` there. A permission middleware evaluates the session's
 *    organization, which an explicit input organization can differ from.
 *
 * All three come from `authorizeInputOrganization`, the function
 * `requireInputOrgPermission` runs, so this is the same rule, not a copy.
 */

import { ORPCError } from "@orpc/server";
import type { GitLabTenant } from "@repo/integrations/gitlab";
import type { Permission } from "@repo/permissions";
import { authorizeInputOrganization } from "../../../orpc/procedures";

export async function authorizeGitLabTenant(
	permission: Permission,
	inputOrganizationId: string | null | undefined,
	context: Parameters<typeof authorizeInputOrganization>[2] & {
		user: { id: string };
	},
): Promise<GitLabTenant & { organizationId: string }> {
	const organizationId = await authorizeInputOrganization(
		permission,
		inputOrganizationId,
		context,
		{ requireOrganization: true },
	);
	// `requireOrganization` refuses this above; this only narrows the type.
	if (!organizationId) {
		throw new ORPCError("FORBIDDEN", {
			message: "An organization is required",
		});
	}
	return { userId: context.user.id, organizationId };
}
