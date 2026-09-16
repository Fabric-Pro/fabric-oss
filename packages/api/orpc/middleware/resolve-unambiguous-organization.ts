/**
 * Give a request an organization context when the session names none and the
 * answer is not in doubt.
 *
 * ## The gap this closes
 *
 * `tenantContextMiddleware` builds its context from
 * `session.activeOrganizationId` and nothing else. That pointer is maintained
 * from the browser, and there are several ordinary ways for it to be empty on
 * a request whose page is unambiguously inside one organization: the signed
 * `session_data` cookie is a rolling snapshot, so a Prisma write cannot make a
 * repaired row visible to the API for up to five minutes; the client-side
 * alignment that CAN refresh that cookie runs once per organization and is
 * deliberately not retried after a refusal; and a bare `/app` load resolves no
 * organization at all by design, so links that redirect into an organization
 * arrive with the pointer still empty.
 *
 * Every one of those produced the same user-visible outcome on the prompt
 * deletion path: a refusal whose copy promises that reloading the page will
 * restore the workspace, in states where reloading restores nothing
 * (Fizzy #2403, QA).
 *
 * ## Why here, and not in the tenant middleware
 *
 * Because the empty arm is not always a failure. `tenantContextMiddleware`
 * leaves `organizationId` null for every procedure, and account-global
 * procedures reach that arm legitimately — their tenant filter is
 * `{ organizationId: null, userId }`, and filling the organization in there
 * would silently narrow what their callers can see across the whole
 * application. So this is opt-in: a procedure that genuinely cannot run
 * without an organization composes this, and nothing else changes.
 *
 * ## Why here, and not inside the handler
 *
 * Because `requirePermission` runs between the two, and it returns `next()`
 * WITHOUT evaluating any role when the tenant context is absent or personal.
 * A handler that resolved its own organization after that point would have
 * been waved through the permission gate first — the same deny-into-
 * pass-through shape recorded in
 * `docs/solutions/architecture-patterns/failing-closed-can-remove-the-check-that-was-containing-it.md`.
 * Resolving before the permission check means the role is evaluated against
 * the organization the request actually runs in.
 *
 * ## What it will not do
 *
 * It asks `resolveUserOrganization`, the same helper sign-in uses, so there is
 * ONE rule for "which organization does this person mean" rather than two that
 * can drift. That helper answers only when the choice is unambiguous — the
 * single membership, or the last-active one while it is still a membership —
 * and returns `ambiguous` rather than sorting and picking. This middleware
 * keeps that: an ambiguous account is left exactly as it arrived, and the
 * procedure's own gate refuses it as before. Placing someone in a tenant
 * nobody named is the failure this is careful not to introduce.
 *
 * It also re-reads the membership rather than trusting the resolution, for the
 * two facts the resolver does not carry: the caller's ROLE, which
 * `requirePermission` needs, and whether the organization has been deactivated
 * for deletion, which no request may resolve a context for (Fizzy #2462).
 */

import { ORPCError, os } from "@orpc/server";
import {
	createOrganizationContext,
	db,
	resolveUserOrganization,
	runWithTenantContext,
	type TenantContext,
} from "@repo/database";
import type { OrgRole } from "@repo/permissions";
import { DELETED_ORGANIZATION_ERROR_CODE } from "../../lib/deleted-organization";

type ResolveContext = {
	user: { id: string };
	session?: { activeOrganizationId?: string | null } | null;
	tenantContext?: TenantContext | null;
	activeOrganizationRole?: OrgRole | null;
};

export const resolveUnambiguousOrganization = os
	.$context<ResolveContext>()
	.middleware(async ({ context, next }) => {
		// Already inside an organization — the common path, and it must cost
		// nothing. Note this accepts only a context that names an id: the
		// "organization with no id" shape is one of the three failures the
		// procedure gate refuses, and repairing it here would hide it.
		if (
			context.tenantContext?.type === "organization" &&
			context.tenantContext.organizationId
		) {
			return next();
		}

		const userId = context.user.id;
		const resolution = await resolveUserOrganization(userId);

		// `ambiguous` and `no_membership` are both left alone, and they are
		// left alone for different reasons: the first is a question only the
		// caller can answer, the second has no answer at all. Neither is this
		// middleware's to guess — the procedure's gate refuses both, with the
		// machine-readable cause a client can act on.
		if (resolution.kind !== "resolved") {
			return next();
		}

		const organizationId = resolution.organizationId;

		const membership = await db.member.findUnique({
			where: {
				organizationId_userId: { organizationId, userId },
			},
			select: {
				role: true,
				organization: { select: { deletedAt: true } },
			},
		});

		// The resolver derives its answer from this person's memberships, so a
		// miss here means the row went away between the two reads. Fail closed
		// rather than resolve a workspace whose membership just vanished.
		if (!membership) {
			return next();
		}

		if (membership.organization?.deletedAt != null) {
			throw new ORPCError("FORBIDDEN", {
				message: "This organization has been deleted",
				data: { errorCode: DELETED_ORGANIZATION_ERROR_CODE },
			});
		}

		const tenantContext = createOrganizationContext(organizationId, userId);

		// Re-entering `runWithTenantContext` is the load-bearing half of this.
		// `tenantContextMiddleware` already opened one around the PERSONAL
		// context it built, and `getTenantDb()` reads that AsyncLocalStorage
		// store rather than `context.tenantContext`. Handing the chain an
		// organization context without re-entering would leave the two
		// disagreeing for the same request — auto-filtered queries scoped to
		// the caller's personal arm while the handler believes it is inside an
		// organization. That split is worse than the refusal this replaces.
		//
		// The session pointer is replaced alongside both, not instead of them:
		// `resolveOrganizationId` reads `session.activeOrganizationId` directly
		// rather than the tenant context, so leaving the session naming nothing
		// would hand the handler a context and that helper a null.
		return await runWithTenantContext(tenantContext, async () =>
			next({
				context: {
					tenantContext,
					activeOrganizationRole: membership.role as OrgRole,
					session: context.session
						? {
								...context.session,
								activeOrganizationId: organizationId,
							}
						: context.session,
				},
			}),
		);
	});
