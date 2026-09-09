/**
 * The organization context a prompt deletion — and the platform-wide impact
 * read that precedes it — requires.
 *
 * Extracted verbatim from `procedures/delete.ts` and
 * `procedures/deletion-impact.ts`, where the identical block lived inline in
 * both, so the two are gated by ONE rule rather than two that can drift. This
 * is the same lesson `assertPromptDeleteAuthority` records beside it, applied
 * to the gate that runs before it: the first extraction generalized the
 * per-scope authority and left this block copied, and a copied gate is two
 * places one relaxation has to be caught. The impact read is un-scoped across
 * every tenant and the deletion reaches every tenant's bindings — the write
 * must never end up the laxer of the two, and the only way to keep that true is
 * to ask the same function.
 *
 * NOT redundant with `requirePermission`, which returns `next()` without
 * evaluating any role when `tenantContext` is absent or personal: on its own it
 * waves a global admin with no active organization straight through to the most
 * destructive action in this module on the strength of the per-scope check
 * alone. Under `docs/adr/018-organization-is-the-only-tenant-context.md` a
 * session with no organization means resolution FAILED — not that personal
 * context was chosen — and neither a cross-tenant read nor a cross-tenant
 * delete is a capability worth offering from that state.
 *
 * Nor is it redundant with the tenant-context middleware, which refuses the
 * same condition further out. That layering is deliberate rather than
 * accidental: a procedure-level gate that outlives a change to the boundary
 * cannot be quietly widened by one, and these procedures must never be laxer
 * than the middleware in front of them.
 *
 * Call it FIRST in a handler, before any read: a caller with no organization
 * has no business learning that a prompt id exists. The refusal carries a
 * machine-readable cause so a client can name it — the sentence is not a
 * contract, the code is — and it is safe to act on precisely because the gate
 * runs before anything else: nothing has happened when it is raised.
 *
 * Throws on refusal and returns nothing on success, so a caller cannot forget
 * to check a boolean. The assertion signature is what leaves the caller holding
 * a non-null `organizationId` afterwards, which matters because an audit row
 * written with `undefined` there lands with `organizationId: null` and is
 * unreachable from every tenant's audit view.
 */

import { ORPCError } from "@orpc/server";
import type { TenantContext } from "@repo/database";
import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "../../../lib/missing-organization-context";

/** A tenant context that actually resolved a workspace. */
type OrganizationTenantContext = TenantContext & {
	type: "organization";
	organizationId: string;
};

export function assertOrganizationContext(
	tenantContext: TenantContext | null | undefined,
): asserts tenantContext is OrganizationTenantContext {
	// Three shapes of one failure — absent entirely, resolved to something
	// other than an organization, or labelled "organization" while naming no
	// id. A caller cannot be asked to know which one the server saw, so all
	// three refuse identically.
	if (
		!tenantContext ||
		tenantContext.type !== "organization" ||
		!tenantContext.organizationId
	) {
		throw new ORPCError("FORBIDDEN", {
			message: "This operation requires an organization context",
			data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
		});
	}
}
