"use client";

import type { FeatureFlagKey } from "@repo/utils/feature-flag-registry";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";

/**
 * Organization roles whose permissions include both `AGENT_CREATE` and
 * `AGENT_UPDATE` in `packages/permissions/lib/roles.ts`: the runtime saves
 * the conversation server-side and refuses a caller without them, while the
 * stream routes let anyone tied to the organization chat unsaved.
 *
 * Spelled out here rather than imported: `@repo/permissions` is not a
 * dependency of `apps/web` (see `prompts/lib/delete-authority.ts`). A project
 * guest has no organization role and a viewer lacks both permissions, so both
 * stay on the stream routes.
 */
const ROLES_THAT_SAVE_CONVERSATIONS: readonly string[] = [
	"owner",
	"admin",
	"member",
];

/**
 * Whether a chat may run over the agent runtime: its rollout `flag` is on for
 * the organization on screen, the chat runs in that organization, the viewer
 * is not a project guest, and the viewer's role there may save conversations.
 */
export function useRuntimeEligible(
	flag: FeatureFlagKey,
	organizationId: string | undefined,
): boolean {
	const enabled = useFeatureFlag(flag);
	const {
		organizationId: activeOrganizationId,
		userRole,
		isGuest,
	} = useOrganizationContext();
	return (
		enabled &&
		!isGuest &&
		activeOrganizationId !== null &&
		(organizationId === undefined ||
			organizationId === activeOrganizationId) &&
		userRole !== null &&
		ROLES_THAT_SAVE_CONVERSATIONS.includes(userRole)
	);
}
