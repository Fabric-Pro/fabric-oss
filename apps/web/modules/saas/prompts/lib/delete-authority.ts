/**
 * Whether this viewer may delete this prompt — the one rule every listing
 * surface asks (Fizzy #2328, R1/R4).
 *
 * Three surfaces render a Delete control today and each decided for itself with
 * `prompt.scope !== "SYSTEM"`, which is why a platform administrator with every
 * right to remove a SYSTEM prompt was never offered the control the API would
 * have honoured. One predicate, asked by all three, is what stops them
 * disagreeing again.
 *
 * This is an AFFORDANCE, never a boundary (KTD2). The server still enforces
 * deletion in `packages/api/modules/prompts/procedures/delete.ts`; nothing there
 * is relaxed because this agreed. The contract that matters is the direction of
 * the error: this predicate must never be MORE permissive than the server, so a
 * control it offers is always one the server would honour. It is deliberately
 * stricter in exactly one place, marked below.
 *
 * "The server" is TWO things on every branch, and reading only the handler is
 * how this predicate went wrong once already: `requirePermission(PROMPT_DELETE)`
 * runs in front of the handler and is evaluated against the caller's active
 * organization role, so a branch that checks only what the handler checks —
 * ownership, say — offers a control the middleware refuses before the handler
 * ever sees it. Every branch below therefore asks both questions.
 *
 * The branch order mirrors the server's handler — SYSTEM, then ORG, then USER —
 * so a reviewer can diff the two by eye. Keep it that way.
 */

/**
 * The global (platform) role that the server's SYSTEM branch checks, read the
 * same way `PromptDetails.tsx` reads it: `user?.role === "admin"` from the
 * session.
 */
const GLOBAL_ADMIN_ROLE = "admin";

/**
 * Organization roles carrying `PROMPT_DELETE` in
 * `packages/permissions/lib/roles.ts` — `admin` holds it directly and `owner`
 * inherits the admin set.
 *
 * Spelled out here rather than imported: `@repo/permissions` is not a
 * dependency of `apps/web`, and adding one so the browser can re-derive a
 * two-element list is a heavier change than the list is worth. If the roles
 * that carry `PROMPT_DELETE` ever change, this is the line that has to move
 * with them — the truth table in
 * `apps/web/__tests__/modules/saas/prompts/DeleteAuthority.test.ts` is the
 * tripwire.
 */
const ORG_ROLES_GRANTING_PROMPT_DELETE: readonly string[] = ["admin", "owner"];

function organizationRoleGrantsPromptDelete(
	role: string | null | undefined,
): boolean {
	return role != null && ORG_ROLES_GRANTING_PROMPT_DELETE.includes(role);
}

/**
 * The prompt being judged. `organizationId` and `userId` are required rather
 * than optional on purpose: a surface that cannot say who owns the prompt
 * cannot be told it may be deleted, and a missing field should be a type error
 * at the call site rather than a silently withheld control.
 */
type DeletablePrompt = {
	/**
	 * "SYSTEM", "ORG" or "USER". Widened to `string` so a surface holding the
	 * scope as plain text can ask without a cast; an unrecognised value is
	 * refused below.
	 */
	scope: string;
	/** The owning organization for an ORG prompt; null for SYSTEM and USER. */
	organizationId: string | null;
	/** The owning user for a USER prompt; null for SYSTEM and ORG. */
	userId: string | null;
};

/**
 * The viewer. Every field is nullable because the session and the active
 * organization both load asynchronously — while either is absent the answer is
 * simply "not yet", never a throw.
 */
type PromptDeleteViewer = {
	/** The signed-in user's id (`useSession().user?.id`). */
	userId: string | null | undefined;
	/** The global role (`useSession().user?.role`) — "admin" or otherwise. */
	globalRole: string | null | undefined;
	/** The active organization's id, or null outside one. */
	organizationId: string | null | undefined;
	/**
	 * The viewer's role in the ACTIVE organization
	 * (`useActiveOrganization().activeOrganizationUserRole`).
	 *
	 * Not `isOrganizationAdmin` — that helper (`packages/auth/lib/helper.ts`)
	 * returns true for any global admin regardless of membership, which would
	 * collapse the two SYSTEM gates below into one and offer Delete to a
	 * platform admin who is an ordinary member here. The server would refuse
	 * that click.
	 */
	organizationRole: string | null | undefined;
};

export function canDeletePrompt({
	prompt,
	viewer,
}: {
	prompt: DeletablePrompt;
	viewer: PromptDeleteViewer;
}): boolean {
	if (prompt.scope === "SYSTEM") {
		// The handler's own check: only a platform administrator.
		if (viewer.globalRole !== GLOBAL_ADMIN_ROLE) {
			return false;
		}

		// And the `requirePermission(Permissions.PROMPT_DELETE)` middleware
		// standing in front of it, which resolves the permission from the
		// caller's active organization role.
		//
		// DELIBERATE DIVERGENCE — do not "fix" this toward the server. With no
		// active organization the middleware returns early (its personal-context
		// pass-through) and the server would allow the delete; this predicate
		// returns false instead. Per
		// `docs/adr/018-organization-is-the-only-tenant-context.md` an absent
		// organization is a fail-closed default reached only when something
		// failed to resolve one, not a context to offer a platform-wide
		// destructive action from. Withholding the control there costs an
		// administrator one organization switch; offering it on an unresolved
		// context is how a SYSTEM prompt gets deleted from a state nobody meant
		// to be in. Pinned as an explicit row in DeleteAuthority.test.ts.
		return organizationRoleGrantsPromptDelete(viewer.organizationRole);
	}

	if (prompt.scope === "ORG") {
		// The server refuses an ORG prompt with no organization outright.
		if (!prompt.organizationId) {
			return false;
		}

		// The server verifies membership of the PROMPT's organization, which
		// may be any organization the caller belongs to. The client only knows
		// the viewer's role in the ACTIVE one, so a prompt belonging to another
		// organization gets no affordance — stricter than the server, and the
		// listing surfaces only ever render the active organization's prompts
		// anyway.
		if (prompt.organizationId !== viewer.organizationId) {
			return false;
		}

		return organizationRoleGrantsPromptDelete(viewer.organizationRole);
	}

	if (prompt.scope === "USER") {
		// The handler's own check: only the owner.
		if (
			prompt.userId == null ||
			viewer.userId == null ||
			prompt.userId !== viewer.userId
		) {
			return false;
		}

		// And, again, the `requirePermission(Permissions.PROMPT_DELETE)`
		// middleware in front of the handler — which does not care whose prompt
		// it is. It resolves the permission from the caller's ACTIVE
		// ORGANIZATION role, and `MEMBER_ORG_PERMISSIONS` in
		// `packages/permissions/lib/roles.ts` does not carry `PROMPT_DELETE`;
		// it first appears in `ADMIN_ORG_PERMISSIONS`. So an organization
		// member who owns a USER prompt is refused with FORBIDDEN by the
		// server, and offering them the control was offering a click that could
		// not work.
		//
		// In personal context there is nothing to evaluate: the middleware
		// returns early with no tenant context and the server allows the
		// deletion, so the owner keeps the control.
		if (viewer.organizationId == null) {
			return true;
		}

		return organizationRoleGrantsPromptDelete(viewer.organizationRole);
	}

	// A scope this predicate does not recognise. Refusing is the only safe
	// answer for a destructive control it cannot justify. The server closes
	// the same hole from the other side — `assertPromptDeleteAuthority` ends
	// in a FORBIDDEN throw rather than returning, which it did not when this
	// predicate first landed. Both sides now refuse an unknown scope.
	return false;
}
