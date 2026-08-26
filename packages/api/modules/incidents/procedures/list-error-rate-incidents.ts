/**
 * List ErrorRateIncident rows (admin-only).
 *
 * Cursor-paginated, newest first. Filters: status, severity, service,
 * feature, sinceDays.
 *
 * Tenant scope: GLOBAL — `ErrorRateIncident` is a global table.
 * Admins own thresholds; per-org rollup is handled via the
 * Notification system (see `incident-notifications.ts`).
 */
import { listErrorRateIncidents } from "@repo/database";
import { z } from "zod";
import { adminProcedure } from "../../../orpc/procedures";

const inputSchema = z.object({
	status: z.enum(["FIRING", "ACKNOWLEDGED", "RESOLVED"]).optional(),
	severity: z.enum(["SEV1", "SEV2", "SEV3"]).optional(),
	service: z.string().optional(),
	feature: z.string().optional(),
	sinceDays: z.number().int().min(1).max(365).default(30),
	cursor: z.string().optional(),
	limit: z.number().int().min(1).max(100).default(50),
});

export const listErrorRateIncidentsProcedure = adminProcedure
	.route({
		method: "GET",
		path: "/incidents/error-rate",
		tags: ["Incidents"],
		summary: "List error-rate incidents",
		description:
			"List error-rate incidents with cursor pagination. Admin-only.",
	})
	.input(inputSchema)
	.handler(async ({ input }) => {
		const result = await listErrorRateIncidents(input);
		return {
			incidents: result.items,
			nextCursor: result.nextCursor,
		};
	});
