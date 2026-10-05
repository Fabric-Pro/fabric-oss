/**
 * The organization a plan- or execution-scoped weave procedure runs in.
 *
 * Those procedures name a plan or an execution, not a project, so they resolve
 * the caller's organization and load the row BEFORE they can authorize the
 * project (`assertProjectPermission` in the handler). The organization they
 * resolved first is therefore not one the permission check ever looked at, and
 * a row stamped with a different organization than its project's — which the
 * pre-binding `create-plan` allowed — would carry that organization into an
 * execution, a template or a background generation run on its AI provider.
 *
 * So the row is loaded by id and creator ONLY — never filtered by the
 * organization the input named, which a guest sends as `null` and a member
 * may send as their session's — and once its project is authorized:
 *  - an input organization that names a different organization than the
 *    authorized project's is refused (BAD_REQUEST, the resolvers' rule);
 *  - a row whose stored organization differs from the authorized project's is
 *    refused, before anything is written or started;
 *  - a row with NO stored organization is accepted: plans a project guest
 *    created before the authorized-project binding were stamped `null` (the
 *    plain protected builder had no tenant context to route them), and a null
 *    selects nobody's provider;
 *  - everything after uses the authorized project's organization, never the
 *    one resolved from the input.
 */

import { ORPCError } from "@orpc/server";
import {
	type AuthorizedProject,
	projectWithoutOrganizationError,
} from "../../../lib/authorized-project-binding";

/**
 * Refuse an input organization, or a row stamped with an organization, other
 * than its authorized project's. For procedures that consume no organization afterwards (reads,
 * approvals, deletes): a project with no organization is not refused here.
 */
export function assertRowInAuthorizedOrganization(
	inputOrganizationId: string | null | undefined,
	row: { organizationId: string | null },
	authorized: AuthorizedProject,
): void {
	if (
		inputOrganizationId &&
		inputOrganizationId !== authorized.organizationId
	) {
		throw new ORPCError("BAD_REQUEST", {
			message: "organizationId does not match the project",
		});
	}
	if (
		row.organizationId != null &&
		row.organizationId !== authorized.organizationId
	) {
		throw new ORPCError("FORBIDDEN", {
			message: "This plan does not belong to its project's organization",
		});
	}
}

/**
 * {@link assertRowInAuthorizedOrganization}, then the authorized project's
 * organization for a procedure that consumes one (stamps it on a row, or hands
 * it to an AI provider or a workflow). A project with no organization is
 * refused (ADR-018), the same refusal as `requireProjectOrganization`.
 */
export function requireAuthorizedRowOrganization(
	inputOrganizationId: string | null | undefined,
	row: { organizationId: string | null },
	authorized: AuthorizedProject,
): string {
	assertRowInAuthorizedOrganization(inputOrganizationId, row, authorized);
	if (!authorized.organizationId) {
		throw projectWithoutOrganizationError();
	}
	return authorized.organizationId;
}
