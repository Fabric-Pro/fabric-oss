/**
 * Shared organization resolution for callers that hold a user but no
 * session-supplied tenant.
 *
 * A browser request carries its organization in the URL, so the web app never
 * has to ask this question. A protocol request authenticated with an API key
 * carries a user and nothing else, and still has to run inside exactly one
 * organization. This helper is the single place that decides which one, so the
 * gateway, the hosted server and anything added later cannot drift into three
 * slightly different rules.
 *
 * The rule, and the reasoning behind the part of it that looks unfinished:
 *
 * - One membership resolves to it. There is nothing to choose between.
 * - Several memberships resolve to `User.lastActiveOrganizationId` while the
 *   caller still belongs to it. Last-active is the mandated multi-organization
 *   default (Fizzy #1875, FR4).
 * - Several memberships whose last-active is stale or unset resolve to
 *   NOTHING. This is deliberate, and it is the line most likely to be "fixed"
 *   by a later reader: sorting the memberships and taking the first would make
 *   the answer stable, and stability reads like correctness. It is not
 *   authorisation. Dropping a credential into a tenant nobody named is the
 *   wrong failure mode — that tenant holds data belonging to its other
 *   members, and the key's holder never asked to reach it. FR4 mandates
 *   last-active as the default; it says nothing about what to do when
 *   last-active does not resolve, and fail-closed is the safe reading of that
 *   silence. The caller answers this case by letting the user name one of
 *   their own organizations, which both protocol entry points accept.
 * - No membership at all resolves to nothing, for an unrelated reason: there
 *   is nowhere to go. This is now the residue rather than the common case:
 *   signup creates an organization and session creation backfills accounts
 *   that predate that, so reaching here means an account whose owner has not
 *   signed in since, or one whose creation failed.
 *
 * The two absences are separate variants on purpose. "Has not said where" is
 * answerable by the caller naming an organization; "nowhere to go" is not.
 * Collapsing them into one `null` turns the first into a lockout and the
 * second into a lie.
 *
 * A consequence this used to carry has since been removed, and is kept here
 * only because the shape of the remaining problem is easier to see against it:
 * `lastActiveOrganizationId` is written by the browser workspace switcher,
 * which used to accept null for a "Personal account" entry. Clicking it cleared
 * the field and changed where that person's NON-browser credentials resolved,
 * so a multi-organization user could stop every one of their API keys
 * resolving from the browser. That entry is gone with the rest of personal
 * context, so nothing clears the field to null any more.
 *
 * What is NOT fixed by its removal: a key still has no organization of its own
 * and still resolves through this helper, so a multi-organization user whose
 * last-active is unset lands in the fail-closed case above. Binding a key to an
 * organization remains the proper fix and remains larger than this helper.
 *
 * The companion question — "may this user act in the organization they named"
 * — is answered by `isOrganizationMember` in `./verify-organization-membership`
 * and is deliberately not duplicated here.
 */

import { db } from "../client";

/**
 * What a user's tenancy resolves to when nobody supplied one.
 *
 * - `resolved` — exactly one answer, and it is authorised: either the caller's
 *   only membership, or a last-active organization they still belong to.
 * - `ambiguous` — the caller has somewhere to go but has not said where.
 *   `organizationIds` lists every organization they may act in, so a caller can
 *   name them in a refusal or offer them for selection. Ordered by id purely so
 *   the list is stable to render; the order carries NO precedence and must not
 *   be used to pick one.
 * - `no_membership` — the caller has nowhere to go. Not an error and not a
 *   throw: it is the state of every account that has not joined or created an
 *   organization yet.
 */
export type UserOrganizationResolution =
	| { kind: "resolved"; organizationId: string }
	| { kind: "ambiguous"; organizationIds: string[] }
	| { kind: "no_membership" };

/**
 * Resolve which organization `userId` is operating in.
 *
 * Never throws for an ordinary miss and never invents an organization: every
 * outcome the caller has to handle is a variant of the returned union. A
 * `userId` that matches no user row reports `no_membership` — from the
 * caller's side the consequence is identical (there is nowhere to run), and
 * the caller has already authenticated the user by the time it asks. An empty
 * `userId` short-circuits to the same answer rather than issuing a query.
 */
export async function resolveUserOrganization(
	userId: string,
): Promise<UserOrganizationResolution> {
	if (!userId) {
		return { kind: "no_membership" };
	}

	// One read, not two. The memberships and the last-active pointer that is
	// validated against them come from the same row, so the pointer can never
	// be checked against a membership list fetched at a different instant.
	const user = await db.user.findUnique({
		where: { id: userId },
		select: {
			lastActiveOrganizationId: true,
			members: {
				select: { organizationId: true },
				orderBy: { organizationId: "asc" },
			},
		},
	});

	const organizationIds =
		user?.members.map((member) => member.organizationId) ?? [];

	if (organizationIds.length === 0) {
		return { kind: "no_membership" };
	}

	if (organizationIds.length === 1) {
		return { kind: "resolved", organizationId: organizationIds[0] };
	}

	const lastActiveOrganizationId = user?.lastActiveOrganizationId;
	if (
		lastActiveOrganizationId &&
		organizationIds.includes(lastActiveOrganizationId)
	) {
		return { kind: "resolved", organizationId: lastActiveOrganizationId };
	}

	// Several memberships, and nothing authorised names one of them. Fail
	// closed — see the file header.
	return { kind: "ambiguous", organizationIds };
}
