import type { TaskPlan } from "@repo/temporal";
import { z } from "zod";
import {
	encodeChatStreamEvent,
	parseVersionedChatEvent,
} from "./chat-stream-protocol";
import { limitSchema, toolFields } from "./direct-stream-protocol";

const risk = z.enum(["low", "medium", "high", "critical"]);
const taskType = z.enum([
	"api",
	"browser",
	"hybrid",
	"agent",
	"workflow",
	"research",
	"generate",
	"verify",
]);
const planStep = z
	.object({
		id: z.string(),
		description: z.string(),
		order: z.number(),
		type: taskType.optional(),
		status: z
			.enum([
				"pending",
				"in_progress",
				"complete",
				"error",
				"skipped",
				"awaiting_approval",
			])
			.optional(),
		riskLevel: risk.optional(),
		requiresApproval: z.boolean().optional(),
	})
	.passthrough();
const plan = z
	.object({
		id: z.string(),
		description: z.string(),
		riskLevel: risk,
		strategy: taskType.optional(),
		createdAt: z.string().optional(),
		steps: z.array(planStep),
	})
	.passthrough();
const finalTool = z.object({
	id: z.string().optional(),
	name: z.string(),
	args: z.unknown().optional(),
	result: z.unknown().optional(),
	status: z.enum(["success", "error", "complete"]).optional(),
	durationMs: z.number().optional(),
	serverName: z.string().optional(),
	mcpAppResourceUri: z.string().optional(),
	mcpAppConfigId: z.string().optional(),
});
const stepResult = z.object({
	stepId: z.string(),
	stepDescription: z.string(),
	error: z.string().optional(),
	artifacts: z.array(z.unknown()).optional(),
	status: z.enum(["complete", "error", "skipped"]).optional(),
	response: z.string().optional(),
	toolCalls: z.array(finalTool).optional(),
	durationMs: z.number().optional(),
});
const requiredConnection = z.object({
	serverId: z.string(),
	serverName: z.string(),
	reason: z.string(),
	authType: z.enum(["OAUTH2", "API_KEY", "NONE"]),
	oauthConnectUrl: z.string().optional(),
	isSystemProvided: z.boolean(),
	iconUrl: z.string().optional(),
	category: z.string().optional(),
	matchedTools: z.array(z.string()).optional(),
	confidence: z.number(),
});
const missingIntegration = z.object({
	provider: z.string(),
	name: z.string(),
	reason: z.string(),
	authType: z.enum(["OAUTH", "API_KEY"]),
	capabilities: z.array(z.string()),
	confidence: z.number(),
});

const approvalHistory = z.array(
	z.object({
		approvalId: z.string(),
		stepId: z.string(),
		stepDescription: z.string(),
		riskLevel: z.string(),
		requestedAt: z.string(),
		decidedAt: z.string().optional(),
		approved: z.boolean(),
		feedback: z.string().optional(),
	}),
);

/** Browser-safe projection of the orchestration event contract. */
export const orchestratorStreamEventSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("started"),
		executionId: z.string(),
		workflowId: z.string().optional(),
		resumed: z.boolean().optional(),
		turnId: z.string().nullable().optional(),
		turnGeneration: z.number().nullable().optional(),
	}),
	z.object({
		type: z.literal("start_pending"),
		retryable: z.boolean().optional(),
		executionId: z.string().optional(),
	}),
	z.object({
		type: z.literal("phase"),
		phase: z.string(),
		message: z.string().optional(),
	}),
	z.object({
		type: z.literal("routing"),
		primaryAgent: z.string(),
		agentName: z.string(),
		confidence: z.number(),
		riskLevel: risk.optional(),
		requiredConnections: z.array(requiredConnection).optional(),
		missingIntegrations: z.array(missingIntegration).optional(),
		blockedOnConnections: z.boolean().optional(),
	}),
	z.object({ type: z.literal("planning"), plan }),
	z.object({
		type: z.literal("step_start"),
		stepId: z.string(),
		description: z.string(),
		order: z.number(),
	}),
	z.object({ type: z.literal("step_complete"), ...stepResult.shape }),
	z.object({
		type: z.literal("text_start"),
		iteration: z.number().optional(),
	}),
	z.object({ type: z.literal("text_delta"), content: z.string() }),
	z.object({ type: z.literal("tool_start"), ...toolFields }),
	z.object({ type: z.literal("tool_input"), ...toolFields }),
	z.object({
		type: z.literal("tool_result"),
		...toolFields,
		result: z.unknown().optional(),
		error: z.string().optional(),
		durationMs: z.number().optional(),
	}),
	z.object({ type: z.literal("limit_signal"), signal: limitSchema }),
	z.object({
		type: z.literal("context_compacted"),
		iteration: z.number(),
		compactedTurns: z.number(),
		summaryChars: z.number(),
		historyLengthBefore: z.number(),
	}),
	z.object({
		type: z.literal("progress"),
		completedSteps: z.number().optional(),
		totalSteps: z.number().optional(),
		message: z.string().optional(),
		phase: z.string().optional(),
	}),
	z.object({
		type: z.literal("approval_required"),
		approvalId: z.string().optional(),
		stepId: z.string(),
		reason: z.string(),
	}),
	z.object({
		type: z.literal("approval_resolved"),
		approvalId: z.string().optional(),
		stepId: z.string().optional(),
		message: z.string().optional(),
	}),
	z.object({
		type: z.literal("clarifying_question"),
		clarificationId: z.string(),
		stepId: z.string().optional(),
		question: z.string(),
		options: z.array(z.string()).optional(),
	}),
	z.object({
		type: z.literal("clarifying_resolved"),
		clarificationId: z.string(),
	}),
	z.object({
		type: z.literal("stream_timeout"),
		executionId: z.string().optional(),
		message: z.string().optional(),
	}),
	z.object({
		type: z.literal("completed"),
		approvalHistory: approvalHistory.optional(),
		status: z.string().optional(),
		response: z.string().optional(),
		plan: plan.optional(),
		variables: z.record(z.string(), z.unknown()).optional(),
		planningAudit: z
			.object({
				headline: z.string(),
				keyFactors: z.array(z.string()),
				sourcesUsed: z.array(z.string()),
				usedMemory: z.boolean(),
				usedResearch: z.boolean(),
				totalSourcesConsulted: z.number(),
				totalDecisions: z.number(),
				planningDurationMs: z.number().optional(),
			})
			.optional(),
		artifacts: z
			.array(
				z.object({
					id: z.string(),
					type: z.enum([
						"document",
						"code",
						"data",
						"tool_result",
						"file",
						"error",
						"chart",
					]),
					name: z.string().optional(),
					content: z.string().optional(),
					stepId: z.string(),
					createdAt: z.string(),
					metadata: z.record(z.string(), z.unknown()).optional(),
				}),
			)
			.optional(),
		limitSignals: z.array(limitSchema).optional(),
		tokenBudget: z
			.object({
				used: z.number(),
				total: z.number(),
				usagePercentage: z.number(),
				warning: z.string().optional(),
				estimatedCost: z.number().optional(),
			})
			.optional(),
		handoffRecommended: z
			.object({ reason: z.string(), summary: z.string() })
			.optional(),
		truncated: z.string().optional(),
		budgetStop: z.unknown().optional(),
		model: z
			.object({
				id: z.string(),
				canonicalName: z.string().optional(),
				provider: z.string().optional(),
				viaPlan: z.boolean().optional(),
				contextWindow: z.number().optional(),
			})
			.optional(),
		apiBilling: z
			.object({ jobType: z.string().optional() })
			.passthrough()
			.optional(),
		turnId: z.string().nullable().optional(),
		turnGeneration: z.number().nullable().optional(),
		fromTurnRecord: z.boolean().optional(),
		stepResults: z.array(stepResult).optional(),
		toolCalls: z.array(finalTool).optional(),
		totalDurationMs: z.number().optional(),
	}),
	z.object({
		type: z.literal("error"),
		approvalHistory: approvalHistory.optional(),
		message: z.string().optional(),
		error: z.string().optional(),
		code: z.string().optional(),
		data: z.unknown().optional(),
		budgetStop: z.unknown().optional(),
		limit: limitSchema.optional(),
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
export type OrchestratorStreamEvent = z.infer<
	typeof orchestratorStreamEventSchema
>;
export function parseOrchestratorStreamEvent(
	value: unknown,
): OrchestratorStreamEvent | null {
	return parseVersionedChatEvent(value, orchestratorStreamEventSchema);
}
export function encodeOrchestratorStreamEvent(
	event: z.input<typeof orchestratorStreamEventSchema>,
): string {
	return encodeChatStreamEvent(event);
}

export function toTaskPlan(value: z.infer<typeof plan>): TaskPlan {
	return {
		...value,
		strategy: value.strategy ?? "agent",
		createdAt: value.createdAt || new Date().toISOString(),
		steps: value.steps.map((step) => ({
			...step,
			type: step.type ?? "agent",
			status: step.status ?? "pending",
		})),
	};
}

// Research retains its legacy text/done aliases while using Orchestrator runs.
const researchStreamEventSchema = z.discriminatedUnion("type", [
	...orchestratorStreamEventSchema.options,
	z.object({ type: z.literal("text"), content: z.string() }),
	z.object({ type: z.literal("done") }),
]);
export function parseResearchStreamEvent(value: unknown) {
	return parseVersionedChatEvent(value, researchStreamEventSchema);
}

export type OrchestratorStreamInput = z.input<
	typeof orchestratorStreamEventSchema
>;
