/**
 * Reflection Node Factory
 *
 * Creates reusable reflection nodes for LangGraph agents.
 * Enables self-evaluation and correction of agent outputs.
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import {
	getCorrectionPrompt,
	getReflectionSystemPrompt,
	getReflectionUserPrompt,
} from "./prompts";
import type {
	DimensionEvaluation,
	ReflectionConfig,
	ReflectionOutput,
	ReflectionResult,
} from "./types";
import { DEFAULT_REFLECTION_CONFIG } from "./types";

/**
 * Interface for the model used in reflection
 */
interface ReflectionModel {
	invoke(
		messages: Array<{ role: string; content: string }>,
		config?: RunnableConfig,
	): Promise<{ content: string }>;
}

/**
 * Create a reflection node function for use in LangGraph
 *
 * @param modelFactory - Factory function to create the model
 * @param config - Reflection configuration
 * @returns A function that can be used as a LangGraph node
 */
export function createReflectionNode<
	TState extends { outputToEvaluate: string; originalInput: string },
>(
	modelFactory: (config: ReflectionConfig) => ReflectionModel,
	config: Partial<ReflectionConfig> = {},
) {
	const mergedConfig: Required<ReflectionConfig> = {
		...DEFAULT_REFLECTION_CONFIG,
		...config,
	};

	return async function reflectionNode(
		state: TState,
		_runnableConfig?: RunnableConfig,
	): Promise<ReflectionOutput> {
		const model = modelFactory(mergedConfig);
		const systemPrompt = getReflectionSystemPrompt(mergedConfig);
		const userPrompt = getReflectionUserPrompt(
			state.outputToEvaluate,
			state.originalInput,
			(state as Record<string, unknown>).context as string | undefined,
			(state as Record<string, unknown>).expectedFormat as
				| string
				| undefined,
		);

		try {
			// Evaluate the output
			const response = await model.invoke([
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userPrompt },
			]);

			const result = parseReflectionResponse(
				response.content,
				mergedConfig,
			);

			// If passed or max iterations reached, return
			if (result.passed || result.maxIterationsReached) {
				return {
					result,
					shouldRetry: false,
				};
			}

			// Attempt correction
			const correctionPrompt = getCorrectionPrompt(
				state.outputToEvaluate,
				state.originalInput,
				result.issues,
				result.improvements,
			);

			const correctionResponse = await model.invoke([
				{ role: "user", content: correctionPrompt },
			]);

			return {
				result,
				correctedOutput: correctionResponse.content,
				shouldRetry: true,
			};
		} catch (error) {
			console.error("[Reflection] Error during evaluation:", error);
			return {
				result: createErrorResult(error),
				shouldRetry: false,
			};
		}
	};
}

/**
 * Parse the reflection response from the model
 */
function parseReflectionResponse(
	content: string,
	config: Required<ReflectionConfig>,
): ReflectionResult {
	try {
		// Extract JSON from response
		const jsonMatch = content.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			throw new Error("No JSON found in response");
		}

		const parsed = JSON.parse(jsonMatch[0]);

		const evaluations: DimensionEvaluation[] = parsed.evaluations || [];
		const overallScore =
			parsed.overallScore || calculateOverallScore(evaluations);
		const passed = overallScore >= config.passThreshold;

		return {
			passed,
			overallScore,
			evaluations,
			issues: parsed.issues || [],
			improvements: parsed.improvements || [],
			iterationCount: 1,
			maxIterationsReached: false,
		};
	} catch (error) {
		console.error("[Reflection] Failed to parse response:", error);
		return createErrorResult(error);
	}
}

/**
 * Calculate overall score from dimension evaluations
 */
function calculateOverallScore(evaluations: DimensionEvaluation[]): number {
	if (evaluations.length === 0) {
		return 0;
	}
	const sum = evaluations.reduce((acc, e) => acc + e.score, 0);
	return Math.round(sum / evaluations.length);
}

/**
 * Create an error result
 */
function createErrorResult(error: unknown): ReflectionResult {
	return {
		passed: false,
		overallScore: 0,
		evaluations: [],
		issues: [
			`Reflection error: ${error instanceof Error ? error.message : String(error)}`,
		],
		improvements: [],
		iterationCount: 0,
		maxIterationsReached: false,
	};
}

// Export for testing
export { parseReflectionResponse, calculateOverallScore };
