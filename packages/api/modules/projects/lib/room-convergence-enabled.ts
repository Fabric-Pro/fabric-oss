import { isFeatureEnabled } from "@repo/database";

/**
 * Whether a content-bearing save of a client-document Proposal must name its
 * base: the collaborative room flag, on for the project's owning
 * organization (Fizzy #2946). Other types accept a save without one; the flag
 * off restores that for Proposals too. Every procedure that writes a room's
 * body asks this one predicate, so they cannot disagree about it.
 * `organizationId` must be the project's OWNING organization.
 */
export async function isRoomConvergenceOn(
	organizationId: string | null,
): Promise<boolean> {
	if (!organizationId) {
		return false;
	}
	return await isFeatureEnabled("DOCUMENT_ROOM_CONVERGENCE", organizationId);
}
