import { orpc } from "@shared/lib/orpc-query-utils";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

/**
 * A provider refresh answers before the backend has finished folding the
 * result in, so the first read after the answer can still show the old state.
 * For this long after a Refresh the proposal views keep polling until the
 * state they show changes.
 */
export const PROPOSAL_REFRESH_SETTLE_WINDOW_MS = 20_000;
export const PROPOSAL_REFRESH_SETTLE_POLL_MS = 3_000;

/**
 * Every read the proposals dialog renders from: the suggestion list and its
 * detail, the member's own branch, and the reviewer aggregate of branches.
 * They describe one piece of delivery state, so they are always re-read
 * together.
 */
export function invalidateProposalViews(
	queryClient: QueryClient,
): Promise<void> {
	const { proposals } = orpc.projects.instructions;
	return Promise.all(
		[
			proposals.list.key(),
			proposals.get.key(),
			proposals.myBranch.key(),
			proposals.branches.key(),
		].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
	).then(() => undefined);
}

/**
 * How many live changes the member's own proposal branch holds in the last
 * read, or 0 when it has not been read, for this project only. Used to word a toast by what actually
 * happens next: a pull request that already holds other suggestions stays
 * open when one of them is withdrawn, and takes a new one without reopening.
 */
export function liveChangesOnMyBranch(
	queryClient: QueryClient,
	projectId: string,
): number {
	return queryClient
		.getQueriesData<{ liveChanges?: number }>({
			queryKey: orpc.projects.instructions.proposals.myBranch.key({
				input: { projectId },
			}),
		})
		.reduce((total, [, data]) => total + (data?.liveChanges ?? 0), 0);
}

export function branchesSignature(
	branches: ReadonlyArray<{ id: string; state: string; attempt: number }>,
): string {
	return branches.map((b) => `${b.id}:${b.state}:${b.attempt}`).join("|");
}

/**
 * Re-reads the proposal list and detail once each time a branch's state
 * changes (OPENING to OPEN, CLOSE_REQUESTED to settled or gone), so the rows
 * move at the moment the branch card does. The first read is not a change.
 */
export function useInvalidateListOnBranchStateChange(
	queryClient: QueryClient,
	branches: ReadonlyArray<{ id: string; state: string }> | undefined,
): void {
	const signature = branches
		? branches.map((b) => `${b.id}:${b.state}`).join("|")
		: null;
	const previous = useRef<string | null>(null);
	useEffect(() => {
		if (signature === null) {
			return;
		}
		if (previous.current !== null && previous.current !== signature) {
			const { proposals } = orpc.projects.instructions;
			for (const queryKey of [
				proposals.list.key(),
				proposals.get.key(),
			]) {
				void queryClient.invalidateQueries({ queryKey });
			}
		}
		previous.current = signature;
	}, [signature, queryClient]);
}

/**
 * The poll that follows a Refresh. The caller reports the state its view
 * shows with `observe(signature)` on every render, after its queries; the
 * window opens on `startSettling` and closes as soon as the observed signature
 * differs from the one it opened on, when the window ends, or when the
 * component unmounts. One timer exists at a time, so a second click restarts
 * the window instead of stacking another.
 *
 * `pollInterval` is for a query's `refetchInterval`: the interval the caller
 * already has, sped up to the settle poll while the window is open.
 */
export function useRefreshSettleWindow() {
	const observed = useRef("");
	const [opened, setOpened] = useState<{ signature: string } | null>(null);
	useEffect(() => {
		if (opened === null) {
			return;
		}
		const timer = setTimeout(
			() => setOpened(null),
			PROPOSAL_REFRESH_SETTLE_WINDOW_MS,
		);
		return () => clearTimeout(timer);
	}, [opened]);
	const isSettling = () =>
		opened !== null && opened.signature === observed.current;
	return {
		observe: (signature: string) => {
			observed.current = signature;
		},
		settling: isSettling(),
		startSettling: () => setOpened({ signature: observed.current }),
		pollInterval: (existing: number | false): number | false => {
			if (!isSettling()) {
				return existing;
			}
			return existing === false
				? PROPOSAL_REFRESH_SETTLE_POLL_MS
				: Math.min(existing, PROPOSAL_REFRESH_SETTLE_POLL_MS);
		},
	};
}
