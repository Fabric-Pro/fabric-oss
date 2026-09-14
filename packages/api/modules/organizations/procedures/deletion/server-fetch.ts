import { db } from "@repo/database";
import { readOrganizationDeletionToken } from "../../lib/deletion-token";

/**
 * Resolve the organization a deletion link names, for the page that link lands
 * on (Fizzy #2462).
 *
 * A SERVER-SIDE HELPER RATHER THAN A PROCEDURE, and that is the security
 * argument for this shape. The confirmation page is already a server component
 * holding the session and the token, so it can ask this directly; exposing the
 * same lookup over oRPC would publish an endpoint that turns a token into an
 * organization name, which is an oracle worth nothing to an honest user and
 * something to anyone holding a link they should not have.
 *
 * Mirrors `fetchChatAgentSelectionForUser` — the established way an app-router
 * server component reads API-owned data without a round trip.
 *
 * `userId` is the caller's session, and the match against the token's own
 * `userId` is what makes returning the name safe: the token was minted FOR this
 * person and this organization, so the name is something they already know.
 * `confirm.ts` re-checks membership and `ORG_DELETE` before anything is
 * destroyed; this only decides which of two sentences the page prints, so it
 * stops at proving the reader is the requester.
 *
 * Returns `null` for every failure, including an expired or already-spent link.
 * The page then prints its unnamed copy rather than an error — the button is
 * still there, and the refusal belongs to `confirm`, which says why in one
 * message for all of them. Failing softly here keeps this from becoming a
 * second, subtly different verdict on the same token.
 */
export async function fetchOrganizationNameForDeletionToken({
	token,
	userId,
}: {
	token: string;
	userId: string;
}): Promise<string | null> {
	const payload = await readOrganizationDeletionToken(token);

	if (!payload || payload.userId !== userId) {
		return null;
	}

	const organization = await db.organization.findFirst({
		where: { id: payload.organizationId },
		select: { name: true },
	});

	return organization?.name ?? null;
}
