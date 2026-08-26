"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";

/**
 * Returns whether the AI document-assistant chat-history feature is enabled
 * for the caller's current tenant context.
 *
 * Behaviour:
 * - **Personal context** (no active org): always returns `true`. Personal
 *   users do not have an org row to read; per spec §3.11 FR-27 the flag
 *   is org-scoped only.
 * - **Org context, loading**: returns `true` so the affordance stays visible
 *   on first paint. The DB default for the column is `true`, so optimistic
 *   `true` matches the eventual result for virtually every org. Failure
 *   mode is "history shows briefly then hides" rather than "history flashes
 *   off then on" — the former is less visually jarring.
 * - **Org context, settled**: returns the persisted boolean.
 *
 * Why this hook reads via a dedicated oRPC procedure instead of piggy-backing
 * on `useActiveOrganization()`: Better Auth's `getFullOrganization`
 * returns its own typed object and does not surface arbitrary Prisma
 * columns added by the application. Adding a custom field-list to Better
 * Auth's response would require forking the client; a thin read-only
 * procedure is the minimal-scope path.
 *
 * Spec: 2026-05-19-ai-assistant-document-chat-history §3.11 FR-27.
 */
export function useDocumentAssistantHistoryEnabled(): boolean {
	const { organizationId, isOrgContext } = useOrganizationContext();

	const { data } = useQuery({
		...orpc.organizations.documentAssistantHistory.get.queryOptions({
			input: { organizationId: organizationId ?? "" },
		}),
		// Skip the network call for personal context — there is no org
		// row to read and the column does not apply.
		enabled: isOrgContext && !!organizationId,
		// Optimistic default during the in-flight first fetch (see hook
		// docblock). Once settled, this is overridden by the server value.
		placeholderData: { documentAssistantHistoryEnabled: true },
	});

	if (!isOrgContext) {
		return true;
	}

	return data?.documentAssistantHistoryEnabled ?? true;
}
