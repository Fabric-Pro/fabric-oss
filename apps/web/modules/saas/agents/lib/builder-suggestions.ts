export interface BuilderSuggestion {
	id: string;
	title: string;
	description: string;
	actionLabel?: string;
	action:
		| "seed-description"
		| "seed-system-prompt"
		| "open-capabilities"
		| "open-preview"
		| "review-knowledge";
}

export interface BuilderSuggestionInput {
	displayName: string;
	description: string;
	systemPrompt: string;
	knowledgeSourceCount: number;
	capabilityCount: number;
	hasPreviewed: boolean;
}

export function buildAgentBuilderSuggestions(
	input: BuilderSuggestionInput,
): BuilderSuggestion[] {
	const suggestions: BuilderSuggestion[] = [];

	if (!input.description.trim()) {
		suggestions.push({
			id: "description",
			title: "Draft an operating boundary",
			description:
				"Add a short description so people know when this agent is useful and where it should stop.",
			actionLabel: "Draft description",
			action: "seed-description",
		});
	}

	if (!input.systemPrompt.trim()) {
		suggestions.push({
			id: "system-prompt",
			title: "Write a starter instruction set",
			description:
				"Seed a concrete role, success criteria, and response style before you add tools.",
			actionLabel: "Draft prompt",
			action: "seed-system-prompt",
		});
	}

	if (input.capabilityCount === 0) {
		suggestions.push({
			id: "capabilities",
			title: "Attach capabilities or MCP tools",
			description:
				"Connect built-in capabilities, skills, or MCP servers so the agent can do more than answer from its prompt.",
			actionLabel: "Choose tools",
			action: "open-capabilities",
		});
	}

	if (input.knowledgeSourceCount === 0) {
		suggestions.push({
			id: "knowledge",
			title: "Decide on retrieval scope",
			description:
				"Add a workspace if the agent should answer from indexed company knowledge instead of live tools.",
			actionLabel: "Review knowledge",
			action: "review-knowledge",
		});
	}

	if (!input.hasPreviewed && input.systemPrompt.trim()) {
		suggestions.push({
			id: "preview",
			title: "Run a draft conversation",
			description:
				"Test the draft once before saving so you can catch prompt or tool gaps early.",
			actionLabel: "Open test panel",
			action: "open-preview",
		});
	}

	return suggestions;
}

export function getSuggestedDescription(displayName: string): string {
	const name = displayName.trim() || "This agent";
	return `${name} helps with a narrow set of tasks, explains its reasoning briefly, and hands off when the request needs tools or context it does not have.`;
}

export function getSuggestedSystemPrompt(displayName: string): string {
	const name = displayName.trim() || "You";
	return [
		`You are ${name}.`,
		"",
		"Focus on the specific jobs this agent is meant to handle well.",
		"Ask a clarifying question when the request is ambiguous or missing context.",
		"Use connected tools only when they materially improve the answer.",
		"If the request falls outside your boundary, say so directly and suggest the next best handoff.",
	].join("\n");
}
