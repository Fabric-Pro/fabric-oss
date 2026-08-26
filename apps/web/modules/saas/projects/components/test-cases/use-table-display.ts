"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * How tightly the cases table packs its rows.
 *
 * `comfortable` is the 46px row the redesign ships. `compact` trades the
 * breathing room for roughly a third more rows on screen, which is what someone
 * triaging a few hundred cases actually wants.
 */
export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

/** Columns a reader is allowed to hide. */
export const HIDEABLE_COLUMNS = [
	"covers",
	"result",
	"state",
	"priority",
	"owner",
	"lastRun",
] as const;
export type HideableColumn = (typeof HIDEABLE_COLUMNS)[number];

export type TableDisplay = {
	density: Density;
	/** Columns the reader has switched OFF. */
	hidden: HideableColumn[];
};

export const DEFAULT_DISPLAY: TableDisplay = {
	density: "comfortable",
	hidden: [],
};

/**
 * Deliberately NOT in the URL, unlike the filters, sort and page.
 *
 * Those describe WHICH rows the reader is looking at, so they belong in a link:
 * sending someone "failing, critical, page 3" is the point. Density and hidden
 * columns describe how one person likes their own screen. Putting them in the
 * URL would mean a colleague opening a shared link silently inherits your row
 * height and your hidden columns — including, potentially, a column the link was
 * meant to draw their attention to.
 */
const STORAGE_PREFIX = "fabric.testCases.display.";

function parse(raw: string | null): TableDisplay {
	if (!raw) {
		return DEFAULT_DISPLAY;
	}
	try {
		const value = JSON.parse(raw) as Partial<TableDisplay>;
		return {
			density: DENSITIES.includes(value.density as Density)
				? (value.density as Density)
				: DEFAULT_DISPLAY.density,
			// Filtered against the real list: a column removed from the product
			// leaves a stale id in someone's browser forever, and it must not
			// resurface as a phantom entry in the column menu.
			hidden: Array.isArray(value.hidden)
				? (value.hidden.filter((c) =>
						(HIDEABLE_COLUMNS as readonly string[]).includes(c),
					) as HideableColumn[])
				: [],
		};
	} catch {
		// Hand-edited or truncated storage is not worth throwing over.
		return DEFAULT_DISPLAY;
	}
}

/**
 * Row density and column visibility for one project's cases table, remembered
 * per browser.
 *
 * Reads on mount rather than during render: `localStorage` does not exist while
 * the server renders this page, and seeding state from it directly would make
 * the first client render disagree with the server's and hydrate badly. The
 * first paint is therefore always the default, which is the honest trade — a
 * settled preference appears a frame later instead of the page erroring.
 */
export function useTableDisplay(projectId: string) {
	const [display, setDisplay] = useState<TableDisplay>(DEFAULT_DISPLAY);
	const key = STORAGE_PREFIX + projectId;

	useEffect(() => {
		setDisplay(parse(window.localStorage.getItem(key)));
	}, [key]);

	const persist = useCallback(
		(next: TableDisplay) => {
			setDisplay(next);
			try {
				window.localStorage.setItem(key, JSON.stringify(next));
			} catch {
				// Private browsing and full quotas both throw here. Losing the
				// preference is survivable; losing the interaction is not.
			}
		},
		[key],
	);

	const setDensity = useCallback(
		(density: Density) => persist({ ...display, density }),
		[display, persist],
	);

	const toggleColumn = useCallback(
		(column: HideableColumn) =>
			persist({
				...display,
				hidden: display.hidden.includes(column)
					? display.hidden.filter((c) => c !== column)
					: [...display.hidden, column],
			}),
		[display, persist],
	);

	const resetColumns = useCallback(
		() => persist({ ...display, hidden: [] }),
		[display, persist],
	);

	return {
		density: display.density,
		hidden: display.hidden,
		isHidden: (column: string) =>
			(display.hidden as string[]).includes(column),
		setDensity,
		toggleColumn,
		resetColumns,
	};
}

export type TableDisplayControls = ReturnType<typeof useTableDisplay>;
