import type { LimitSignal } from "@repo/ai/limits";
import { z } from "zod";
import {
	encodeChatStreamEvent,
	parseVersionedChatEvent,
} from "./chat-stream-protocol";

export const toolFields = {
	toolCallId: z.string().optional(),
	toolName: z.string().optional(),
	name: z.string().optional(),
	serverName: z.string().optional(),
	args: z.unknown().optional(),
	status: z.enum(["pending", "running", "complete", "error"]).optional(),
	mcpAppResourceUri: z.string().optional(),
	mcpAppConfigId: z.string().optional(),
};

export const limitSchema: z.ZodType<LimitSignal> = z.object({
	kind: z.enum([
		"internal_budget",
		"provider_quota",
		"provider_rate_limit",
		"context_length",
		"provider_overloaded",
	]),
	message: z.string(),
	provider: z.string().optional(),
	retryAfterMs: z.number().nonnegative().optional(),
	budget: z
		.object({
			used: z.number(),
			total: z.number(),
			usagePercentage: z.number(),
			warning: z.string().optional(),
			estimatedCost: z.number().optional(),
		})
		.optional(),
});

const workflowConfirmationSchema = z.object({
	workflowId: z.string().min(1),
	workflowName: z.string().min(1),
	description: z
		.string()
		.nullish()
		.transform((value) => value ?? undefined)
		.optional(),
	message: z.string(),
});

export type WorkflowConfirmation = z.infer<typeof workflowConfirmationSchema>;

/** Legacy tool results use the same validated contract as explicit events. */
export function parseWorkflowConfirmation(
	toolName: string | undefined,
	result: unknown,
): WorkflowConfirmation | undefined {
	if (
		toolName !== "execute_workflow" &&
		!toolName?.endsWith("_execute_workflow")
	) {
		return;
	}
	const parsed = workflowConfirmationSchema
		.extend({ requiresConfirmation: z.literal(true) })
		.safeParse(result);
	if (parsed.success) {
		return parsed.data;
	}
}

/** Shared by the route producer and the browser consumer; no server imports. */
const directStreamEventSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("started"), executionId: z.string() }),
	z.object({ type: z.literal("text"), content: z.string() }),
	z.object({ type: z.literal("reasoning"), content: z.string() }),
	z.object({
		type: z.literal("reasoningDuration"),
		durationMs: z.number().nonnegative(),
	}),
	z.object({ type: z.literal("tool_start"), ...toolFields }),
	z.object({ type: z.literal("tool_input"), ...toolFields }),
	z.object({
		type: z.literal("tool_result"),
		...toolFields,
		result: z.unknown().optional(),
		error: z.string().optional(),
	}),
	z.object({
		type: z.literal("progress"),
		phase: z.string().optional(),
		message: z.string().optional(),
		progress: z.number().optional(),
		currentActivity: z.string().optional(),
	}),
	z.object({
		type: z.literal("confirmation_required"),
		workflowId: z.string().min(1).optional(),
		workflowName: z.string().min(1).optional(),
		description: z
			.string()
			.nullish()
			.transform((value) => value ?? undefined)
			.optional(),
		toolName: z.string().min(1).optional(),
		args: z.record(z.string(), z.unknown()).optional(),
		draft: z.unknown().optional(),
		message: z.string(),
	}),
	z.object({
		type: z.literal("sources"),
		sources: z.array(
			z.object({
				id: z.string(),
				title: z.string(),
				type: z.enum(["document", "web", "other"]),
				excerpt: z.string().optional(),
				similarity: z.number().optional(),
				metadata: z.record(z.string(), z.unknown()).optional(),
			}),
		),
	}),
	z.object({
		type: z.literal("error"),
		message: z.string(),
		code: z.string().optional(),
		data: z.unknown().optional(),
		limit: limitSchema.optional(),
		partial: z.boolean().optional(),
	}),
	z.object({
		type: z.literal("done"),
		durationMs: z.number().nonnegative().optional(),
		usage: z
			.object({
				inputTokens: z.number().nonnegative().optional(),
				outputTokens: z.number().nonnegative().optional(),
				totalTokens: z.number().nonnegative().optional(),
				reasoningTokens: z.number().nonnegative().optional(),
				cachedInputTokens: z.number().nonnegative().optional(),
			})
			.optional(),
		model: z
			.object({
				id: z.string(),
				canonicalName: z.string().optional(),
				provider: z.string().optional(),
				contextWindow: z.number().positive().optional(),
			})
			.optional(),
		toolsFailed: z.object({ summary: z.string().optional() }).optional(),
		// Unknown future truncation reasons must not invalidate completion.
		truncated: z.string().optional(),
		apiBilling: z
			.object({ jobType: z.string().optional() })
			.passthrough()
			.optional(),
	}),
	z.object({
		type: z.literal("mcp_default_tool_invoked"),
		payload: z.record(z.string(), z.unknown()),
	}),
	z.object({
		type: z.literal("mcp_default_tool_failed"),
		payload: z.record(z.string(), z.unknown()),
	}),
]);

export type DirectStreamEvent = z.infer<typeof directStreamEventSchema>;

/** Unversioned events remain readable during a rolling web deployment. */
export function parseDirectStreamEvent(
	value: unknown,
): DirectStreamEvent | null {
	return parseVersionedChatEvent(value, directStreamEventSchema);
}

export function encodeDirectStreamEvent(event: DirectStreamEvent): string {
	return encodeChatStreamEvent(event);
}
