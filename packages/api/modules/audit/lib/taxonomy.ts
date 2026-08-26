/**
 * Audit-log taxonomy re-export.
 *
 * The closed taxonomy of action keys and categories lives in
 * `@repo/database` (next to the helpers that emit them). We re-export
 * from this module so the audit-log procedure and any frontend caller
 * can pull from a single API-package symbol without reaching into the
 * database package directly.
 *
 * Spec: docs/audit-log/README.md
 * D2 (action taxonomy).
 */

export {
	AUDIT_ACTIONS,
	AUDIT_CATEGORIES,
	ERROR_ACTIONS,
} from "@repo/database";
