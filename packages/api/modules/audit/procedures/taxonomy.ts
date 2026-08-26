/**
 * `audit.taxonomy` — static event vocabulary for the filter chip
 * dictionary on the audit-log viewer.
 *
 * Authorization: `protectedProcedure` only — no `ORG_AUDIT_LOG_READ`
 * required. The taxonomy is the closed set of action keys and category
 * names, documented in this spec; exposing it to a regular authenticated
 * user is not a leak. Both org admins and personal-context users need
 * the same dictionary for their filter chips.
 *
 * Spec: docs/audit-log/README.md §6.3.
 */

import { protectedProcedure } from "../../../orpc/procedures";
import { auditTaxonomyOutputSchema } from "../lib/schemas";
import {
	AUDIT_ACTIONS,
	AUDIT_CATEGORIES,
	ERROR_ACTIONS,
} from "../lib/taxonomy";

export const getAuditTaxonomyProcedure = protectedProcedure
	.route({
		method: "GET",
		path: "/audit/taxonomy",
		tags: ["Audit"],
		summary: "List action keys and categories",
		description:
			"Return the closed taxonomy for filter chips on the audit-log viewer.",
	})
	.output(auditTaxonomyOutputSchema)
	.handler(() => ({
		actions: [...AUDIT_ACTIONS],
		categories: [...AUDIT_CATEGORIES],
		// D16: error.* is an open-namespace complement to the closed
		// success taxonomy; the viewer presents these in a separate group.
		errorActions: [...ERROR_ACTIONS],
	}));
