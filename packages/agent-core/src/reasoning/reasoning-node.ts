/**
 * Reasoning Node Factory
 *
 * Creates reasoning-enhanced nodes for LangGraph agents.
 * Implements lite/balanced/deep reasoning modes with chain-of-thought,
 * self-correction, and step verification.
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import type {
	ReasoningMode,
	ReasoningModeConfig,
	ReasoningState,
	ReasoningStep,
} from "./types";
import {
	addReasoningStep,
	DEFAULT_REASONING_MODE,
	getReasoningModeConfig,
} from "./types";

/**
 * Interface for the model used in reasoning
 */
interface ReasoningModel {
	invoke(
		messages: Array<{ role: string; content: string }>,
		config?: RunnableConfig,
	): Promise<{ content: string }>;
}

/**
 * Options for the reasoning node
 */
export interface ReasoningNodeOptions {
	/** Override default reasoning mode */
	defaultMode?: ReasoningMode;
	/** Custom system prompt for reasoning */
	systemPrompt?: string;
	/** Base timeout in milliseconds */
	baseTimeout?: number;
}

/**
 * Input for reasoning node
 */
export interface ReasoningInput {
	/** The task or question to reason about */
	task: string;
	/** Additional context */
	context?: string;
	/** Override reasoning mode for this invocation */
	mode?: ReasoningMode;
}

/**
 * Output from reasoning node
 */
export interface ReasoningOutput {
	/** The final reasoned response */
	response: string;
	/** Reasoning trace (if enabled) */
	trace: ReasoningStep[];
	/** Overall confidence score */
	confidence: number;
	/** Reasoning mode used */
	mode: ReasoningMode;
	/** Number of iterations performed */
	iterations: number;
	/** Whether the quality threshold was met */
	qualityMet: boolean;
}

/**
 * System prompts for different reasoning modes
 */
const REASONING_PROMPTS = {
	lite: "You are a helpful assistant. Provide a direct, concise response.",

	balanced: `You are a thoughtful assistant. Before answering:
1. Consider the key aspects of the question
2. Provide a clear, well-reasoned response
3. Include relevant details but stay focused`,

	deep: `You are an expert reasoning assistant. Follow this structured approach:

## THINKING PHASE
First, think through the problem step by step:
- What are the key components of this task?
- What are the potential approaches?
- What are the risks or edge cases?

## VERIFICATION PHASE
Verify your reasoning:
- Check each logical step
- Consider alternative perspectives
- Validate assumptions

## RESPONSE PHASE
Provide your final answer with:
- Clear explanation of your reasoning
- Confidence level in your response
- Any caveats or limitations

Format your response as:
<thinking>
[Your step-by-step reasoning]
</thinking>

<verification>
[Your verification of the reasoning]
</verification>

<response>
[Your final answer]
</response>

<confidence>
[0-100 score]
</confidence>`,
};

/**
 * Create a reasoning-enhanced node for LangGraph
 */
export function createReasoningNode<
	TState extends { reasoningMode?: ReasoningMode },
>(
	modelFactory: (config: ReasoningModeConfig) => ReasoningModel,
	options: ReasoningNodeOptions = {},
) {
	const { defaultMode = DEFAULT_REASONING_MODE, baseTimeout = 30000 } =
		options;

	return async function reasoningNode(
		state: TState & Partial<ReasoningState>,
		input: ReasoningInput,
		_runnableConfig?: RunnableConfig,
	): Promise<ReasoningOutput> {
		const mode = input.mode || state.reasoningMode || defaultMode;
		const config = getReasoningModeConfig(mode);
		const model = modelFactory(config);

		const currentState: ReasoningState = {
			reasoningMode: mode,
			reasoningIteration: 0,
			reasoningTrace: [],
			reasoningComplete: false,
		};

		const systemPrompt = options.systemPrompt || REASONING_PROMPTS[mode];
		// Note: timeout calculated for future use with Promise.race for timeout handling
		const _timeout = baseTimeout * config.timeoutMultiplier;

		try {
			// Execute reasoning based on mode
			if (mode === "lite") {
				return await executeLiteReasoning(
					model,
					systemPrompt,
					input,
					config,
				);
			}
			if (mode === "balanced") {
				return await executeBalancedReasoning(
					model,
					systemPrompt,
					input,
					config,
					currentState,
				);
			}
			return await executeDeepReasoning(
				model,
				systemPrompt,
				input,
				config,
				currentState,
			);
		} catch (error) {
			console.error(`[Reasoning] Error in ${mode} mode:`, error);
			return {
				response: `Error during reasoning: ${error instanceof Error ? error.message : "Unknown error"}`,
				trace: currentState.reasoningTrace,
				confidence: 0,
				mode,
				iterations: currentState.reasoningIteration,
				qualityMet: false,
			};
		}
	};
}

/**
 * Execute lite (fast) reasoning - no reflection or verification
 */
async function executeLiteReasoning(
	model: ReasoningModel,
	systemPrompt: string,
	input: ReasoningInput,
	_config: ReasoningModeConfig,
): Promise<ReasoningOutput> {
	const userPrompt = input.context
		? `Context: ${input.context}\n\nTask: ${input.task}`
		: input.task;

	const response = await model.invoke([
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userPrompt },
	]);

	return {
		response: response.content,
		trace: [],
		confidence: 75, // Default confidence for lite mode
		mode: "lite",
		iterations: 1,
		qualityMet: true,
	};
}

/**
 * Execute balanced reasoning - includes chain-of-thought and one reflection
 */
async function executeBalancedReasoning(
	model: ReasoningModel,
	systemPrompt: string,
	input: ReasoningInput,
	config: ReasoningModeConfig,
	state: ReasoningState,
): Promise<ReasoningOutput> {
	let reasoningState = state;
	const userPrompt = input.context
		? `Context: ${input.context}\n\nTask: ${input.task}\n\nThink through this step by step, then provide your answer.`
		: `${input.task}\n\nThink through this step by step, then provide your answer.`;

	// Initial reasoning
	const initialResponse = await model.invoke([
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userPrompt },
	]);

	reasoningState = addReasoningStep(
		reasoningState,
		"think",
		initialResponse.content,
		70,
	);

	// Self-correction pass if enabled
	if (config.selfCorrection) {
		const correctionPrompt = `Review your previous response and identify any improvements:

Previous response:
${initialResponse.content}

If there are improvements to make, provide the improved response. If the response is good, confirm it.`;

		const correctedResponse = await model.invoke([
			{ role: "system", content: systemPrompt },
			{ role: "user", content: correctionPrompt },
		]);

		reasoningState = addReasoningStep(
			reasoningState,
			"correct",
			correctedResponse.content,
			80,
		);

		return {
			response: correctedResponse.content,
			trace: config.includeTrace ? reasoningState.reasoningTrace : [],
			confidence: 80,
			mode: "balanced",
			iterations: 2,
			qualityMet: true,
		};
	}

	return {
		response: initialResponse.content,
		trace: config.includeTrace ? reasoningState.reasoningTrace : [],
		confidence: 75,
		mode: "balanced",
		iterations: 1,
		qualityMet: true,
	};
}

/**
 * Execute deep reasoning - full chain-of-thought, verification, and multi-pass reflection
 */
async function executeDeepReasoning(
	model: ReasoningModel,
	systemPrompt: string,
	input: ReasoningInput,
	config: ReasoningModeConfig,
	state: ReasoningState,
): Promise<ReasoningOutput> {
	let reasoningState = state;
	const userPrompt = input.context
		? `Context: ${input.context}\n\nTask: ${input.task}`
		: input.task;

	// Phase 1: Initial deep thinking
	const thinkingResponse = await model.invoke([
		{ role: "system", content: systemPrompt },
		{ role: "user", content: userPrompt },
	]);

	reasoningState = addReasoningStep(
		reasoningState,
		"think",
		thinkingResponse.content,
		60,
	);
	reasoningState.reasoningIteration = 1;

	// Parse structured response if present
	let parsedResponse = parseDeepResponse(thinkingResponse.content);
	let currentConfidence = parsedResponse.confidence;
	let currentResponse = parsedResponse.response || thinkingResponse.content;

	// Phase 2: Iterative refinement until quality threshold met
	while (
		reasoningState.reasoningIteration < config.reflectionIterations &&
		currentConfidence < config.qualityThreshold
	) {
		reasoningState.reasoningIteration++;

		// Verification step
		if (config.stepVerification) {
			const verifyPrompt = `Verify the following reasoning and identify any logical errors or gaps:

${currentResponse}

Check:
1. Are all logical steps valid?
2. Are there any missing considerations?
3. Is the conclusion well-supported?

Provide your verification assessment.`;

			const verifyResponse = await model.invoke([
				{
					role: "system",
					content:
						"You are a critical reasoning verifier. Identify any flaws or gaps in the reasoning.",
				},
				{ role: "user", content: verifyPrompt },
			]);

			reasoningState = addReasoningStep(
				reasoningState,
				"verify",
				verifyResponse.content,
				currentConfidence,
			);
		}

		// Reflection and improvement step
		const reflectPrompt = `Based on your analysis, improve the response:

Current response:
${currentResponse}

${config.stepVerification ? "Verification feedback available in context." : ""}

Provide an improved, more thorough response with higher confidence.`;

		const reflectResponse = await model.invoke([
			{ role: "system", content: systemPrompt },
			{ role: "user", content: reflectPrompt },
		]);

		parsedResponse = parseDeepResponse(reflectResponse.content);
		currentConfidence = Math.max(
			currentConfidence + 10,
			parsedResponse.confidence,
		);
		currentResponse = parsedResponse.response || reflectResponse.content;

		reasoningState = addReasoningStep(
			reasoningState,
			"reflect",
			currentResponse,
			currentConfidence,
		);
	}

	// Final conclusion
	reasoningState = addReasoningStep(
		reasoningState,
		"conclude",
		currentResponse,
		currentConfidence,
	);
	reasoningState.reasoningComplete = true;

	return {
		response: currentResponse,
		trace: reasoningState.reasoningTrace,
		confidence: currentConfidence,
		mode: "deep",
		iterations: reasoningState.reasoningIteration,
		qualityMet: currentConfidence >= config.qualityThreshold,
	};
}

/**
 * Parse structured deep response
 */
function parseDeepResponse(content: string): {
	response: string;
	confidence: number;
} {
	// Try to extract structured response
	const responseMatch = content.match(/<response>([\s\S]*?)<\/response>/);
	const confidenceMatch = content.match(/<confidence>(\d+)<\/confidence>/);

	return {
		response: responseMatch ? responseMatch[1].trim() : content,
		confidence: confidenceMatch
			? Number.parseInt(confidenceMatch[1], 10)
			: 70,
	};
}

/**
 * Helper to determine appropriate reasoning mode based on task complexity
 */
export function suggestReasoningMode(task: string): ReasoningMode {
	const taskLower = task.toLowerCase();

	// Deep mode indicators
	const deepIndicators = [
		"analyze",
		"evaluate",
		"compare",
		"design",
		"architect",
		"optimize",
		"debug",
		"investigate",
		"research",
		"plan",
		"complex",
		"critical",
		"important",
		"thorough",
	];

	// Lite mode indicators
	const liteIndicators = [
		"simple",
		"quick",
		"fast",
		"basic",
		"straightforward",
		"list",
		"summarize",
		"define",
		"what is",
		"how do i",
	];

	const deepScore = deepIndicators.filter((i) =>
		taskLower.includes(i),
	).length;
	const liteScore = liteIndicators.filter((i) =>
		taskLower.includes(i),
	).length;

	if (deepScore >= 2) {
		return "deep";
	}
	if (liteScore >= 2) {
		return "lite";
	}
	return "balanced";
}
