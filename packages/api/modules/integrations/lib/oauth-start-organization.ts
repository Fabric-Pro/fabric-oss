/**
 * The organization an integration OAuth flow must be started from.
 *
 * Integration OAuth has no personal arm: under
 * `docs/adr/018-organization-is-the-only-tenant-context.md` a request that
 * resolves no organization has FAILED to resolve one, and a state minted
 * without one would have the callback store the provider token in an
 * organization-less row no tenant can see or revoke. The `start` procedures
 * therefore mount `requireInputOrgPermission(..., { requireOrganization: true })`,
 * which refuses an explicit `organizationId: null` — and a session with no
 * active organization — before the handler runs.
 *
 * This assertion is the handler's own copy of that rule, called after the
 * caller's organization has been resolved and before any state is minted. It
 * is deliberately not redundant with the middleware: a procedure-level gate
 * outlives a change to the middleware in front of it, and the narrowing it
 * provides is what lets the state carry `organizationId: string` rather than
 * `string | undefined`. The refusal carries the repo's machine-readable cause
 * for a missing workspace so a client can name it; the sentence is specific
 * to this flow so the platform-wide scan that pins the generic sentence's
 * emitters stays honest.
 */

import { ORPCError } from "@orpc/server";
import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "../../../lib/missing-organization-context";

export function assertOAuthStartOrganization(
	organizationId: string | null | undefined,
): asserts organizationId is string {
	if (!organizationId) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"An integration connection must be started from an organization",
			data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
		});
	}
}
