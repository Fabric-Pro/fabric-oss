/** One configured API request, no ambient plan, retries, tool execution or fallback. */

import type { SignalTriagerHost } from "@repo/agent-runtime/harness/triage";
import { generateText } from "@repo/ai";
import { getAIModelWithMetadata } from "@repo/ai/model-selector";
import type { TriageScope } from "@repo/database";
import { db } from "@repo/database";
import { jsonSchema, type ModelMessage, type ToolSet, tool } from "ai";

import {
	type TriageModelPin,
	triageModelPin,
} from "./harness-triage-contracts";

export {
	type TriageModelPin,
	triageModelPin,
} from "./harness-triage-contracts";
export async function resolveTriageModel(
	scope: TriageScope,
	pinned?: TriageModelPin,
) {
	const resolved = await getAIModelWithMetadata(
		{
			taskType: "TOOL_CALLING",
			requiresToolCalling: true,
			// Resolve the current configured task route without automatic answer
			// recovery, then require every approved pin to still match. No
			// provider refusal may switch routes or resend inside this call.
		},
		{
			userId: scope.userId,
			organizationId: scope.organizationId,
			projectId: scope.projectId,
			planEligible: false,
			excludeChatGptPlan: true,
		},
	);
	const m = resolved.metadata;
	const snapshot = m.answerSnapshot;
	// First qualified bridge is a saved direct OpenAI API configuration. Other
	// providers require their own physical-send/retry qualification before enabling.
	if (
		typeof resolved.model === "string" ||
		!/^openai(?:\.|$)/.test(resolved.model.provider) ||
		m.provider !== "OPENAI_DIRECT" ||
		!snapshot ||
		!m.configId ||
		!m.configSource ||
		m.planSource ||
		!m.contextWindow ||
		!m.maxOutputTokens
	) {
		throw Error("TRIAGE_MODEL_UNAVAILABLE");
	}
	const mapping = await db.aiModelProviderMapping.findFirst({
		where: {
			provider: m.provider,
			providerModelId: m.modelString.replace(/^openai\//, ""),
			isAvailable: true,
		},
		select: {
			inputCostPer1M: true,
			outputCostPer1M: true,
			model: { select: { inputCostPer1M: true, outputCostPer1M: true } },
		},
	});
	if (!mapping) {
		throw Error("TRIAGE_PRICING_UNAVAILABLE");
	}
	const pin = triageModelPin.parse({
		provider: m.provider,
		modelString: m.modelString,
		canonicalName: m.canonicalName,
		configId: m.configId,
		configSource: m.configSource,
		routeHash: snapshot.routeHash,
		maxOutputTokens: Math.min(2048, m.maxOutputTokens),
		contextWindow: m.contextWindow,
		inputRate: mapping.inputCostPer1M ?? mapping.model.inputCostPer1M,
		outputRate: mapping.outputCostPer1M ?? mapping.model.outputCostPer1M,
	});
	if (pinned && JSON.stringify(pin) !== JSON.stringify(pinned)) {
		throw Error("TRIAGE_MODEL_CHANGED");
	}
	return { pin, model: resolved.model };
}
export function triageCharge(
	pin: TriageModelPin,
	input: number,
	output: number,
) {
	if (![input, output].every((x) => Number.isSafeInteger(x) && x >= 0)) {
		throw Error("TRIAGE_USAGE_UNAVAILABLE");
	}
	// Rates are USD/million, numerically identical to micro-USD/token.
	return Math.ceil(input * pin.inputRate + output * pin.outputRate);
}
export async function generateTriageModelOnce(
	scope: TriageScope,
	pin: TriageModelPin,
	input: Parameters<SignalTriagerHost["generateOne"]>[0],
): Promise<Awaited<ReturnType<SignalTriagerHost["generateOne"]>>> {
	input.signal.throwIfAborted();
	const { model } = await resolveTriageModel(scope, pin);
	input.signal.throwIfAborted();
	const messages: ModelMessage[] = input.request.messages.map((m) => {
		if (m.attachments?.length) {
			throw Error("TRIAGE_ATTACHMENT_UNAVAILABLE");
		}
		if (m.role === "assistant") {
			return {
				role: "assistant",
				content: [
					...(m.content
						? [{ type: "text" as const, text: m.content }]
						: []),
					...(m.toolCalls ?? []).map((t) => ({
						type: "tool-call" as const,
						toolCallId: t.id,
						toolName: t.name,
						input: t.input,
					})),
				],
			};
		}
		if (m.role === "tool") {
			return {
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: m.toolCallId ?? "",
						toolName: m.name ?? "",
						output: { type: "text", value: m.content },
					},
				],
			};
		}
		return { role: m.role, content: m.content };
	});
	const tools: ToolSet = Object.fromEntries(
		(input.request.tools ?? []).map((t) => [
			t.name,
			tool({
				description: t.description,
				inputSchema: jsonSchema(
					t.inputSchema as Parameters<typeof jsonSchema>[0],
				),
			}),
		]),
	);
	const response = await generateText({
		model,
		messages,
		// These system messages come from the fixed Harness definition; source
		// evidence is always a tool result, never promoted to instructions.
		allowSystemInMessages: true,
		tools,
		maxOutputTokens: input.maxOutputTokens,
		maxRetries: 0,
		abortSignal: input.signal,
		experimental_telemetry: { isEnabled: false },
	});
	if (
		response.finishReason === "length" ||
		response.finishReason === "error"
	) {
		throw Error("TRIAGE_MODEL_INCOMPLETE");
	}
	const usage = response.usage;
	if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
		throw Error("TRIAGE_USAGE_UNAVAILABLE");
	}
	const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
	if (cacheWrite !== 0) {
		throw Error("TRIAGE_CACHE_USAGE_UNQUALIFIED");
	}
	return {
		message: { role: "assistant", content: response.text },
		toolCalls: response.toolCalls.map((t) => ({
			id: t.toolCallId,
			name: t.toolName,
			input: t.input,
		})),
		usage: {
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
			costUsd:
				triageCharge(pin, usage.inputTokens, usage.outputTokens) / 1e6,
		},
	};
}
