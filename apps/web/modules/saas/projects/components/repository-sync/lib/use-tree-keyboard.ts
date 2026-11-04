"use client";

import {
	type FocusEvent,
	type KeyboardEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { focusFallback, type VisibleTreeRow } from "./tree-view";

/** How long typed letters keep adding to one type-ahead search. */
export const TREE_TYPE_AHEAD_MS = 500;

/** What one row needs to take part in the tree's keyboard model. */
export type TreeItemKeyboardProps = {
	ref: (element: HTMLElement | null) => void;
	tabIndex: 0 | -1;
	onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
	onFocus: (event: FocusEvent<HTMLElement>) => void;
	onBlur: (event: FocusEvent<HTMLElement>) => void;
};

/** The tree item an event happened in, if any. */
function treeItemOf(target: EventTarget | null): Element | null {
	return target instanceof Element
		? target.closest('[role="treeitem"]')
		: null;
}

/**
 * The WAI-ARIA tree view keyboard model over the rows on screen (`rows`,
 * from `visibleTreeRows`), with a roving tabindex: the tree is one Tab stop,
 * the row last focused (or, once it is gone, its nearest ancestor on screen,
 * else the first row). A focused row that goes away (a collapse, a search,
 * a new listing) hands focus to that same row.
 *
 * Up and Down move one row, Home and End to the first and last. Right opens
 * a closed folder, or moves into an open one; Left closes an open folder,
 * or moves to the folder a row is in. Enter opens or closes a folder; Space
 * is the row's own action (`onActivate`: its box). Printable keys typed
 * within `TREE_TYPE_AHEAD_MS` of each other move to the next row whose name
 * starts with them. A click anywhere in a row focuses the row itself, so the
 * keyboard carries on from there.
 */
export function useTreeKeyboard({
	rows,
	toggleExpanded,
	onActivate,
}: {
	rows: readonly VisibleTreeRow[];
	toggleExpanded: (path: string) => void;
	onActivate: (row: VisibleTreeRow) => void;
}): (row: VisibleTreeRow) => TreeItemKeyboardProps {
	const [focused, setFocused] = useState<string | null>(null);
	const elements = useRef(new Map<string, HTMLElement>());
	// The row to move DOM focus to once it has rendered (Right into a folder
	// that just opened, or the fallback for a focused row that went away).
	const pendingFocus = useRef<string | null>(null);
	// Whether a row holds DOM focus: a row that unmounts fires no blur.
	const rowHasFocus = useRef(false);
	const typeAhead = useRef({ text: "", at: 0 });
	const indexByPath = useMemo(
		() => new Map(rows.map((row, index) => [row.node.path, index])),
		[rows],
	);
	const tabbable = focusFallback(rows, focused);

	useEffect(() => {
		const active = document.activeElement;
		if (
			rowHasFocus.current &&
			tabbable !== null &&
			tabbable !== focused &&
			(active === null || active === document.body)
		) {
			pendingFocus.current = tabbable;
		}
		const target = pendingFocus.current;
		const element =
			target === null ? undefined : elements.current.get(target);
		if (element) {
			pendingFocus.current = null;
			element.focus();
		}
	});

	function moveTo(path: string) {
		pendingFocus.current = path;
		setFocused(path);
	}

	function typeAheadTarget(from: number, key: string): string | null {
		const now = Date.now();
		const previous = typeAhead.current;
		const text =
			now - previous.at > TREE_TYPE_AHEAD_MS
				? key.toLowerCase()
				: previous.text + key.toLowerCase();
		typeAhead.current = { text, at: now };
		// A first letter looks past the current row, so repeating it cycles;
		// a longer prefix may still match the current row.
		const start = text.length === 1 ? from + 1 : from;
		for (let offset = 0; offset < rows.length; offset++) {
			const candidate = rows[(start + offset) % rows.length];
			if (candidate?.node.name.toLowerCase().startsWith(text)) {
				return candidate.node.path;
			}
		}
		return null;
	}

	function handleKey(event: KeyboardEvent<HTMLElement>, index: number) {
		const row = rows[index];
		if (!row || event.altKey || event.ctrlKey || event.metaKey) {
			return;
		}
		const folder = row.node.type === "dir";
		const at = (i: number) => rows[i]?.node.path;
		let target: string | undefined;
		switch (event.key) {
			case "ArrowDown":
				target = at(index + 1);
				break;
			case "ArrowUp":
				target = at(index - 1);
				break;
			case "Home":
				target = at(0);
				break;
			case "End":
				target = at(rows.length - 1);
				break;
			case "ArrowRight":
				if (folder && !row.expanded) {
					toggleExpanded(row.node.path);
				} else if (
					folder &&
					rows[index + 1]?.parent === row.node.path
				) {
					target = at(index + 1);
				}
				break;
			case "ArrowLeft":
				if (folder && row.expanded) {
					toggleExpanded(row.node.path);
				} else if (row.parent !== null) {
					target = row.parent;
				}
				break;
			case "Enter":
				if (folder) {
					toggleExpanded(row.node.path);
				}
				break;
			case " ":
				onActivate(row);
				break;
			default:
				if (event.key.length !== 1 || event.key.trim() === "") {
					return;
				}
				target = typeAheadTarget(index, event.key) ?? undefined;
		}
		event.preventDefault();
		if (target !== undefined && target !== row.node.path) {
			moveTo(target);
		}
	}

	return (row) => {
		const path = row.node.path;
		return {
			ref: (element) => {
				if (element) {
					elements.current.set(path, element);
				} else {
					elements.current.delete(path);
				}
			},
			tabIndex: path === tabbable ? 0 : -1,
			onKeyDown: (event) => {
				// Keys pressed on a row inside this one are that row's.
				if (event.target === event.currentTarget) {
					handleKey(event, indexByPath.get(path) ?? -1);
				}
			},
			onFocus: (event) => {
				if (treeItemOf(event.target) !== event.currentTarget) {
					return;
				}
				rowHasFocus.current = true;
				if (event.target !== event.currentTarget) {
					// The box or the chevron, clicked: the row takes focus.
					event.currentTarget.focus();
					return;
				}
				setFocused(path);
			},
			onBlur: (event) => {
				if (
					treeItemOf(event.target) === event.currentTarget &&
					treeItemOf(event.relatedTarget) === null
				) {
					rowHasFocus.current = false;
				}
			},
		};
	};
}
