"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";

/** Retain the project prefix for invalidation; never reuse another actor's read. */
export function recipientBrandQueryKey(
	projectId: string,
	organizationId: string | null,
	userId: string | null,
) {
	return [
		"projectRecipientBrand",
		projectId,
		organizationId,
		userId,
	] as const;
}

export function useRecipientBrandQueryIdentity(projectId: string) {
	const { user } = useSession();
	const { organizationId } = useOrganizationContext();
	return {
		queryKey: recipientBrandQueryKey(
			projectId,
			organizationId ?? null,
			user?.id ?? null,
		),
		enabled: Boolean(organizationId && user?.id),
	};
}
