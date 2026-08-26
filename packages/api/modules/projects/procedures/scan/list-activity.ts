import { ORPCError } from "@orpc/server";
import { hasProjectAccess, listScanActivity } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

// Local literal union (the generated `ScanActivityType` isn't re-exported from
// @repo/database; these values are assignable to it at the query call site).
type ActivityType =
	| "SCAN_STARTED"
	| "SCAN_COMPLETED"
	| "SCAN_FAILED"
	| "FINDING_RESOLVED"
	| "FINDING_DISMISSED"
	| "FINDING_REOPENED"
	| "FINDING_EDITED"
	| "FINDING_CONVERTED"
	| "CONFIG_UPDATED"
	| "FINDINGS_PURGED"
	| "FINDINGS_REVIEWED"
	| "REVIEW_STARTED"
	| "REVIEW_CANCELLED"
	| "FINDINGS_GROUPED";

// Two history views: scan runs + config ("SCANS"), and per-finding changes
// ("FINDINGS") — including the AI review lifecycle (started / cancelled /
// applied) and purge. Omitting the group returns everything (back-compat).
const SCAN_TYPES: ActivityType[] = [
	"SCAN_STARTED",
	"SCAN_COMPLETED",
	"SCAN_FAILED",
	"CONFIG_UPDATED",
];
const FINDING_TYPES: ActivityType[] = [
	"FINDING_RESOLVED",
	"FINDING_DISMISSED",
	"FINDING_REOPENED",
	"FINDING_EDITED",
	"FINDING_CONVERTED",
	"FINDINGS_PURGED",
	"FINDINGS_REVIEWED",
	"REVIEW_STARTED",
	"REVIEW_CANCELLED",
	"FINDINGS_GROUPED",
];

/**
 * Global "History" feed for a project's Security & Accessibility page — scan
 * runs, finding status changes, work-item conversions, and config edits, with
 * who and when. Read-gated by project access.
 */
export const listActivityProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/scan/activity",
		tags: ["Projects", "Security"],
		summary: "List Security & Accessibility page history",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			limit: z.number().min(1).max(200).optional(),
			group: z.enum(["SCANS", "FINDINGS"]).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const hasAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			input.organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}
		const types =
			input.group === "SCANS"
				? SCAN_TYPES
				: input.group === "FINDINGS"
					? FINDING_TYPES
					: undefined;
		const activity = await listScanActivity(input.projectId, {
			limit: input.limit,
			types,
		});
		return { activity };
	});
