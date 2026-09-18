/**
 * Research Module
 *
 * Provides intelligent research capabilities for the orchestrator.
 * Uses AI SDK V7's tool-calling with dynamic research tools.
 */

export { executeResearchAgent } from "./research-agent";
export {
	buildResearchTools,
	getResearchToolName,
	isResearchTool,
} from "./research-tools";
