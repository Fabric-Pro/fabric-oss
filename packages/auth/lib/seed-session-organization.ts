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
 * Returns the organization the session was given, or null when it was left
 * alone — because one was already set, because the choice was ambiguous, or
 * because the caller belongs nowhere yet.
 *
 * Never throws. A sign-in must not fail over a default, and a null session
 * organization is the state every session was in before this existed.
 */
export async function seedSessionOrganization(session: {
	id: string;
	userId: string;
	activeOrganizationId?: string | null;
}): Promise<string | null> {
	if (session.activeOrganizationId) {
		return null;
	}

	try {
		const resolution = await resolveUserOrganization(session.userId);
		if (resolution.kind !== "resolved") {
			return null;
		}

		await db.session.update({
			where: { id: session.id },
			data: { activeOrganizationId: resolution.organizationId },
		});

		return resolution.organizationId;
	} catch (error) {
		logger.error("[Auth] Failed to seed the session's organization", {
			userId: session.userId,
			error: String(error),
		});
		return null;
	}
}
