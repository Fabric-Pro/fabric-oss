/**
 * `userActivity.listMembers` — per-member last login + login count for
 * the org-scoped User Activity dashboard.
 *
 * Authorization: same gate as `audit.list` (ORG_AUDIT_LOG_READ via
 * owner/admin membership, or the deployment-admin env-list bypass).
 * `organizationId` is REQUIRED (min 1) so the middleware's
 * personal-context pass-through branch can never be reached.
 *
 * Emits one `userActivity.viewed` event per successful call (mirrors
 * `audit.viewed`, D12) — this endpoint exposes member login times, IPs,
 * and user agents, so every read needs an audit trail of its own. The
 * meta event is fire-and-forget — a failure to record it must never
 * fail the read for the user.
 */
import { ORPCError } from "@orpc/server";
import { listMemberActivity } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import { requireAuditLogReadOrDeploymentAdmin } from "../../../orpc/middleware/require-audit-log-read";
import { protectedProcedure } from "../../../orpc/procedures";
import { isUserActivityDashboardEnabled } from "../lib/flag";

const inputSchema = z.object({
	organizationId: z.string().min(1),
	rangeDays: z
		.union([z.literal(7), z.literal(30), z.literal(90)])
		.optional()
		.default(30),
	sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
	query: z.string().max(256).optional().default(""),
	limit: z.number().int().min(1).max(100).optional().default(25),
	offset: z.number().int().min(0).optional().default(0),
});

const outputSchema = z.object({
	items: z.array(
		z.object({
			userId: z.string(),
			name: z.string().nullable(),
			email: z.string(),
			image: z.string().nullable(),
			role: z.string(),
			lastSeenAt: z.date().nullable(),
			lastLoginAt: z.date().nullable(),
			loginCountInRange: z.number(),
		}),
	),
	total: z.number(),
});

export const listMemberActivityProcedure = protectedProcedure
	.input(inputSchema)
	.use(requireAuditLogReadOrDeploymentAdmin())
	.route({
		method: "POST",
		path: "/user-activity/list-members",
		tags: ["UserActivity"],
		summary: "List org members with last login and login count",
	})
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		if (!isUserActivityDashboardEnabled()) {
			throw new ORPCError("NOT_FOUND", {
				message: "User activity dashboard is not enabled",
			});
		}
		const result = await listMemberActivity({
			organizationId: input.organizationId,
			rangeDays: input.rangeDays,
			sortDir: input.sortDir,
			query: input.query,
			limit: input.limit,
			offset: input.offset,
		});

		// Emit the meta-event AFTER a successful read. Fire-and-forget so a
		// failure in the meta-write never breaks the read (mirrors
		// `audit.list`'s `audit.viewed` emission, D12).
		recordAuditFromRequest(context, {
			action: "userActivity.viewed",
			category: "audit",
			organizationId: input.organizationId,
			outcome: "success",
			severity: "info",
			metadata: {
				endpoint: "listMembers",
				resultCount: result.items.length,
			},
		});

		return result;
	});
