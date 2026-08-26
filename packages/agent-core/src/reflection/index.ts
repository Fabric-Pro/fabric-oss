/**
 * Reflection Module
 *
 * Provides reusable reflection capabilities for LangGraph agents.
 * Enables self-evaluation and correction of agent outputs.
 *
 * @example
 * ```typescript
 * import { createReflectionNode, ReflectionConfig } from "@repo/agent-core/reflection";
 * import { ChatOpenAI } from "@langchain/openai";
 *
 * const reflectionConfig: ReflectionConfig = {
 *   passThreshold: 80,
 *   maxIterations: 3,
 *   dimensions: ["accuracy", "completeness", "relevance"],
 * };
 *
 * const reflectionNode = createReflectionNode(
 *   (config) => new ChatOpenAI({ model: config.model, temperature: config.temperature }),
 *   reflectionConfig,
 * );
 *
 * // Use in LangGraph
 * workflow.addNode("reflect", reflectionNode);
 * ```
 */

// Prompts (for customization)
export {
	getCorrectionPrompt,
	getReflectionSystemPrompt,
	getReflectionUserPrompt,
} from "./prompts";
// Core functionality
export {
	calculateOverallScore,
	createReflectionNode,
	parseReflectionResponse,
} from "./reflection-node";
// Types
export type {
	DimensionEvaluation,
	QualityDimension,
	ReflectionConfig,
	ReflectionInput,
	ReflectionOutput,
	ReflectionResult,
	ReflectionState,
} from "./types";
export { DEFAULT_REFLECTION_CONFIG } from "./types";
