type AgentSuggestionKind =
	| "instructions"
	| "tools"
	| "reliability"
	| "discovery";

export type AgentSuggestionState =
	| "pending"
	| "approved"
	| "rejected"
	| "outdated";

export interface AgentSuggestion {
	id: string;
	kind: AgentSuggestionKind;
	title: string;
	description: string;
	state: AgentSuggestionState;
	createdAt: string;
	updatedAt: string;
}

export interface SuggestionSourceAgent {
	id: string;
	displayName: string;
	description?: string | null;
	status: string;
	deploymentUrl?: string | null;
	lastHealthCheck?: string | Date | null;
	conversationCount?: number;
	config?: Record<string, unknown> | null;
}

function createSuggestion(
	seed: string,
	kind: AgentSuggestionKind,
	title: string,
	description: string,
): AgentSuggestion {
	const now = new Date().toISOString();

	return {
		id: seed,
		kind,
		title,
		description,
		state: "pending",
		createdAt: now,
		updatedAt: now,
	};
}

export function buildDefaultAgentSuggestions(
	agent: SuggestionSourceAgent,
): AgentSuggestion[] {
	const suggestions: AgentSuggestion[] = [];

	if (!agent.description?.trim()) {
		suggestions.push(
			createSuggestion(
				`${agent.id}-description`,
				"instructions",
				"Add a clearer description",
				"Describe the agent's operating boundary, ideal tasks, and any constraints so users can choose it more confidently.",
			),
		);
	}

	if (!agent.deploymentUrl) {
		suggestions.push(
			createSuggestion(
				`${agent.id}-endpoint`,
				"discovery",
				"Attach a deployment endpoint",
				"Register a deployment URL so health checks and direct access surfaces can verify the agent automatically.",
			),
		);
	}

	if (agent.status !== "ACTIVE") {
		suggestions.push(
			createSuggestion(
				`${agent.id}-status`,
				"reliability",
				"Resolve runtime health issues",
				"Investigate the current non-active status and restore the agent before exposing it broadly to users.",
			),
		);
	}

	if (!agent.lastHealthCheck) {
		suggestions.push(
			createSuggestion(
				`${agent.id}-healthcheck`,
				"reliability",
				"Run an initial health check",
				"Record a recent health check so operators can tell whether the endpoint is live and reachable.",
			),
		);
	}

	if ((agent.conversationCount ?? 0) === 0) {
		suggestions.push(
			createSuggestion(
				`${agent.id}-adoption`,
				"tools",
				"Improve first-run adoption",
				"Add starter prompts, examples, or a narrower purpose statement so users understand when to use this agent.",
			),
		);
	}

	return suggestions;
}

export function mergeSuggestionStates(
	current: AgentSuggestion[],
	updates: Array<{ id: string; state: AgentSuggestionState }>,
): AgentSuggestion[] {
	const stateById = new Map(
		updates.map((update) => [update.id, update.state]),
	);

	return current.map((suggestion) =>
		stateById.has(suggestion.id)
			? {
					...suggestion,
					state: stateById.get(suggestion.id) ?? suggestion.state,
					updatedAt: new Date().toISOString(),
				}
			: suggestion,
	);
}
