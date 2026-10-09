import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { warmCodingInstructions } from "../components/instructions/lib/coding-instructions-warmup";

type TabWarmup = (
	queryClient: ReturnType<typeof useQueryClient>,
	projectId: string,
) => void;

/**
 * What a tab can start before the project and the tab's own code have loaded.
 * Each entry reads nothing from `projects.get`, and an entry is idempotent:
 * it runs again on every hover and every mount of the page.
 */
const TAB_WARMUPS: Readonly<Record<string, TabWarmup | undefined>> = {
	"coding-instructions": warmCodingInstructions,
};

/**
 * Starts a tab's warm-up as soon as the page knows the tab is wanted (the
 * stored tab or a `?tab=` deep link), and returns the per-tab hover/focus
 * handler for the tab bar (`undefined` for a tab with nothing to warm).
 */
export function useProjectTabWarmup(
	projectId: string,
	wantedTabs: ReadonlyArray<string | undefined>,
) {
	const queryClient = useQueryClient();
	const wanted = wantedTabs.filter(
		(tab): tab is string => tab !== undefined && tab in TAB_WARMUPS,
	);
	const wantedKey = wanted.join("\u0000");
	useEffect(() => {
		for (const tab of wanted) {
			TAB_WARMUPS[tab]?.(queryClient, projectId);
		}
	}, [wantedKey, queryClient, projectId]);
	return (tabId: string) => {
		const warmup = TAB_WARMUPS[tabId];
		return warmup ? () => warmup(queryClient, projectId) : undefined;
	};
}
