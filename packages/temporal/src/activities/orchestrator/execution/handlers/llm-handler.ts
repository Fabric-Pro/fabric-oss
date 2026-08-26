/**
 * LLM Handler
 *
 * Handles steps that only require LLM generation without tools.
 * Used for presentation, summarization, and formatting steps.
 */

import { generateText } from "@repo/ai";
import type { ExecuteStepInput } from "../../types";
import { getAiModel } from "../../utils";
import type { HandlerContext, HandlerResult, StepHandler } from "./types";

export class LlmHandler implements StepHandler {
	readonly name = "llm";
	readonly capabilities = ["llm"];

	canHandle(input: ExecuteStepInput): boolean {
		const capability = input.step.capability || "mcp_tool";
		const executor = input.step.executor;
		// Handle LLM capability without specific executor
		return capability === "llm" && !executor;
	}

	async execute(context: HandlerContext): Promise<HandlerResult> {
		const { input } = context;
		console.log(`[LlmHandler] Executing LLM-only step: ${input.step.id}`);

		try {
			const output = await this.executeLlmOnlyStep(input);
			return {
				handled: true,
				output,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error("[LlmHandler] LLM step failed:", error);
			return {
				handled: false,
				error: errorMessage,
				shouldFallback: true,
				fallbackReason: "LLM generation failed",
			};
		}
	}

	private async executeLlmOnlyStep(input: ExecuteStepInput) {
		console.log("[LlmHandler] LLM-only step - skipping MCP tool loading");
		const startTime = Date.now();

		// Build context from previous steps
		const previousStepsContext =
			input.previousStepResults.length > 0
				? input.previousStepResults
						.map(
							(s, idx) =>
								`### Step ${idx + 1}: ${s.stepDescription}\n${s.response || "(no response)"}`,
						)
						.join("\n\n")
				: "";

		// Get step-specific instructions
		const stepInputs = input.step.inputs as
			| Record<string, unknown>
			| undefined;
		const instructions = (stepInputs?.instructions as string) || "";
		const presentationFormat =
			(stepInputs?.presentationFormat as string) || "formatted response";
		const presentationHint = (stepInputs?.presentationHint as string) || "";

		// Build a focused prompt for the presentation step
		const systemPrompt = `You are a helpful assistant that presents information clearly and professionally.
Your task is to take the results from previous steps and present them in a ${presentationFormat}.

${presentationHint}

Guidelines:
- Use markdown formatting for readability
- Use tables for structured/list data
- Use bullet points for key information
- Use code blocks for technical content
- Be concise but comprehensive
- Directly address what the user asked for`;

		const userPrompt = `${input.step.description}

${instructions}

## Results from Previous Steps:
${previousStepsContext}

## Original User Request:
${input.message}

Please present the results in a clear, well-formatted manner.`;

		const model = await getAiModel(
			input.userId,
			input.organizationId,
			false,
		);

		const response = await generateText({
			model,
			system: systemPrompt,
			prompt: userPrompt,
		});

		const responseText = response.text || "Task completed.";
		const durationMs = Date.now() - startTime;

		console.log(`[LlmHandler] LLM-only step completed in ${durationMs}ms`);

		return {
			outputs: {
				response: responseText,
				toolResults: [],
				presentationFormat,
			},
			variables: {},
			toolCalls: [],
			response: responseText,
		};
	}
}
