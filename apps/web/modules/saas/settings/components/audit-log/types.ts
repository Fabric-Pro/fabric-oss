/**
 * Shared types for the audit-log viewer components.
 */

/**
 * Where the audit-log viewer is mounted:
 *  - `"organization"` — in-product `/app/{slug}/settings/audit-log`. Full
 *    surface incl. actor + project filters; rows come from
 *    `orpc.audit.list({ organizationId })`.
 *  - `"personal"` — in-product `/app/settings/audit-log`. Actor chip is a
 *    static pin (the current user); project filter is suppressed.
 *  - `"explorer"` — staff dogfooding surface at
 *    `/app/admin/audit-log-explorer`. Actor + project filters are hidden
 *    (the proxy procedure has no view of the customer's directory) and
 *    the data source is overridden via the `dataSource` prop on the
 *    table / export button.
 */
export type AuditViewerMode = "organization" | "personal" | "explorer";

export type AuditSortOrder = "newest" | "oldest" | "severity_desc";

/** Actor type buckets surfaced inside the actor popover's "Custom" section. */
export type AuditActorType = "user" | "api_key" | "system" | "agent";

export interface AuditViewerUser {
	id: string;
	email: string;
	name: string | null;
}

export interface AuditLogFiltersState {
	actions: string[];
	categories: string[];
	actorIds: string[];
	/**
	 * Actor type buckets. When non-empty, the API restricts the result set to
	 * rows where `actorType IN (...selected)`. Empty array == no actor-type
	 * restriction.
	 */
	actorTypes: AuditActorType[];
	projectId?: string;
	severities: string[];
	outcomes: string[];
	dateFrom?: string;
	dateTo?: string;
	/**
	 * Exact-match filter on `metadata.correlationId`. Used by the viewer to
	 * pull every row participating in a single request flow (D16).
	 */
	correlationId?: string;
	/**
	 * Case-insensitive substring match on `ipAddress`.
	 */
	ipAddressContains?: string;
}

export const EMPTY_FILTERS_STATE: AuditLogFiltersState = {
	actions: [],
	categories: [],
	actorIds: [],
	actorTypes: [],
	severities: [],
	outcomes: [],
};

/**
 * Convert the URL-side filter state (string arrays) to the API filter
 * shape (Dates for date fields). Returns an object suitable for passing
 * straight into `orpcClient.audit.list({ filter })`.
 */
export function filtersStateToApi(state: AuditLogFiltersState): {
	actions?: string[];
	categories?: string[];
	actorIds?: string[];
	actorTypes?: AuditActorType[];
	projectId?: string;
	severities?: ("info" | "warning" | "error" | "critical")[];
	outcomes?: ("success" | "failure")[];
	dateFrom?: Date;
	dateTo?: Date;
	correlationId?: string;
	ipAddressContains?: string;
} {
	return {
		...(state.actions.length > 0 && { actions: state.actions }),
		...(state.categories.length > 0 && {
			categories: state.categories,
		}),
		...(state.actorIds.length > 0 && { actorIds: state.actorIds }),
		...(state.actorTypes.length > 0 && { actorTypes: state.actorTypes }),
		...(state.projectId && { projectId: state.projectId }),
		...(state.severities.length > 0 && {
			severities: state.severities as (
				| "info"
				| "warning"
				| "error"
				| "critical"
			)[],
		}),
		...(state.outcomes.length > 0 && {
			outcomes: state.outcomes as ("success" | "failure")[],
		}),
		...(state.dateFrom && { dateFrom: new Date(state.dateFrom) }),
		...(state.dateTo && { dateTo: new Date(state.dateTo) }),
		...(state.correlationId && { correlationId: state.correlationId }),
		...(state.ipAddressContains && {
			ipAddressContains: state.ipAddressContains,
		}),
	};
}

/**
 * Returns true when no user-selectable filter is active (mode-specific
 * actor pin in personal mode is considered "default" and ignored).
 */
export function isFiltersEmpty(
	state: AuditLogFiltersState,
	mode: AuditViewerMode = "organization",
	currentUserId?: string,
): boolean {
	const actorActive =
		mode === "personal" && currentUserId
			? state.actorIds.length > 0 &&
				!(
					state.actorIds.length === 1 &&
					state.actorIds[0] === currentUserId
				)
			: state.actorIds.length > 0;
	return (
		state.actions.length === 0 &&
		state.categories.length === 0 &&
		!actorActive &&
		state.actorTypes.length === 0 &&
		!state.projectId &&
		state.severities.length === 0 &&
		state.outcomes.length === 0 &&
		!state.dateFrom &&
		!state.dateTo &&
		!state.correlationId &&
		!state.ipAddressContains
	);
}
