/**
 * Prompt Template Loader for Orchestrator Activities
 *
 * Loads and renders prompt templates from markdown files.
 * Templates use {{variableName}} for variable substitution.
 */

import fs from "node:fs";
import path from "node:path";

const promptsDir = path.join(__dirname);

// Cache for loaded prompt templates
const promptCache = new Map<string, string>();

/**
 * Loads a prompt template from a markdown file.
 * Templates are cached after first load.
 *
 * @param templateName - Name of the template file (without .md extension)
 * @returns The raw template content
 */
export function loadPromptTemplate(templateName: string): string {
	const cached = promptCache.get(templateName);
	if (cached) {
		return cached;
	}

	const templatePath = path.join(promptsDir, `${templateName}.md`);

	try {
		const content = fs.readFileSync(templatePath, "utf-8");
		promptCache.set(templateName, content);
		return content;
	} catch (error) {
		console.error(
			`[Prompts] Failed to load template: ${templateName}`,
			error,
		);
		throw new Error(`Prompt template not found: ${templateName}`);
	}
}

/**
 * Renders a prompt template with variable substitution.
 * Variables are replaced using {{variableName}} syntax.
 *
 * @param template - The template string
 * @param variables - Object containing variable values
 * @returns The rendered prompt
 */
export function renderPrompt(
	template: string,
	variables: Record<string, string>,
): string {
	let result = template;

	for (const [key, value] of Object.entries(variables)) {
		const regex = new RegExp(`\\{\\{${key}\\}\\}`, "g");
		result = result.replace(regex, value);
	}

	return result;
}

/**
 * Loads and renders a prompt template in one call.
 *
 * @param templateName - Name of the template file (without .md extension)
 * @param variables - Object containing variable values
 * @returns The rendered prompt
 */
export function loadAndRenderPrompt(
	templateName: string,
	variables: Record<string, string>,
): string {
	const template = loadPromptTemplate(templateName);
	return renderPrompt(template, variables);
}

// ============================================================================
// Pre-built Prompt Loaders
// ============================================================================

/**
 * Formats conversation history for inclusion in prompts.
 * Shows recent messages to provide context for routing/planning decisions.
 */
function formatConversationContext(
	history?: Array<{ role: string; content: string }>,
	maxMessages = 5,
): string {
	if (!history || history.length === 0) {
		return "";
	}

	// Take the most recent messages
	const recentHistory = history.slice(-maxMessages);

	if (recentHistory.length === 0) {
		return "";
	}

	const formattedMessages = recentHistory
		.map((msg) => {
			const role = msg.role === "user" ? "User" : "Assistant";
			// Truncate very long messages
			const content =
				msg.content.length > 500
					? `${msg.content.slice(0, 500)}...`
					: msg.content;
			return `${role}: ${content}`;
		})
		.join("\n\n");

	return `## Conversation Context

The following is the recent conversation history. Use this context to understand follow-up requests and continuity:

${formattedMessages}

---`;
}

/**
 * Loads the routing system prompt with variable substitution.
 */
export function getRoutingSystemPrompt(variables: {
	mcpToolDescriptions: string;
	agentDescriptions: string;
	mcpDirectHint: string;
	conversationHistory?: Array<{ role: string; content: string }>;
	memoryContext?: string;
}): string {
	const conversationContext = formatConversationContext(
		variables.conversationHistory,
	);

	// Format memory context if provided (includes learned patterns)
	// Make learned patterns highly visible and actionable
	const memoryContextSection = variables.memoryContext
		? `\n## CRITICAL: User Preferences & Learned Patterns\n**You MUST follow these user preferences when executing tasks:**\n${variables.memoryContext}\n---\n`
		: "";

	return loadAndRenderPrompt("routing-system-prompt", {
		mcpToolDescriptions: variables.mcpToolDescriptions,
		agentDescriptions: variables.agentDescriptions,
		mcpDirectHint: variables.mcpDirectHint,
		conversationContext,
		memoryContext: memoryContextSection,
	});
}

/**
 * Loads the task planning system prompt with variable substitution.
 * Combines the main prompt, examples, and rules.
 */
export function getTaskPlanningSystemPrompt(variables: {
	agentDelegationGuidance: string;
	conversationHistory?: Array<{ role: string; content: string }>;
}): string {
	const conversationContext = formatConversationContext(
		variables.conversationHistory,
	);
	const mainPrompt = loadAndRenderPrompt("task-planning-system-prompt", {
		agentDelegationGuidance: variables.agentDelegationGuidance,
		conversationContext,
	});
	const examples = loadPromptTemplate("task-planning-examples");
	const rules = loadPromptTemplate("task-planning-rules");

	return `${mainPrompt}\n\n${examples}\n\n${rules}`;
}

/**
 * Clears the prompt cache. Useful for development/testing.
 */
export function clearPromptCache(): void {
	promptCache.clear();
}

// ============================================================================
// Factory AI-Style Orchestrator Prompts
// ============================================================================

/**
 * Loads the enhanced orchestrator system prompt with journey tracking.
 * This is the main Factory AI-style prompt for intelligent orchestration.
 */
export function getOrchestratorSystemPrompt(variables: {
	mcpToolDescriptions: string;
	agentDescriptions: string;
	workflowDescriptions?: string;
}): string {
	return loadAndRenderPrompt("orchestrator-system-prompt", {
		mcpToolDescriptions: variables.mcpToolDescriptions,
		agentDescriptions: variables.agentDescriptions,
		workflowDescriptions:
			variables.workflowDescriptions || "No workflows configured.",
	});
}

/**
 * Loads the journey-aware planning prompt for adaptive task planning.
 */
export function getJourneyPlanningPrompt(variables: {
	journeyContext: string;
	journeyPhase: string;
	completedStepsCount: string;
	hasActivePlan: string;
	priorDecisions?: string;
	assumptions?: string;
	mcpToolDescriptions: string;
	agentDescriptions: string;
	userIntentAnalysis: string;
}): string {
	// Handle optional sections with conditional rendering
	let template = loadPromptTemplate("journey-planning-prompt");

	// Simple conditional block handling
	if (variables.priorDecisions) {
		template = template.replace(
			/\{\{#if priorDecisions\}\}([\s\S]*?)\{\{\/if\}\}/g,
			"$1".replace("{{priorDecisions}}", variables.priorDecisions),
		);
	} else {
		template = template.replace(
			/\{\{#if priorDecisions\}\}[\s\S]*?\{\{\/if\}\}/g,
			"",
		);
	}

	if (variables.assumptions) {
		template = template.replace(
			/\{\{#if assumptions\}\}([\s\S]*?)\{\{\/if\}\}/g,
			"$1".replace("{{assumptions}}", variables.assumptions),
		);
	} else {
		template = template.replace(
			/\{\{#if assumptions\}\}[\s\S]*?\{\{\/if\}\}/g,
			"",
		);
	}

	return renderPrompt(template, variables);
}

/**
 * Loads the plan adaptation prompt for mid-execution modifications.
 */
export function getPlanAdaptationPrompt(variables: {
	originalGoal: string;
	planStatus: string;
	completedSteps: string;
	currentStep: string;
	pendingSteps: string;
	userMessage: string;
}): string {
	return loadAndRenderPrompt("plan-adaptation-prompt", variables);
}
