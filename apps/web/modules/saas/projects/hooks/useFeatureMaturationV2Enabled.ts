"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";

/**
 * Returns whether the three-tab Feature Maturation V2 editor is enabled for
 * the caller's current tenant context (Feature Maturation V2 spec §9).
 *
 * Behaviour (V2 is the default for every tenant since #1797):
 * - **Personal context** (no active org): always returns `true`, without a
 *   request. There is no org row to read, so personal workspaces are enrolled
 *   unconditionally and have no kill switch short of changing this hook.
 * - **Org context, loading**: returns `true` (placeholder data), so the
 *   common enabled case never flashes the single-document editor first. The
 *   failure mode is "V2 shows, then the single-document editor appears" for
 *   the rare organization flipped off by SQL.
 * - **Org context, settled**: returns the persisted boolean, or `true` when
 *   the response carries none.
 *
 * Reads via a dedicated oRPC procedure rather than `useActiveOrganization()`
 * for the same reason as `useDocumentAssistantHistoryEnabled`: Better Auth's
 * `getFullOrganization` does not surface arbitrary application Prisma columns,
 * so a thin read-only procedure is the minimal-scope path.
 *
 * Spec: 2026-06-09-three-tab-feature-editor §9 (feature flag & v1/v2 toggle).
 */
export function useFeatureMaturationV2Enabled(): boolean {
	const { organizationId, isOrgContext } = useOrganizationContext();

	const { data } = useQuery({
		...orpc.organizations.featureMaturationV2.get.queryOptions({
			input: { organizationId: organizationId ?? "" },
		}),
		// Skip the network call for personal context — there is no org row to
		// read. Personal is enrolled in V2 unconditionally (#1797), so no lookup.
		enabled: isOrgContext && !!organizationId,
		// V2 is now the default for all orgs (#1797); optimistic true avoids a
		// tab flash while the first fetch confirms the (rarely) opted-out org.
		placeholderData: { featureMaturationV2Enabled: true },
	});

	// Personal context: V2 is rolled out to all personal workspaces (#1797). There
	// is no org row to gate on, so enroll unconditionally. To disable personal V2,
	// revert this hook (personal has no SQL kill-switch, unlike orgs).
	if (!isOrgContext) {
		return true;
	}

	return data?.featureMaturationV2Enabled ?? true;
}
