/**
 * Historical status announcements for the customer surface.
 *
 * Auth: `protectedProcedure` — any authenticated user. Announcement history is
 * global platform information with no tenant-specific content, so there is
 * nothing to scope; the auth requirement exists because Fabric does not publish
 * an unauthenticated status page (see the spec's out-of-scope note).
 */
import { listStatusUpdateHistory } from "@repo/database";
import { z } from "zod";
import { protectedProcedure } from "../../../orpc/procedures";

export const listStatusHistoryProcedure = protectedProcedure
	.route({
		method: "GET",
		path: "/system-health/history",
		tags: ["System Health"],
		summary: "Past status announcements",
	})
	.input(
		z.object({
			// Bounds mirror the query helper's own clamps. Declared here too so a
			// bad value is a validation error at the edge rather than being
			// silently coerced deeper in.
			sinceDays: z.number().int().min(1).max(365).default(90),
			limit: z.number().int().min(1).max(200).default(50),
		}),
	)
	.handler(async ({ input }) => {
		const updates = await listStatusUpdateHistory({
			sinceDays: input.sinceDays,
			limit: input.limit,
		});
		return { updates };
	});
