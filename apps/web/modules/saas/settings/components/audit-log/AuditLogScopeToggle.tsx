"use client";

/**
 * Segmented control that switches the viewer between curated security events
 * and the full activity stream.
 *
 * Exists because completeness and usability pull against each other. Every
 * successful mutation is now captured automatically under the `activity`
 * category, which is what makes the ledger complete — and also what would bury
 * a handful of `auth.login.failure` rows under thousands of routine saves if the
 * viewer opened onto everything at once.
 *
 * Deliberately writes to the EXISTING `categories` filter rather than adding a
 * parallel query parameter: the URL sync, the active-filter pills, and the API
 * shape all already handle categories, so this is a convenience over machinery
 * that already works rather than a second way to express the same thing.
 */

import { cn } from "@ui/lib";
import type { AuditLogFiltersState } from "./types";

/**
 * The `activity` category, kept as a literal here rather than imported from the
 * database package: this is client-bundled code, and pulling a server module in
 * for one string would drag its dependencies along with it.
 */
const ACTIVITY_CATEGORY = "activity";

export type AuditScopeMode = "security" | "activity" | "all";

/**
 * Which mode the current filter state represents.
 *
 * Derived from the filter rather than held as separate state, so a user who
 * edits categories directly (or arrives on a shared URL) sees the toggle agree
 * with the filter actually in effect instead of contradicting it.
 */
function deriveScopeMode(
	filters: AuditLogFiltersState,
	allCategories: string[],
): AuditScopeMode {
	const selected = filters.categories;
	if (selected.length === 0) {
		return "all";
	}
	if (selected.length === 1 && selected[0] === ACTIVITY_CATEGORY) {
		return "activity";
	}
	const curated = allCategories.filter((c) => c !== ACTIVITY_CATEGORY);
	const isExactlyCurated =
		selected.length === curated.length &&
		curated.every((c) => selected.includes(c));
	return isExactlyCurated ? "security" : "all";
}

const MODES: { value: AuditScopeMode; label: string; hint: string }[] = [
	{
		value: "security",
		label: "Security events",
		hint: "Curated auth, access, and lifecycle events",
	},
	{
		value: "activity",
		label: "Activity",
		hint: "Everyday changes captured automatically",
	},
	{ value: "all", label: "Everything", hint: "Both, newest first" },
];

export function AuditLogScopeToggle({
	filters,
	onFiltersChange,
	allCategories,
}: {
	filters: AuditLogFiltersState;
	onFiltersChange: (next: AuditLogFiltersState) => void;
	/** Full category vocabulary from the taxonomy endpoint. */
	allCategories: string[];
}) {
	const active = deriveScopeMode(filters, allCategories);

	function selectMode(mode: AuditScopeMode) {
		const curated = allCategories.filter((c) => c !== ACTIVITY_CATEGORY);
		const categories =
			mode === "security"
				? curated
				: mode === "activity"
					? [ACTIVITY_CATEGORY]
					: [];
		onFiltersChange({ ...filters, categories });
	}

	// Without the taxonomy there is no honest way to say what "security events"
	// means, so the control stays hidden rather than guessing a category list.
	if (allCategories.length === 0) {
		return null;
	}

	return (
		<fieldset
			aria-label="Event scope"
			className="inline-flex rounded-lg border border-border/60 bg-muted/40 p-0.5"
		>
			{MODES.map((mode) => (
				<button
					key={mode.value}
					type="button"
					title={mode.hint}
					aria-pressed={active === mode.value}
					onClick={() => selectMode(mode.value)}
					className={cn(
						"rounded-md px-3 py-1.5 font-medium text-xs transition-colors",
						// Matches the branded ring the shared Button and the
						// sibling active-filter pills already use; a bare browser
						// outline here would be the only unbranded focus state in
						// the viewer.
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
						active === mode.value
							? "bg-card text-foreground shadow-sm"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{mode.label}
				</button>
			))}
		</fieldset>
	);
}
