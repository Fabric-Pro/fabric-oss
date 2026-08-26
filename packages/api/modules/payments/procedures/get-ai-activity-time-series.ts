import { ORPCError } from "@orpc/client";
import { getAiUsageActivityTimeSeries } from "@repo/database";
import { z } from "zod";
import {
	requireOrganizationAdmin,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const taskTypeEnum = z.enum([
	"SIMPLE",
	"COMPLEX",
	"REASONING",
	"CHAT",
	"TOOL_CALLING",
	"EMBEDDING",
	"IMAGE",
	"AUDIO",
	"EVAL",
]);

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	periodDays: z.number().int().min(1).max(365).optional(),
	periodHours: z
		.number()
		.int()
		.min(1)
		.max(24 * 365)
		.optional(),
	from: z.coerce.date().optional(),
	to: z.coerce.date().optional(),
	// Multi-select filters: see list-ai-activity for the same semantics.
	taskTypes: z.array(taskTypeEnum).optional(),
	status: z.enum(["success", "error"]).optional(),
	providerModelIds: z.array(z.string()).optional(),
	projectIds: z.array(z.string().nullable()).optional(),
	userIds: z.array(z.string()).optional(),
	minCostMicroUsd: z.number().int().min(0).optional(),
	maxCostMicroUsd: z.number().int().min(0).optional(),
	minLatencyMs: z.number().int().min(0).optional(),
	maxLatencyMs: z.number().int().min(0).optional(),
	granularity: z.enum(["day", "hour", "minute"]).optional(),
});

export const getAiActivityTimeSeries = tenantProtectedProcedure
	// Visibility-only — org access gated to owners/admins inside handler.
	.route({
		method: "GET",
		path: "/payments/ai-activity-time-series",
		tags: ["Payments"],
		summary: "Daily AI activity buckets for the activity-history chart",
	})
	.input(inputSchema)
	.handler(async ({ input, context: { user } }) => {
		const {
			organizationId,
			periodDays,
			periodHours,
			from,
			to,
			taskTypes,
			status,
			providerModelIds,
			projectIds,
			userIds,
			minCostMicroUsd,
			maxCostMicroUsd,
			minLatencyMs,
			maxLatencyMs,
		} = input;

		let resolvedFrom = from;
		let resolvedTo = to;
		if (!from && !to && typeof periodHours === "number") {
			resolvedTo = new Date();
			resolvedFrom = new Date(
				resolvedTo.getTime() - periodHours * 3_600_000,
			);
		}

		const sharedArgs = {
			periodDays:
				typeof periodHours === "number" ? undefined : periodDays,
			from: resolvedFrom,
			to: resolvedTo,
			taskTypes,
			status,
			providerModelIds,
			projectIds,
			minCostMicroUsd,
			maxCostMicroUsd,
			minLatencyMs,
			maxLatencyMs,
			granularity: input.granularity,
		};

		if (organizationId) {
			await requireOrganizationAdmin(organizationId, user.id).catch(
				() => {
					throw new ORPCError("FORBIDDEN", {
						message:
							"Only organization owners or admins can view organization AI activity",
					});
				},
			);

			const points = await getAiUsageActivityTimeSeries({
				organizationId,
				filterUserIds: userIds,
				...sharedArgs,
			});
			return { points };
		}

		const points = await getAiUsageActivityTimeSeries({
			userId: user.id,
			...sharedArgs,
		});
		return { points };
	});
