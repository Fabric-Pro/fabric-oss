/**
 * Scope vocabulary for the read-only external observability surface.
 *
 * Three separate procedures mint API keys (personal, organization, and the
 * audit-log settings drawer), each with its own scope list — deliberately, since
 * personal and org keys grant genuinely different things. What they must NOT do
 * is each spell these strings out independently: a scope string that exists in
 * the key-creation enum but not in the route's check (or vice versa) is a key
 * that authenticates and then mysteriously 403s.
 *
 * So the strings live here once and every list references them.
 */

export const OBSERVABILITY_SCOPES = {
	/** `GET /api/v1/audit-log` — read the key owner's audit trail. */
	AUDIT_LOG_READ: "audit_log:read",
	/** `GET /api/v1/audit-log/export` — bulk export of the same. */
	AUDIT_LOG_EXPORT: "audit_log:export",
	/**
	 * `GET /api/v1/system-health` — component status plus active announcements.
	 *
	 * Separate from `STATUS_UPDATES_READ` because this response includes the
	 * tenant's OWN signals (their failure rate, their connection health), so it
	 * is not equivalent to public platform status.
	 */
	SYSTEM_HEALTH_READ: "system_health:read",
	/**
	 * `GET /api/v1/status-updates` — published announcements and their history.
	 *
	 * Contains no tenant-specific data, so it can be granted to something that
	 * should see platform announcements without seeing anything about the
	 * customer's own workspace.
	 */
	STATUS_UPDATES_READ: "status_updates:read",
} as const;

export type ObservabilityScope =
	(typeof OBSERVABILITY_SCOPES)[keyof typeof OBSERVABILITY_SCOPES];

/** Every observability scope, for key-creation enums. */
export const ALL_OBSERVABILITY_SCOPES = Object.values(
	OBSERVABILITY_SCOPES,
) as ObservabilityScope[];

/**
 * Does the key's scope array grant `required`?
 *
 * The `*` wildcard (already part of the org-key vocabulary) grants everything.
 */
export function hasObservabilityScope(
	scopes: readonly string[],
	required: ObservabilityScope,
): boolean {
	return scopes.includes(required) || scopes.includes("*");
}
