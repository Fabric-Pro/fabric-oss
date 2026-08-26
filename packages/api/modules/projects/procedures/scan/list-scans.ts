import { ORPCError } from "@orpc/server";
import {
	getLatestProjectScan,
	hasProjectAccess,
	listProjectScans,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/** Most-recent scan for a project (optionally a feature) — drives polling. */
export const getLatestScanProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/scan/latest",
		tags: ["Projects", "Security"],
		summary: "Get the latest scan run",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			storyId: z.string().optional(),
			// Branch-aware summary + polling: when set, returns the latest scan
			// that ran against this branch. Omitted means latest regardless of
			// branch (current behavior).
			branch: z.string().max(255).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, organizationId, storyId, branch } = input;
		const hasAccess = await hasProjectAccess(
			projectId,
			context.user.id,
			organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}
		const scan = await getLatestProjectScan(projectId, {
			storyId,
			...(branch !== undefined ? { branch } : {}),
		});
		return { scan };
	});

/** Recent scan runs for the project history view. */
export const listScansProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/scan/runs",
		tags: ["Projects", "Security"],
		summary: "List recent scan runs",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			limit: z.number().min(1).max(100).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, organizationId, limit } = input;
		const hasAccess = await hasProjectAccess(
			projectId,
			context.user.id,
			organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}
		const scans = await listProjectScans(projectId, { limit });
		return { scans };
	});
