"use client";

import { useCallback, useEffect, useState } from "react";
import { VIEW_PARAM_NAMES } from "./use-test-cases-view";

export type SavedView = {
	id: string;
	name: string;
	/** The view's own query params, already normalised — see `captureView`. */
	query: string;
};

const STORAGE_PREFIX = "fabric.testCases.views.";
/** Names are shown in a menu; anything longer stops being scannable. */
export const SAVED_VIEW_NAME_MAX = 40;
/**
 * More than this and the menu is worse than re-applying the filters by hand.
 * A cap that is never explained reads as a bug, so the menu says when it is hit.
 */
export const SAVED_VIEW_LIMIT = 12;

/**
 * Reduce a URL's query to just the params the cases view owns.
 *
 * A saved view must not carry `?case=<id>` — that deep-links one case's editor
 * open, and a view called "Failing, critical" that also reopens a specific case
 * every time it is applied is a trap. Equally it must not carry params some
 * other feature adds later: this whitelists rather than blacklists, so a new
 * unrelated param cannot silently become part of everyone's saved views.
 */
export function captureView(search: string): string {
	const from = new URLSearchParams(search);
	const out = new URLSearchParams();
	// Iterating VIEW_PARAM_NAMES rather than `from` keeps the saved order
	// stable, so two identical views compare equal as strings.
	for (const name of VIEW_PARAM_NAMES) {
		const value = from.get(name);
		if (value !== null && value !== "") {
			out.set(name, value);
		}
	}
	return out.toString();
}

function parse(raw: string | null): SavedView[] {
	if (!raw) {
		return [];
	}
	try {
		const value = JSON.parse(raw);
		if (!Array.isArray(value)) {
			return [];
		}
		return value
			.filter(
				(v): v is SavedView =>
					!!v &&
					typeof v.id === "string" &&
					typeof v.name === "string" &&
					typeof v.query === "string",
			)
			.slice(0, SAVED_VIEW_LIMIT);
	} catch {
		return [];
	}
}

/**
 * Named filter/sort/page combinations, per project, per browser.
 *
 * Stored rather than server-side because a view is a reading habit, not project
 * data: two people looking at the same suite want different shortlists, and
 * neither wants the other's appearing in their menu. It is deliberately the
 * same query string the address bar already holds, so a saved view and a pasted
 * link are the same thing — anything expressible as one is expressible as the
 * other.
 */
export function useSavedViews(projectId: string) {
	const [views, setViews] = useState<SavedView[]>([]);
	const key = STORAGE_PREFIX + projectId;

	// On mount, not during render: `localStorage` does not exist server-side.
	useEffect(() => {
		setViews(parse(window.localStorage.getItem(key)));
	}, [key]);

	const persist = useCallback(
		(next: SavedView[]) => {
			setViews(next);
			try {
				window.localStorage.setItem(key, JSON.stringify(next));
			} catch {
				// Private browsing and full quotas both throw. Losing the view is
				// survivable; losing the click is not.
			}
		},
		[key],
	);

	const save = useCallback(
		(name: string, search: string) => {
			const trimmed = name.trim().slice(0, SAVED_VIEW_NAME_MAX);
			if (!trimmed) {
				return;
			}
			const query = captureView(search);
			// Saving over an existing name replaces it rather than producing two
			// entries a reader cannot tell apart.
			const rest = views.filter(
				(v) => v.name.toLowerCase() !== trimmed.toLowerCase(),
			);
			persist(
				[
					{
						id: `${Date.now()}-${rest.length}`,
						name: trimmed,
						query,
					},
					...rest,
				].slice(0, SAVED_VIEW_LIMIT),
			);
		},
		[persist, views],
	);

	const remove = useCallback(
		(id: string) => persist(views.filter((v) => v.id !== id)),
		[persist, views],
	);

	/** The saved view the current URL matches, if any — names the trigger. */
	const matching = useCallback(
		(search: string) => {
			const current = captureView(search);
			return views.find((v) => v.query === current) ?? null;
		},
		[views],
	);

	return {
		views,
		save,
		remove,
		matching,
		atLimit: views.length >= SAVED_VIEW_LIMIT,
	};
}

export type SavedViewsControls = ReturnType<typeof useSavedViews>;
