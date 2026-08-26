"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";

/**
 * Returns whether the three-tab Feature Maturation V2 editor is enabled for
 * the caller's current tenant context (Feature Maturation V2 spec §9).
 *
 * Behaviour (note: this hook defaults to `false`, the inverse of the
 * doc-assistant-history hook — V2 is strictly opt-in):
 * - **Personal context** (no active org): always returns `false`. Personal
 *   features stay on the v1 single-doc flow; the flag is org-scoped only and
 *   there is no org row to read.
 * - **Org context, loading**: returns `false` so non-flagged orgs (the vast
 *   majority — the column defaults to `false`) never flash the V2 tabs before
 *   the flag settles. Failure mode is "v1 shows then v2 appears" for a flagged
 *   org, never "tabs flash then disappear" for a non-flagged one.
 * - **Org context, settled**: returns the persisted boolean.
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
