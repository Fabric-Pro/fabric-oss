/**
 * Which scope a fork should land in, for the person asking for it.
 *
 * Forking to ORG scope publishes into the organization's library, which the
 * server gates on org admin — the same authority `create` demands there. So the
 * scope is not a preference: sending ORG for anyone else earns a refusal, and
 * the copy a member actually wanted was their own all along.
 *
 * Extracted from the fork handler because getting this wrong is silent in both
 * directions. Too permissive and every member's Fork button fails on click; too
 * strict and an admin quietly gets a personal copy where they meant to publish
 * one for the organization. Neither shows up in a type check.
 */

export type ForkTarget = {
	targetScope: "USER" | "ORG";
	/** Omitted for a personal fork so no organization is stamped on it. */
	organizationId: string | undefined;
};

export function forkTarget({
	organizationId,
	isOrganizationAdmin,
}: {
	organizationId: string | null | undefined;
	isOrganizationAdmin: boolean;
}): ForkTarget {
	if (organizationId && isOrganizationAdmin) {
		return { targetScope: "ORG", organizationId };
	}

	return { targetScope: "USER", organizationId: undefined };
}

/**
 * Fizzy #2068 (F11): the forked copy is a live "Propose Change" candidate when
 * the user arrived from Propose Change and the copy is theirs — a personal
 * prompt they can edit freely and then put forward through the ordinary
 * set-default flow, where a member's organization-tier choice becomes a
 * nomination for an admin to review.
 */
export function isProposalCandidate({
	promptScope,
	promptUserId,
	viewerId,
	proposeChangeParam,
}: {
	promptScope: string;
	promptUserId: string | null | undefined;
	viewerId: string | null | undefined;
	proposeChangeParam: boolean;
}): boolean {
	return (
		proposeChangeParam &&
		promptScope === "USER" &&
		promptUserId != null &&
		promptUserId === viewerId
	);
}
