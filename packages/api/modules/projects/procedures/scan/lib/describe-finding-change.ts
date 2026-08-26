/**
 * The activity types this helper can emit — a subset of the DB's
 * `ScanActivityType` enum (kept as a local literal union so the pure helper has
 * no `@repo/database` dependency; the values are assignable to the DB enum at
 * the `recordScanActivity` call site).
 */
export type FindingActivityType =
	| "FINDING_RESOLVED"
	| "FINDING_DISMISSED"
	| "FINDING_REOPENED"
	| "FINDING_EDITED";

/**
 * Pure helper that turns a finding triage edit (status / category / severity)
 * into a single page-history activity entry. Kept side-effect-free so it can be
 * unit-tested without a DB.
 *
 * - A pure status transition keeps its dedicated activity type
 *   (FINDING_RESOLVED / FINDING_DISMISSED / FINDING_REOPENED) so the History
 *   dialog renders the familiar resolve/dismiss/reopen icon.
 * - Any category or severity change (alone or combined with a status change)
 *   becomes a FINDING_EDITED entry whose summary lists every field that moved.
 * - When the patch matches the finding's current values (a no-op), returns
 *   null so the caller records nothing.
 */

export type FindingTriage = {
	title: string;
	status: string;
	category: string;
	severity: string;
};

export type FindingPatch = {
	status?: string;
	category?: string;
	severity?: string;
};

const STATUS_LABEL: Record<string, string> = {
	OPEN: "Open",
	RESOLVED: "Resolved",
	DISMISSED: "Dismissed",
};
const CATEGORY_LABEL: Record<string, string> = {
	SECURITY: "Security",
	ACCESSIBILITY: "Accessibility",
};
const SEVERITY_LABEL: Record<string, string> = {
	CRITICAL: "Critical",
	HIGH: "High",
	MEDIUM: "Medium",
	LOW: "Low",
};

const STATUS_VERB: Record<string, string> = {
	RESOLVED: "Resolved",
	DISMISSED: "Dismissed",
	OPEN: "Reopened",
};
const STATUS_TYPE: Record<string, FindingActivityType> = {
	RESOLVED: "FINDING_RESOLVED",
	DISMISSED: "FINDING_DISMISSED",
	OPEN: "FINDING_REOPENED",
};

const label = (map: Record<string, string>, value: string) =>
	map[value] ?? value;

export function describeFindingChange(
	before: FindingTriage,
	patch: FindingPatch,
): { type: FindingActivityType; summary: string } | null {
	const statusChanged =
		patch.status !== undefined && patch.status !== before.status;
	const categoryChanged =
		patch.category !== undefined && patch.category !== before.category;
	const severityChanged =
		patch.severity !== undefined && patch.severity !== before.severity;

	if (!statusChanged && !categoryChanged && !severityChanged) {
		return null;
	}

	// A pure status transition keeps its dedicated type + verb.
	if (statusChanged && !categoryChanged && !severityChanged && patch.status) {
		return {
			type: STATUS_TYPE[patch.status] ?? "FINDING_EDITED",
			summary: `${STATUS_VERB[patch.status] ?? "Updated"} “${before.title}”`,
		};
	}

	const parts: string[] = [];
	if (severityChanged && patch.severity) {
		parts.push(
			`severity ${label(SEVERITY_LABEL, before.severity)} → ${label(SEVERITY_LABEL, patch.severity)}`,
		);
	}
	if (categoryChanged && patch.category) {
		parts.push(
			`category ${label(CATEGORY_LABEL, before.category)} → ${label(CATEGORY_LABEL, patch.category)}`,
		);
	}
	if (statusChanged && patch.status) {
		parts.push(
			`status ${label(STATUS_LABEL, before.status)} → ${label(STATUS_LABEL, patch.status)}`,
		);
	}

	return {
		type: "FINDING_EDITED",
		summary: `Updated “${before.title}” — ${parts.join(", ")}`,
	};
}
