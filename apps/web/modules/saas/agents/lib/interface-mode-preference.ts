import type { UiMode } from "@repo/database";
import type { QueryClient } from "@tanstack/react-query";
import type { OrchestratorPreferenceFields } from "./orchestrator-preference-save-queue";

/**
 * The cache key both the full page and the ⌘J drawer read the user's
 * orchestrator preferences from. Preferences are per (user × org), so the org
 * is part of the key.
 */
export function orchestratorPreferencesQueryKey(
	organizationId: string | null | undefined,
) {
	return ["orchestrator-preferences", organizationId ?? null] as const;
}

/**
 * Writes an interface-mode change into the shared preferences cache, so the
 * other surface (page or drawer) follows without a reload (Fizzy #2040).
 *
 * Optimistic and never rolled back: a failed server write is reported by the
 * caller, and the switch still stands for this session on both surfaces —
 * rolling back would flip the other surface under the user as well.
 */
export function setCachedUiMode(
	queryClient: QueryClient,
	organizationId: string | null | undefined,
	next: UiMode,
) {
	queryClient.setQueryData(
		orchestratorPreferencesQueryKey(organizationId),
		(previous: unknown) =>
			previous && typeof previous === "object"
				? { ...previous, uiMode: next, exists: true }
				: previous,
	);
}

/**
 * Publishes confirmed list changes without replacing modes owned by other surfaces.
 * Cancel older reads before merging; an unresolved first load needs a full refetch.
 */
export async function setCachedOrchestratorPreferenceLists(
	queryClient: QueryClient,
	organizationId: string,
	fields: OrchestratorPreferenceFields,
	isCurrent: () => boolean,
) {
	const queryKey = orchestratorPreferencesQueryKey(organizationId);
	await queryClient.cancelQueries({ queryKey });
	if (!isCurrent()) {
		return;
	}
	const previous = queryClient.getQueryData(queryKey);
	if (previous && typeof previous === "object") {
		queryClient.setQueryData(queryKey, {
			...previous,
			...fields,
			exists: true,
		});
	} else {
		// Not awaited: a slow or hung read must not hold the save queue.
		void queryClient.invalidateQueries({ queryKey });
	}
}
