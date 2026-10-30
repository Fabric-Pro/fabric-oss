"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	type DuplicateLink,
	DuplicateResolveDialog,
} from "../components/stories/DuplicateResolveDialog";
import {
	DuplicateScanCompletionDialog,
	type DuplicateScanCompletionResult,
} from "../components/stories/DuplicateScanCompletionDialog";

/** Most scan requests one click makes while candidate pairs are left over. */
const MAX_SCAN_ROUNDS = 10;

/** Info passed to a story card so it can render a "possible duplicate" chip.
 * `overlapOnly` = every pending link is OVERLAP (overlapping scope, not a true
 * duplicate), so the card shows the softer chip label. */
export type DuplicateInfo = {
	count: number;
	partnerTitles: string[];
	overlapOnly: boolean;
	onResolve: () => void;
};

/**
 * Shared duplicate-detection state for a project view (roadmap or kanban).
 *
 * Owns the `listDuplicates` query, the partner map, the scan mutation, the
 * resolve-dialog and scan-completion-dialog state, and query invalidation — so
 * both the Roadmap and the Kanban surface the same chips/dialogs with
 * identical behaviour from one place.
 *
 * Returns:
 *  - `getDuplicateInfo(storyId)` — chip data for a card, or `undefined`.
 *  - `runScan()` / `isScanning` — trigger + loading state for the scan action.
 *  - `resolveDialog` — the (single) resolve dialog element to render once.
 *  - `scanCompletionDialog` — the post-scan summary dialog element to render once.
 *  - `pendingCount` — number of stories currently part of a duplicate pair.
 */
export function useDuplicateScan(
	projectId: string,
	organizationId: string | null,
	options?: {
		/** Applies the duplicates-only roadmap filter when the user confirms. */
		onViewDuplicates?: () => void;
	},
) {
	const queryClient = useQueryClient();

	const t = useTranslations("projects.stories.duplicates");

	const { data } = useQuery(
		orpc.projects.stories.listDuplicates.queryOptions({
			input: { projectId, organizationId },
		}),
	);
	const duplicateLinks = useMemo<DuplicateLink[]>(
		() => data?.links ?? [],
		[data],
	);

	// storyId -> the pending links it participates in (either side of the pair).
	const linksByStory = useMemo(() => {
		const map = new Map<string, DuplicateLink[]>();
		for (const link of duplicateLinks) {
			for (const id of [link.storyA.id, link.storyB.id]) {
				const existing = map.get(id);
				if (existing) {
					existing.push(link);
				} else {
					map.set(id, [link]);
				}
			}
		}
		return map;
	}, [duplicateLinks]);

	const [dialogLink, setDialogLink] = useState<DuplicateLink | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [completionResult, setCompletionResult] =
		useState<DuplicateScanCompletionResult | null>(null);
	const [completionOpen, setCompletionOpen] = useState(false);

	const invalidate = useCallback(
		() =>
			Promise.all([
				queryClient.invalidateQueries({
					queryKey: orpc.projects.stories.listDuplicates.queryKey({
						input: { projectId, organizationId },
					}),
				}),
				queryClient.invalidateQueries({
					queryKey: orpc.projects.stories.list.queryKey({
						input: { projectId, organizationId },
					}),
				}),
			]),
		[queryClient, projectId, organizationId],
	);

	const scanMutation = useMutation({
		mutationKey: orpc.projects.stories.scanDuplicates.mutationKey(),
		// One scan request verifies at most a fixed number of candidate pairs
		// and reports the rest as `truncated`; their pairs are the next
		// request's candidates. Keep scanning while pairs are left over and the
		// last request verified every pair it tried, so one click covers a
		// large backlog (after an edit sweep, say) instead of needing a click
		// per batch. A request with failures stops the loop rather than
		// re-trying the same failing pairs; so does a request that errors
		// after the first, reporting what the earlier ones finished — their
		// flags are already saved.
		mutationFn: async (input: {
			projectId: string;
			organizationId: string | null;
		}): Promise<DuplicateScanCompletionResult> => {
			const scan = () =>
				orpcClient.projects.stories.scanDuplicates(input);
			type ScanResponse = Awaited<ReturnType<typeof scan>>;
			// `?? 0` tolerates an older cached client shape.
			const failuresOf = (response: ScanResponse) =>
				response.verifierFailures ?? 0;
			let response = await scan();
			let candidates = response.candidates;
			let verifierFailures = failuresOf(response);
			for (
				let round = 2;
				round <= MAX_SCAN_ROUNDS &&
				response.truncated > 0 &&
				failuresOf(response) === 0;
				round++
			) {
				try {
					response = await scan();
				} catch {
					break;
				}
				candidates += response.candidates;
				verifierFailures += failuresOf(response);
			}
			return {
				flaggedItems: response.flaggedItems,
				scanned: response.scanned,
				candidates,
				verifierFailures,
				remaining: response.truncated,
			};
		},
		onSuccess: async (result) => {
			// Refetch the duplicate links (and stories) BEFORE opening the
			// completion dialog so the "Possible duplicate" chips are already
			// visible on the roadmap behind it. `candidates` and
			// `verifierFailures` let the dialog distinguish a clean scan from
			// one that couldn't verify: this path does not throw on a wholesale
			// verifier outage, so "0 confirmed" alone is ambiguous.
			await invalidate();
			setCompletionResult(result);
			setCompletionOpen(true);
		},
		onError: (error) => {
			// Scan FAILURES intentionally stay a toast: the completion dialog
			// reports the results of a finished scan, while errors follow the
			// app-wide toast convention for failed mutations. Do not convert
			// this path to the dialog.
			void invalidate();
			toast.error(t("scanFailed"), {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	// Build each story's duplicate-chip data ONCE per scan result so the object
	// identity stays stable between renders — this is what lets the memoized
	// StoryCard/StoryTile skip re-rendering when their duplicate data is unchanged
	// (a fresh object literal per call would defeat the memo on every render).
	const duplicateInfoById = useMemo(() => {
		const map = new Map<string, DuplicateInfo>();
		for (const [storyId, links] of linksByStory) {
			if (!links || links.length === 0) {
				continue;
			}
			const partnerTitles = links.map((link) =>
				link.storyA.id === storyId
					? link.storyB.title
					: link.storyA.title,
			);
			map.set(storyId, {
				count: links.length,
				partnerTitles,
				overlapOnly: links.every((link) => link.linkType === "OVERLAP"),
				onResolve: () => {
					setDialogLink(links[0]);
					setDialogOpen(true);
				},
			});
		}
		return map;
	}, [linksByStory]);
	const getDuplicateInfo = useCallback(
		(storyId: string): DuplicateInfo | undefined =>
			duplicateInfoById.get(storyId),
		[duplicateInfoById],
	);

	const runScan = useCallback(() => {
		scanMutation.mutate({ projectId, organizationId });
	}, [scanMutation, projectId, organizationId]);

	const resolveDialog = (
		<DuplicateResolveDialog
			open={dialogOpen}
			onOpenChange={setDialogOpen}
			projectId={projectId}
			organizationId={organizationId}
			link={dialogLink}
			onResolved={invalidate}
		/>
	);

	const scanCompletionDialog = (
		<DuplicateScanCompletionDialog
			open={completionOpen}
			onOpenChange={setCompletionOpen}
			result={completionResult}
			onViewDuplicates={() => options?.onViewDuplicates?.()}
			onRetry={runScan}
		/>
	);

	return {
		getDuplicateInfo,
		runScan,
		isScanning: scanMutation.isPending,
		resolveDialog,
		scanCompletionDialog,
		pendingCount: linksByStory.size,
	};
}
