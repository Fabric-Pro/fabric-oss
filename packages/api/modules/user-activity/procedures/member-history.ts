/**
 * `userActivity.memberHistory` — daily login buckets + recent auth
 * events for one org member. Returns NOT_FOUND when the
 * target user is not a member of the org, so the endpoint cannot be
 * used to probe activity of users outside the caller's workspace.
 *
 * Emits one `userActivity.viewed` event per successful call (mirrors
 * `audit.viewed`, D12) — this endpoint exposes one member's login times,
 * IPs, and user agents, so every read needs an audit trail of its own.
 * `metadata.targetUserId` names the viewed member. The meta event is
 * fire-and-forget — a failure to record it must never fail the read for
 * the user.
 */
import { ORPCError } from "@orpc/server";
import { getMemberLoginHistory } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import { requireAuditLogReadOrDeploymentAdmin } from "../../../orpc/middleware/require-audit-log-read";
import { protectedProcedure } from "../../../orpc/procedures";
import { isUserActivityDashboardEnabled } from "../lib/flag";

const inputSchema = z.object({
	organizationId: z.string().min(1),
	userId: z.string().min(1),
	rangeDays: z
		.union([z.literal(7), z.literal(30), z.literal(90)])
		.optional()
		.default(30),
});

const outputSchema = z.object({
	user: z.object({
		id: z.string(),
		name: z.string().nullable(),
		email: z.string(),
		image: z.string().nullable(),
	}),
	role: z.string(),
	lastSeenAt: z.date().nullable(),
	buckets: z.array(z.object({ day: z.string(), count: z.number() })),
	totalLoginsInRange: z.number(),
	recentEvents: z.array(
		z.object({
			action: z.string(),
			createdAt: z.date(),
			ipAddress: z.string().nullable(),
			userAgent: z.string().nullable(),
		}),
	),
});

export const getMemberLoginHistoryProcedure = protectedProcedure
	.input(inputSchema)
	.use(requireAuditLogReadOrDeploymentAdmin())
	.route({
		method: "POST",
		path: "/user-activity/member-history",
		tags: ["UserActivity"],
		summary: "Login history for one org member",
	})
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		if (!isUserActivityDashboardEnabled()) {
			throw new ORPCError("NOT_FOUND", {
				message: "User activity dashboard is not enabled",
			});
		}
		const history = await getMemberLoginHistory({
			organizationId: input.organizationId,
			userId: input.userId,
			rangeDays: input.rangeDays,
		});
		if (!history) {
			throw new ORPCError("NOT_FOUND", {
				message: "User is not a member of this organization",
			});
		}

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
				endpoint: "memberHistory",
				targetUserId: input.userId,
			},
		});

		return history;
	});
