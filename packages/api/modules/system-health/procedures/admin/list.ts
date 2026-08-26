/**
 * Admin listing of status announcements, including the internal incident
 * back-pointers the customer projection withholds — so an operator can navigate
 * from an announcement to the detection that prompted it.
 *
 * Auth: `adminProcedure`.
 */
import { listStatusUpdatesForAdmin } from "@repo/database";
import { listPlatformComponents } from "@repo/observability";
import { z } from "zod";
import { adminProcedure } from "../../../../orpc/procedures";

export const listStatusUpdatesAdminProcedure = adminProcedure
	.route({
		method: "GET",
		path: "/system-health/admin/status-updates",
		tags: ["System Health"],
		summary: "List status announcements with operator detail",
	})
	.input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
	.handler(async ({ input }) => {
		const updates = await listStatusUpdatesForAdmin({ limit: input.limit });
		return {
			updates,
			// Shipped alongside so the authoring form can offer the real component
			// keys rather than a hand-maintained copy that drifts from the registry.
			components: listPlatformComponents().map((c) => ({
				key: c.key,
				displayName: c.displayName,
				group: c.group,
				customerVisible: c.customerVisible !== false,
			})),
		};
	});
