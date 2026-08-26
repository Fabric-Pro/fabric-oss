/**
 * Sync Schedule Procedures
 *
 * Configure automatic sync schedules for data connections.
 */

import { ORPCError } from "@orpc/client";
import {
	getDataConnectionById,
	SyncFrequencySchema,
	upsertSyncSchedule,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

// Calculate next run time based on frequency
function calculateNextRunAt(frequency: string): Date {
	const now = new Date();

	switch (frequency) {
		case "REALTIME":
			// Real-time is webhook-based, next run is not applicable
			return now;
		case "EVERY_5_MIN":
			return new Date(now.getTime() + 5 * 60 * 1000);
		case "HOURLY":
			return new Date(now.getTime() + 60 * 60 * 1000);
		case "EVERY_8_HOURS":
			return new Date(now.getTime() + 8 * 60 * 60 * 1000);
		case "DAILY":
			return new Date(now.getTime() + 24 * 60 * 60 * 1000);
		case "WEEKLY":
			return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
		default:
			return new Date(now.getTime() + 60 * 60 * 1000); // Default to hourly
	}
}

/**
 * Update sync schedule for a connection.
 */
const updateScheduleProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_MANAGE))
	.route({
		method: "PUT",
		path: "/data-connections/:id/schedule",
		tags: ["DataConnections"],
		summary: "Update sync schedule",
		description: "Configure automatic sync schedule for a data connection",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			frequency: SyncFrequencySchema,
			cronExpression: z.string().optional(),
			isActive: z.boolean().default(true),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		// Verify connection exists and belongs to tenant
		const connection = await getDataConnectionById({
			id: input.id,
			userId: user.id,
			organizationId,
		});

		if (!connection) {
			throw new ORPCError("NOT_FOUND", {
				message: "Connection not found",
			});
		}

		// Validate cron expression if CUSTOM frequency
		if (input.frequency === "CUSTOM" && !input.cronExpression) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Custom frequency requires a cron expression",
			});
		}

		// Calculate next run time
		const nextRunAt = input.isActive
			? calculateNextRunAt(input.frequency)
			: null;

		const schedule = await upsertSyncSchedule({
			connectionId: connection.id,
			frequency: input.frequency as any,
			cronExpression: input.cronExpression,
			isActive: input.isActive,
			nextRunAt,
		});

		return { schedule };
	});

/**
 * Pause sync schedule.
 */
const pauseScheduleProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_MANAGE))
	.route({
		method: "POST",
		path: "/data-connections/:id/schedule/pause",
		tags: ["DataConnections"],
		summary: "Pause sync schedule",
		description: "Pause automatic syncing for a data connection",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		// Verify connection exists and belongs to tenant
		const connection = await getDataConnectionById({
			id: input.id,
			userId: user.id,
			organizationId,
		});

		if (!connection) {
			throw new ORPCError("NOT_FOUND", {
				message: "Connection not found",
			});
		}

		if (!connection.schedules || connection.schedules.length === 0) {
			throw new ORPCError("NOT_FOUND", {
				message: "No schedule configured for this connection",
			});
		}

		const schedule = await upsertSyncSchedule({
			connectionId: connection.id,
			frequency: connection.schedules[0].frequency as any,
			isActive: false,
			nextRunAt: null,
		});

		return { schedule };
	});

/**
 * Resume sync schedule.
 */
const resumeScheduleProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DATA_CONNECTIONS_MANAGE))
	.route({
		method: "POST",
		path: "/data-connections/:id/schedule/resume",
		tags: ["DataConnections"],
		summary: "Resume sync schedule",
		description: "Resume automatic syncing for a data connection",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		// Verify connection exists and belongs to tenant
		const connection = await getDataConnectionById({
			id: input.id,
			userId: user.id,
			organizationId,
		});

		if (!connection) {
			throw new ORPCError("NOT_FOUND", {
				message: "Connection not found",
			});
		}

		if (!connection.schedules || connection.schedules.length === 0) {
			throw new ORPCError("NOT_FOUND", {
				message: "No schedule configured for this connection",
			});
		}

		const existingSchedule = connection.schedules[0];
		const nextRunAt = calculateNextRunAt(existingSchedule.frequency);

		const schedule = await upsertSyncSchedule({
			connectionId: connection.id,
			frequency: existingSchedule.frequency as any,
			cronExpression: existingSchedule.cronExpression,
			isActive: true,
			nextRunAt,
		});

		return { schedule };
	});

export const scheduleProcedures = {
	update: updateScheduleProcedure,
	pause: pauseScheduleProcedure,
	resume: resumeScheduleProcedure,
};
