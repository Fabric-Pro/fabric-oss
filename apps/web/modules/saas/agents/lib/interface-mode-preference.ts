import type { UiMode } from "@repo/database";
import type { QueryClient } from "@tanstack/react-query";

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
