/**
 * Where the My time page's view and date live. Both are in the URL
 * (`?view=week&date=YYYY-MM-DD`) so a reload or a shared link keeps them; the
 * last view chosen is also remembered per browser, for visits with no `view`
 * in the URL.
 */

import { isIsoDate } from "@repo/utils/time-tracking";

export type TimeView = "day" | "week";

const VIEW_STORAGE_KEY = "fabric:time-tracking:view";

function isTimeView(value: string | null | undefined): value is TimeView {
	return value === "day" || value === "week";
}

export function readRememberedView(): TimeView | null {
	try {
		const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
		return isTimeView(stored) ? stored : null;
	} catch {
		return null;
	}
}

export function rememberView(view: TimeView): void {
	try {
		window.localStorage.setItem(VIEW_STORAGE_KEY, view);
	} catch {
		// Storage can be blocked (private windows, site-data settings); the URL
		// still carries the view for this visit.
	}
}

/** The view and date the page shows for these query parameters. */
export function resolveViewState(params: {
	view: string | null;
	date: string | null;
	rememberedView: TimeView | null;
	today: string;
}): { view: TimeView; date: string } {
	return {
		view: isTimeView(params.view)
			? params.view
			: (params.rememberedView ?? "week"),
		date:
			params.date && isIsoDate(params.date) ? params.date : params.today,
	};
}
