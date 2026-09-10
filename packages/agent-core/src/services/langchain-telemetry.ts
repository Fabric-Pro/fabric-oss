import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import {
	type LLMInvocation,
	llmInstrumentation,
} from "@repo/observability/llm";
import { extractUsageFromLangChainResponse } from "./usage-logging";

interface LangChainTelemetryContext {
	provider: string;
	model: string;
}

function isCancellation(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "AbortError" || error.name === "ModelAbortError")
	);
}

function outputUsage(output: LLMResult) {
	for (const generations of output.generations) {
		for (const generation of generations) {
			const message = (generation as { message?: unknown }).message;
			if (message && typeof message === "object") {
				const candidate = message as Record<string, unknown>;
				if (
					candidate.usage_metadata !== undefined ||
					candidate.response_metadata !== undefined
				) {
					const usage = extractUsageFromLangChainResponse(message);
					if (usage) {
						return usage;
					}
				}
			}
		}
	}

	return extractUsageFromLangChainResponse(
		output.llmOutput ? { response_metadata: output.llmOutput } : undefined,
	);
}

class FabricLLMTelemetryCallback extends BaseCallbackHandler {
	name = "fabric_llm_telemetry";
	private readonly runs = new Map<string, LLMInvocation>();

	constructor(private readonly context: LangChainTelemetryContext) {
		super({ raiseError: false });
	}

	private start(runId: string): void {
		try {
			if (!this.runs.has(runId)) {
				this.runs.set(
					runId,
					llmInstrumentation.startInvocation(this.context),
				);
			}
		} catch {
			// Telemetry callbacks must never change model behavior.
		}
	}

	handleLLMStart(_llm: unknown, _prompts: string[], runId: string): void {
		this.start(runId);
	}

	handleChatModelStart(
		_llm: unknown,
		_messages: unknown[][],
		runId: string,
	): void {
		this.start(runId);
	}

	handleLLMEnd(output: LLMResult, runId: string): void {
		const invocation = this.runs.get(runId);
		if (!invocation) {
			return;
		}
		this.runs.delete(runId);
		try {
			const usage = outputUsage(output);
			invocation.succeed(
				usage
					? {
							inputTokens: usage.inputTokens,
							outputTokens: usage.outputTokens,
						}
					: undefined,
			);
		} catch {
			invocation.succeed();
		}
	}

	handleLLMError(error: unknown, runId: string): void {
		const invocation = this.runs.get(runId);
		if (!invocation) {
			return;
		}
		this.runs.delete(runId);
		try {
			if (isCancellation(error)) {
				invocation.cancel();
			} else {
				invocation.fail(error);
			}
		} catch {
			// Telemetry callbacks must never change model behavior.
		}
	}
}

export function createLangChainTelemetryCallback(
	context: LangChainTelemetryContext,
): BaseCallbackHandler {
	return new FabricLLMTelemetryCallback(context);
}
