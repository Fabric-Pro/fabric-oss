/**
 * Keeps keyboard focus in the proposal list when an item's own Approve or
 * Move to Rejected resolves it. The resolved row's actions unmount with the
 * focused button, so focus would fall to the dialog container. It moves to
 * the next open item's Approve instead (or the nearest earlier one), and to
 * the resolved row's ticket link once no item is left open.
 */

import { useEffect, useRef } from "react";

const ROW_SELECTOR = "[data-proposal-item]";
const APPROVE_SELECTOR = "button[data-item-approve]:not(:disabled)";

function focusTarget(
	list: HTMLElement,
	actedIndex: number,
): HTMLElement | null {
	const rows = Array.from(list.querySelectorAll<HTMLElement>(ROW_SELECTOR));
	const indexOf = (row: HTMLElement) => Number(row.dataset.proposalItem);
	const approveIn = (row: HTMLElement) =>
		row.querySelector<HTMLElement>(APPROVE_SELECTOR);
	const after = rows.filter((row) => indexOf(row) > actedIndex);
	const before = rows.filter((row) => indexOf(row) < actedIndex).reverse();
	for (const row of [...after, ...before]) {
		const approve = approveIn(row);
		if (approve) {
			return approve;
		}
	}
	const acted = rows.find((row) => indexOf(row) === actedIndex);
	return acted?.querySelector<HTMLElement>("a[href]") ?? null;
}

export function useItemActionRefocus(lockedIndexes: ReadonlySet<number>) {
	const listRef = useRef<HTMLDivElement>(null);
	const actedIndexRef = useRef<number | null>(null);

	useEffect(() => {
		const actedIndex = actedIndexRef.current;
		const list = listRef.current;
		if (actedIndex === null || !list || !lockedIndexes.has(actedIndex)) {
			return;
		}
		actedIndexRef.current = null;
		// The reviewer already moved on to another control in the list.
		if (list.contains(document.activeElement)) {
			return;
		}
		focusTarget(list, actedIndex)?.focus();
	}, [lockedIndexes]);

	return {
		listRef,
		/** Call when an item action starts from that item's row. */
		markActed: (index: number) => {
			actedIndexRef.current = index;
		},
	};
}
