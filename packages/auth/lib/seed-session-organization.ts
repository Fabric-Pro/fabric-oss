/**
 * Give a freshly created session the organization it runs in.
 *
 * ## Why this exists
 *
 * `session.activeOrganizationId` was only ever written by an explicit
 * organization switch. A user who signed in and never switched carried none —
 * read off the session rows of a running deployment, not inferred — so
 * everything that falls back to that field fell back to nothing.
 *
 * "Nothing" used to mean personal context, and that made it harmless. With
 * personal context gone it means nowhere, and a permission check with no tenant
 * to evaluate against is not a check: `requireInputOrgPermission` took its
 * pass-through branch and the role was never examined.
 *
 * ## Two mount points, one rule
 *
 * The row and the signed session cookie are produced inside one request body,
 * and Better Auth drains `session.create.after` hooks AFTER that body returns.
 * Seeding only from there wrote the organization to the row while the cookie
 * the API reads still carried none. `seedSessionOrganizationOnCreate` is the
 * create-time path: it returns the patch that shapes the row about to be
 * written, so one write produces a row and a cookie that agree.
 *
 * It cannot be the only path. The create-time hook runs strictly ahead of
 * invitation reconciliation and organization creation, so a new signup or an
 * invited person's first sign-in has no membership yet when it fires.
 * `seedSessionOrganization` stays mounted on the after-hook as the idempotent
 * catch for exactly that case, and the never-overwrite rule below is what
 * keeps the two mounts from writing twice.
 *
 * ## What it does not do
 *
 * This is a DEFAULT, not a context authority. Organization context stays
 * URL-driven, which is what keeps two browser tabs from fighting over this
 * single last-write-wins value; seeding it at sign-in cannot cause that fight,
 * because it happens once, before any tab has an opinion.
 *
 * It also never overwrites a value that is already there — a session that
 * arrives with one has already been placed deliberately.
 *
 * ## Fail-closed
 *
 * The shared resolver returns an organization only when the choice is
 * unambiguous: the last-active one if it is still a membership, or the only
 * membership there is. A caller with several and no last-active keeps a null
 * session rather than being silently placed in whichever sorts first — the same
 * rule the protocol servers apply, and for the same reason.
 */

import { db, resolveUserOrganization } from "@repo/database";
import { logger } from "@repo/logs";

/**
 * The organization this session should be given, or null when it should be
 * left alone — because one is already set, because the choice is ambiguous, or
 * because the caller belongs nowhere yet.
 *
 * Never throws. Both mount points depend on that: the create-time one runs
 * inside the session-creation path, where a throw costs the sign-in rather
 * than a background log line.
 */
async function resolveSeedOrganizationId(session: {
	userId: string;
	activeOrganizationId?: string | null;
}): Promise<string | null> {
	if (session.activeOrganizationId) {
		return null;
	}

	try {
		const resolution = await resolveUserOrganization(session.userId);
		return resolution.kind === "resolved"
			? resolution.organizationId
			: null;
	} catch (error) {
		logger.error("[Auth] Failed to resolve the session's organization", {
			userId: session.userId,
			error: String(error),
		});
		return null;
	}
}

/**
 * The create-time path, for `databaseHooks.session.create.before`.
 *
 * Returns the patch Better Auth merges into the row it is about to create, so
 * the row and the signed session cookie carry the organization from the same
 * write. Returns `undefined` when there is nothing to seed.
 *
 * The return values are a contract with the library, not a style choice, and
 * all three were read in the installed `db/with-hooks.mjs`:
 *
 *  - Only a `{ data }`-shaped return is merged. Returning the session object
 *    itself is silently ignored, which would ship this as a no-op.
 *  - A literal `false` ABORTS session creation. It is the one return value
 *    that can fail a sign-in, so this never returns it.
 *  - `undefined`, not `null`. The merge is guarded by
 *    `typeof result === "object" && "data" in result`, and `typeof null` is
 *    `"object"` — a `null` return would throw on the `in` check, inside the
 *    creation path, and take the sign-in with it.
 *  - `session.create.after` is handed the row this patch was already merged
 *    into, not the pre-merge data. That is what makes the dual mount safe:
 *    `seedSessionOrganization` below sees the workspace already set and leaves
 *    it alone, so the two paths write once between them rather than twice.
 *
 * None of the three failure shapes above can escape this function: it catches
 * its own errors and returns `undefined`, so the contract with the library
 * holds even when resolution fails.
 *
 * STANDING RISK, not introduced here: the resolution has no deadline, and a
 * catch cannot rescue a promise that never settles. Mounting this on the
 * create-time hook does NOT newly expose a sign-in to that, though it is the
 * obvious first reading. `runWithAdapter` wraps the whole request handler
 * (`better-auth/dist/auth/base.mjs`), and the after-hook drain runs inside the
 * promise it returns (`@better-auth/core/dist/context/transaction.mjs`) — so a
 * hung resolver in the after-hook already withheld the response before this
 * change. What changed is arithmetic, not kind: an account whose membership is
 * created mid-request now resolves twice rather than once. Giving the
 * resolution a bounded, cancellable deadline is worth doing and belongs in its
 * own change, where the auth critical path can be reviewed on its own terms.
 *
 * `activeOrganizationId` is declared `input: false` on the session model, but
 * that guard lives in `parseInputData`, which parses request bodies from the
 * wire. `createSession` hands its data straight to `createWithHooks`, and the
 * adapter's `transformInput` never consults the flag — so a hook may merge it.
 */
export async function seedSessionOrganizationOnCreate(session: {
	userId: string;
	activeOrganizationId?: string | null;
}): Promise<{ data: { activeOrganizationId: string } } | undefined> {
	const organizationId = await resolveSeedOrganizationId(session);
	return organizationId
		? { data: { activeOrganizationId: organizationId } }
		: undefined;
}

/**
 * The row-update path, for `databaseHooks.session.create.after`.
 *
 * Returns the organization the session was given, or null when it was left
 * alone. A session the create-time path already seeded arrives here with one
 * set and is left alone, so the dual mount never writes twice.
 *
 * Never throws. A sign-in must not fail over a default, and a null session
 * organization is the state every session was in before this existed.
 */
export async function seedSessionOrganization(session: {
	id: string;
	userId: string;
	activeOrganizationId?: string | null;
}): Promise<string | null> {
	const organizationId = await resolveSeedOrganizationId(session);
	if (!organizationId) {
		return null;
	}

	try {
		await db.session.update({
			where: { id: session.id },
			data: { activeOrganizationId: organizationId },
		});

		return organizationId;
	} catch (error) {
		logger.error("[Auth] Failed to seed the session's organization", {
			userId: session.userId,
			error: String(error),
		});
		return null;
	}
}
