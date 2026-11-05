import { z } from "zod";

const id = z.string().trim().min(1).max(200);
export const workflowIdentitySchema = z.strictObject({ workflowId: id });
export const workflowPublishSchema = workflowIdentitySchema.extend({
	changelog: z.string().trim().max(2000).optional(),
	enableWebhook: z.boolean().optional(),
});
export const workflowRollbackSchema = workflowIdentitySchema.extend({
	targetVersion: z.number().int().positive(),
});
export const workflowVersionsSchema = workflowIdentitySchema.extend({
	limit: z.number().int().min(1).max(100).default(20),
	offset: z.number().int().nonnegative().default(0),
});
export const workflowScheduleSchema = workflowIdentitySchema.extend({
	cron: z.string().trim().min(1).max(200),
	timezone: z.string().trim().min(1).max(100).default("UTC"),
});
