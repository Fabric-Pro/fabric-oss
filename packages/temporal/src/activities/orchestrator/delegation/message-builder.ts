/**
 * Delegation Message Builder
 *
 * Provides functions for building context-aware delegation messages
 * based on agent capabilities, task requirements, and accumulated context.
 */

import type {
	AgentCardCapabilities,
	ContextBag,
	ResearchFinding,
	SynthesizedContext,
	TaskStep,
} from "../types";

/**
 * Builds a context-aware task description based on agent capabilities.
 *
 * For GENERALIST agents (autonomousExecution + taskDecomposition):
 * - Provides high-level goals without step-by-step instructions
 * - Includes context summary from conversation history
 * - Lets the agent handle its own planning and decomposition
 *
 * For SPECIALIST agents:
 * - Provides specific, actionable instructions
 * - Includes detailed context from previous steps
 * - Expects single-step execution
 */
export function buildDelegationMessage(
	originalMessage: string,
	capabilities: AgentCardCapabilities | undefined,
	context: {
		conversationHistory?: Array<{ role: string; content: string }>;
		previousStepResults?: Array<{
			stepId: string;
			stepDescription: string;
			response?: string;
		}>;
		variables?: Record<string, unknown>;
		delegationMode?: "complete-task" | "single-step";
	},
): string {
	const isGeneralist =
		capabilities?.autonomousExecution && capabilities?.taskDecomposition;
	const delegationMode =
		context.delegationMode ||
		(isGeneralist ? "complete-task" : "single-step");

	// For generalist agents with complete-task delegation
	if (isGeneralist && delegationMode === "complete-task") {
		let message = originalMessage;

		// Add conversation context summary for follow-up questions
		if (
			context.conversationHistory &&
			context.conversationHistory.length > 0
		) {
			const contextSummary = summarizeConversationHistory(
				context.conversationHistory,
			);
			if (contextSummary) {
				message = `Context from previous conversation:\n${contextSummary}\n\nCurrent request:\n${originalMessage}`;
			}
		}

		// For generalist agents, we DON'T add step-by-step instructions
		// The agent will handle decomposition internally
		console.log(
			"[Orchestrator] Built generalist delegation message (high-level goal)",
		);
		return message;
	}

	// For specialist agents with single-step delegation
	let message = originalMessage;

	// Add detailed context from previous steps
	if (context.previousStepResults && context.previousStepResults.length > 0) {
		const stepContext = context.previousStepResults
			.filter((sr) => sr.response)
			.map(
				(sr) =>
					`Step "${sr.stepDescription}": ${truncateText(sr.response || "", 500)}`,
			)
			.join("\n\n");

		if (stepContext) {
			message = `Previous step results:\n${stepContext}\n\nCurrent step:\n${originalMessage}`;
		}
	}

	// Add relevant variables
	if (context.variables && Object.keys(context.variables).length > 0) {
		const varContext = Object.entries(context.variables)
			.filter(([k]) => !k.startsWith("sys."))
			.slice(0, 10) // Limit to 10 most relevant variables
			.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
			.join("\n");

		if (varContext) {
			message = `Available context:\n${varContext}\n\n${message}`;
		}
	}

	console.log(
		"[Orchestrator] Built specialist delegation message (detailed instructions)",
	);
	return message;
}

/**
 * Summarizes conversation history for context in follow-up questions.
 * Takes the last N messages and creates a concise summary.
 */
export function summarizeConversationHistory(
	history: Array<{ role: string; content: string }>,
	maxMessages = 5,
): string {
	if (!history || history.length === 0) {
		return "";
	}

	// Take the last N messages
	const recentHistory = history.slice(-maxMessages);

	// Build a concise summary
	const summary = recentHistory
		.map((msg) => {
			const role =
				msg.role === "user"
					? "User"
					: msg.role === "assistant"
						? "Assistant"
						: "System";
			const content = truncateText(msg.content, 300);
			return `${role}: ${content}`;
		})
		.join("\n");

	return summary;
}

/**
 * Truncates text to a maximum length, adding ellipsis if truncated.
 */
export function truncateText(text: string, maxLength: number): string {
	if (!text || text.length <= maxLength) {
		return text;
	}
	return `${text.substring(0, maxLength)}...`;
}

/**
 * Builds a rich contextual delegation message using the context bag.
 *
 * This function creates comprehensive messages that include:
 * - Original task description
 * - Current step requirements
 * - Synthesized context (summary, key facts, requirements)
 * - Relevant research findings
 * - Previous step outputs
 * - Available artifacts
 */
export function buildContextualDelegationMessage(
	originalTask: string,
	step: TaskStep,
	contextBag: ContextBag,
	capabilities?: AgentCardCapabilities,
): string {
	const sections: string[] = [];

	const isGeneralist =
		capabilities?.autonomousExecution && capabilities?.taskDecomposition;

	// Header with task and step
	sections.push("# Task Context");
	sections.push(`**Original Task:** ${originalTask}`);
	sections.push(`**Current Step:** ${step.description}`);

	// Synthesized context
	if (contextBag.synthesized.summary) {
		sections.push("");
		sections.push("## Context Summary");
		sections.push(contextBag.synthesized.summary);
	}

	// Key facts
	if (contextBag.synthesized.keyFacts.length > 0) {
		sections.push("");
		sections.push("## Key Facts");
		sections.push(
			contextBag.synthesized.keyFacts
				.slice(0, 10)
				.map((f) => `- ${f}`)
				.join("\n"),
		);
	}

	// Requirements (for generation steps)
	if (
		step.type === "generate" &&
		contextBag.synthesized.requirements.length > 0
	) {
		sections.push("");
		sections.push("## Requirements");
		sections.push(
			contextBag.synthesized.requirements.map((r) => `- ${r}`).join("\n"),
		);
	}

	// Constraints
	if (contextBag.synthesized.constraints.length > 0) {
		sections.push("");
		sections.push("## Constraints");
		sections.push(
			contextBag.synthesized.constraints.map((c) => `- ${c}`).join("\n"),
		);
	}

	// Recommendations
	if (contextBag.synthesized.recommendations.length > 0) {
		sections.push("");
		sections.push("## Recommendations");
		sections.push(
			contextBag.synthesized.recommendations
				.map((r) => `- ${r}`)
				.join("\n"),
		);
	}

	// Research findings (for research-dependent steps)
	const stepInputs = step.inputs as { contextInputs?: string[] } | undefined;
	const needsResearch = stepInputs?.contextInputs?.some(
		(i) => i.includes("research") || i === "*",
	);

	if (needsResearch) {
		const allFindings = extractResearchFindings(contextBag);
		if (allFindings.length > 0) {
			sections.push("");
			sections.push("## Research Findings");
			sections.push(formatResearchFindings(allFindings.slice(0, 5)));
		}
	}

	// Previous drafts (for review/verify steps)
	if (step.type === "verify" && contextBag.artifacts.drafts.length > 0) {
		const latestDraft =
			contextBag.artifacts.drafts[contextBag.artifacts.drafts.length - 1];
		sections.push("");
		sections.push("## Draft to Review");
		const draftContent = String(latestDraft.content);
		sections.push(
			draftContent.length > 3000
				? `${draftContent.substring(0, 3000)}...\n\n[Content truncated]`
				: draftContent,
		);
	}

	// Previous reviews (for refinement steps)
	if (
		step.description.toLowerCase().includes("refine") &&
		contextBag.artifacts.reviews.length > 0
	) {
		const latestReview =
			contextBag.artifacts.reviews[
				contextBag.artifacts.reviews.length - 1
			];
		sections.push("");
		sections.push("## Review Feedback");
		sections.push(truncateText(String(latestReview.content), 1500));
	}

	// Relevant variables (non-system)
	const relevantVars = Object.entries(contextBag.variables)
		.filter(([key]) => !key.startsWith("sys."))
		.slice(0, 10);

	if (relevantVars.length > 0) {
		sections.push("");
		sections.push("## Context Variables");
		sections.push(
			relevantVars
				.map(
					([key, val]) =>
						`- **${key}:** ${formatVariableValue(val.value)}`,
				)
				.join("\n"),
		);
	}

	// For generalist agents, add autonomy guidance
	if (isGeneralist) {
		sections.push("");
		sections.push("## Execution Guidance");
		sections.push(
			"You have autonomy to decompose this task as needed. Use the provided context to inform your approach.",
		);
	}

	return sections.join("\n");
}

/**
 * Builds a minimal delegation message for simple tasks.
 */
export function buildSimpleDelegationMessage(
	task: string,
	context?: SynthesizedContext,
): string {
	if (!context || !context.summary) {
		return task;
	}

	return `${task}\n\n**Context:** ${context.summary}`;
}

/**
 * Builds a research query message for research agents.
 */
export function buildResearchQueryMessage(
	query: string,
	informationNeeds: Array<{ type: string; description: string }>,
	originalTask: string,
): string {
	const sections: string[] = [];

	sections.push("# Research Query");
	sections.push(query);
	sections.push("");
	sections.push(`**For Task:** ${originalTask}`);

	if (informationNeeds.length > 0) {
		sections.push("");
		sections.push("## Information Needs");
		sections.push(
			informationNeeds
				.map((n) => `- **${n.type}:** ${n.description}`)
				.join("\n"),
		);
	}

	sections.push("");
	sections.push("## Guidelines");
	sections.push("- Be thorough in your research");
	sections.push("- Provide specific, actionable information");
	sections.push("- Note the source of important findings");
	sections.push("- Highlight any conflicting information");

	return sections.join("\n");
}

/**
 * Extracts all research findings from the context bag.
 */
function extractResearchFindings(contextBag: ContextBag): ResearchFinding[] {
	const findings: ResearchFinding[] = [];

	// Extract from web search results
	for (const result of contextBag.research.webSearchResults) {
		if (result.findings) {
			findings.push(...result.findings);
		}
	}

	// Convert agent responses to findings
	for (const agentResponse of contextBag.research.agentResponses) {
		findings.push({
			source: agentResponse.agentId,
			content: agentResponse.response,
			relevance: 0.8,
			type: "agent",
		});
	}

	return findings;
}

/**
 * Formats research findings for display.
 */
function formatResearchFindings(findings: ResearchFinding[]): string {
	return findings
		.map((f) => {
			const sourceLabel = f.type ? `[${f.type}] ` : "";
			return `- ${sourceLabel}**${f.source}:** ${truncateText(f.content, 500)}`;
		})
		.join("\n");
}

/**
 * Formats a variable value for display.
 */
function formatVariableValue(value: unknown): string {
	if (value === null || value === undefined) {
		return "(empty)";
	}
	if (typeof value === "string") {
		return value.length > 100 ? `${value.substring(0, 100)}...` : value;
	}
	if (typeof value === "object") {
		const str = JSON.stringify(value);
		return str.length > 100 ? `${str.substring(0, 100)}...` : str;
	}
	return String(value);
}
