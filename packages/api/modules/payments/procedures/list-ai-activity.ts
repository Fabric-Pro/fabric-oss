import { ORPCError } from "@orpc/client";
import { listAiUsageActivity } from "@repo/database";
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
	// Multi-select filters: empty array == "no filter", treated the same
	// as omitted at the DB layer. The project array allows literal `null`
	// elements to match rows whose `projectId` is NULL.
	taskTypes: z.array(taskTypeEnum).optional(),
	status: z.enum(["success", "error"]).optional(),
	providerModelIds: z.array(z.string()).optional(),
	projectIds: z.array(z.string().nullable()).optional(),
	userIds: z.array(z.string()).optional(),
	minCostMicroUsd: z.number().int().min(0).optional(),
	maxCostMicroUsd: z.number().int().min(0).optional(),
	minLatencyMs: z.number().int().min(0).optional(),
	maxLatencyMs: z.number().int().min(0).optional(),
	sortBy: z
		.enum(["createdAt", "totalTokens", "costMicroUsd", "latencyMs"])
		.optional(),
	sortOrder: z.enum(["asc", "desc"]).optional(),
	cursor: z.string().optional(),
	limit: z.number().int().min(1).max(100).optional(),
});

export const listAiActivity = tenantProtectedProcedure
	// Visibility-only — no billing permission required. Org access is
	// gated to owners/admins inside the handler via
	// `requireOrganizationAdmin`.
	.route({
		method: "GET",
		path: "/payments/ai-activity",
		tags: ["Payments"],
		summary: "List AI activity history",
		description:
			"Returns paginated AI usage rows plus filtered totals for the activity history view",
	})
	.input(inputSchema)
	.handler(
		async ({
			input: {
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
				sortBy,
				sortOrder,
				cursor,
				limit,
			},
			context: { user },
		}) => {
			// `periodHours` (e.g. last-24h preset) lets the UI request a
			// sub-day window without bending periodDays semantics. Translate
			// it into an explicit { from, to } range here.
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
				sortBy,
				sortOrder,
				cursor,
				limit,
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

				return await listAiUsageActivity({
					organizationId,
					filterUserIds: userIds,
					...sharedArgs,
				});
			}

			return await listAiUsageActivity({
				userId: user.id,
				...sharedArgs,
			});
		},
	);
