/**
 * Queries for the shared selection tree (`RepositorySyncSelectionTree`), for
 * every suite that renders it. A row is a WAI-ARIA tree item named by its
 * path: what assistive technology reads (checked state, disabled, the
 * reason it points at) is asserted on the item. The box drawn in the row is
 * for the pointer and hidden from assistive technology; it keeps the Radix
 * checkbox's own `aria-checked` and `disabled`, so a click and the drawn
 * state are asserted on it.
 */
import { screen, within } from "@testing-library/react";

/** The row named `path`, inside `scope` (the whole document by default). */
export function treeItem(
	path: string,
	scope: HTMLElement = document.body,
): HTMLElement {
	return within(scope).getByRole("treeitem", { name: path });
}

/** The row named `path`, once it renders. */
export function findTreeItem(path: string): Promise<HTMLElement> {
	return screen.findByRole("treeitem", { name: path });
}

/** The row named `path`, or `null` when it is not on screen. */
export function queryTreeItem(path: string): HTMLElement | null {
	return screen.queryByRole("treeitem", { name: path });
}

function ownPart(item: HTMLElement, selector: string): HTMLElement {
	const found = item.querySelector(`:scope > [data-tree-line] ${selector}`);
	if (!(found instanceof HTMLElement)) {
		throw new Error(
			`no ${selector} in the row ${item.getAttribute("aria-label")}`,
		);
	}
	return found;
}

/** The box drawn in a row (not one of its children's). */
export function boxIn(item: HTMLElement): HTMLElement {
	return ownPart(item, '[role="checkbox"]');
}

/** A folder row's open/close chevron. */
export function chevronIn(item: HTMLElement): HTMLElement {
	return ownPart(item, "[data-tree-toggle]");
}
