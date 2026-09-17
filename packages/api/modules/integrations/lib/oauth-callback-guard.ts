/**
 * The two checks every integration OAuth callback runs between "the state is
 * genuine" and "exchange the code".
 *
 * A signed state proves the flow was STARTED by the user it names. It does not
 * prove that the browser now presenting it belongs to that user: the provider
 * redirects whichever browser completed the authorization, and an attacker who
 * starts a flow holds a state naming themselves that any victim's browser can
 * be lured into completing. Before this guard the callback was public and
 * stored the victim's provider token under `state.userId` — the attacker.
 *
 * So the callback requires a session and the session must be the user who
 * started the flow. The caller must still belong to the organization the
 * state names with a role that grants INTEGRATION_USE there — `start` checked
 * that up to ten minutes ago, and both the membership and the role can have
 * changed since; the callback's own `requirePermission` looks at the
 * session's active organization, which need not be the one in the state. A
 * state without an organization never gets this far: `decodeOAuthState`
 * refuses it (ADR-018, no organization-less integration OAuth). Then the
 * nonce is spent, exactly once.
 *
 * The three procedure files share this so the checks cannot drift apart; the
 * GitHub and GitLab callbacks reached the same code paths and had the same
 * gap.
 */

import { ORPCError } from "@orpc/server";
import { getOrganizationMembership } from "@repo/database";
import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import type { OAuthStatePayload } from "./oauth-state";
import { consumeOAuthStateNonce } from "./oauth-state-store";

/** The subset of a decoded state the guard reads. */
export type OAuthStateBinding = Pick<
	OAuthStatePayload,
	"userId" | "organizationId" | "nonce"
>;

/**
 * Refuse unless the session user is the user who started this flow and still
 * belongs to the organization the flow targets with a role that still grants
 * INTEGRATION_USE there.
 *
 * Throws rather than returning a `{ success: false }` result: the other
 * refusals in these callbacks are the user's own flow failing and are shown to
 * them as such, while this one is a different principal presenting someone
 * else's state, which the audit-error middleware should record as FORBIDDEN.
 */
export async function assertOAuthStateBoundToCaller(
	state: Pick<OAuthStateBinding, "userId" | "organizationId">,
	caller: { id: string },
): Promise<void> {
	if (!state.userId || state.userId !== caller.id) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"This connection was started from a different Fabric account. Sign in as the account that started it and try again.",
		});
	}

	// A live check against the organization the STATE names, not the session's
	// active one. The procedure's `requirePermission` middleware evaluated the
	// SESSION's active organization, which need not be the one signed into the
	// state: a member of B who is demoted there, then switches their session
	// to A where they still hold INTEGRATION_USE, must not complete B's
	// callback — the token it stores lands in B. Membership is the tenant
	// boundary, and the role must still grant the permission `start` checked,
	// as of now rather than as of ten minutes ago. Both refuse as FORBIDDEN
	// before the code is exchanged, so nothing has happened when they fire.
	// Project-target callbacks additionally re-check the project-level
	// permission before they write, in their own branch. The decoder already
	// refused a state with no organization; this is the guard's own copy of
	// that rule so it cannot be bypassed by a caller that skips the decoder.
	if (!state.organizationId) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"This connection was not started from an organization. Start it again from the organization it belongs to.",
		});
	}
	await assertCallerMayUseIntegrationsIn(state.organizationId, caller.id);
}

async function assertCallerMayUseIntegrationsIn(
	organizationId: string,
	userId: string,
): Promise<void> {
	const membership = await getOrganizationMembership(organizationId, userId);
	if (!membership) {
		throw new ORPCError("FORBIDDEN", {
			message: "You are not a member of this organization",
		});
	}
	if (
		!hasPermission(
			resolveOrgPermissions(membership.role),
			Permissions.INTEGRATION_USE,
		)
	) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"Your role in this organization no longer allows connecting integrations. Ask an organization admin, then start the connection again.",
		});
	}
}

/**
 * Spend the state's nonce. Returns `null` when the callback may proceed, or the
 * `{ success: false }` result the callback should return instead — the same
 * shape the callbacks already use for an invalid or expired state, so the
 * popup and the fallback redirect render it the same way.
 */
export async function consumeOAuthStateOnce(
	state: Pick<OAuthStateBinding, "nonce">,
): Promise<{ success: false; message: string } | null> {
	const outcome = await consumeOAuthStateNonce(state.nonce);
	switch (outcome) {
		case "consumed":
			return null;
		case "replayed":
			return {
				success: false,
				message:
					"This sign-in link has already been used. Please start the connection again.",
			};
		case "unavailable":
			return {
				success: false,
				message:
					"Fabric could not verify this sign-in link right now. Please try again in a moment.",
			};
		default: {
			const exhaustive: never = outcome;
			return exhaustive;
		}
	}
}
