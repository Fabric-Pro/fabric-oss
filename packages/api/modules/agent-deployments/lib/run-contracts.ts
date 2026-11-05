import { z } from "zod";
export const agentRunIdSchema = z.string().trim().min(1).max(200);
export const agentRunInstanceSchema = z.strictObject({
	instanceId: agentRunIdSchema,
});
export const agentRunIdentitySchema = z.strictObject({
	executionId: agentRunIdSchema,
});
export const agentRunListSchema = agentRunInstanceSchema.extend({
	limit: z.number().int().min(1).max(50).default(20),
});
export const agentRunMessageSchema = z.strictObject({
	message: z.string().trim().min(1).max(20000),
});
export const agentRunScheduleSchema = agentRunInstanceSchema.extend({
	cronExpression: z.string().trim().min(1).max(200),
	timezone: z.string().trim().min(1).max(100),
	input: agentRunMessageSchema,
	enabled: z.boolean(),
});

/** Owner-scoped metadata search; outputs and traces are fetched only by runs.get. */
export const agentRunHistorySchema = z
	.strictObject({
		instanceId: agentRunIdSchema.optional(),
		status: z
			.enum(["ACTIVE", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"])
			.optional(),
		triggerType: z
			.enum(["MANUAL", "SCHEDULE", "API", "WEBHOOK", "EVENT", "SLACK"])
			.optional(),
		from: z.iso.datetime({ offset: true }).optional(),
		to: z.iso.datetime({ offset: true }).optional(),
		query: z
			.string()
			.trim()
			.min(1)
			.max(200)
			.regex(/^[^\p{Cc}]*$/u)
			.optional(),
		cursor: z
			.string()
			.min(1)
			.max(4096)
			.regex(/^[A-Za-z0-9_-]+$/)
			.optional(),
		limit: z.number().int().min(1).max(50).default(25),
	})
	.refine(
		(value) =>
			!value.from ||
			!value.to ||
			new Date(value.from) <= new Date(value.to),
		{ message: "from must be no later than to" },
	);
