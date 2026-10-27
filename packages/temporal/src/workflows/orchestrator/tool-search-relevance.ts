import { isStrongToolMatch } from "../../lib/tool-search-confidence";

export type SecondaryToolSearchRunReason =
	| "explicit_intent"
	| "weak_tool_result";

type SecondarySearchDecision =
	| { run: true; reason: SecondaryToolSearchRunReason }
	| { run: false; reason: "exact_tool_name" | "unrelated" };

/**
 * Pure decisions over the call and its recorded tool-search result.
 * Intent is per search: decide() runs the requested search; with a strong
 * tool match, the other search skips unless it also has explicit intent.
 */
export function relevantExtraToolSearches(input: {
	query: string;
	category: unknown;
	knownToolNames: Iterable<string>;
	searchResult: {
		results: ReadonlyArray<{ toolName: string; confidence?: number }>;
		telemetry?: { strategy?: string };
	};
}): { agents: SecondarySearchDecision; integrations: SecondarySearchDecision } {
	const { query, category, searchResult } = input;
	const agentIntent =
		category === "agents" ||
		/\b(?:agents?|delegat\w*|hand\s+off)\b/i.test(query) ||
		/delegate_to_/i.test(query);
	const integrationIntent =
		category === "automation" ||
		/\b(?:integrations?|webhooks?|workflows?)\b/i.test(query) ||
		/integration__/i.test(query);

	// Intent takes precedence over exact-name telemetry and known-name tokens.
	const knownNames = new Set([
		...input.knownToolNames,
		...searchResult.results.map((t) => t.toolName),
	]);
	const tokens = query
		.trim()
		.split(/[^A-Za-z0-9_.-]+/)
		.filter(Boolean);
	const exactNameOnly =
		!agentIntent &&
		!integrationIntent &&
		(searchResult.telemetry?.strategy === "exact_name" ||
			(tokens.length > 0 &&
				tokens.every((token) => knownNames.has(token))));
	const weakResult = !isStrongToolMatch(searchResult);
	const decide = (intent: boolean): SecondarySearchDecision => {
		if (intent) {
			return { run: true, reason: "explicit_intent" };
		}
		if (exactNameOnly) {
			return { run: false, reason: "exact_tool_name" };
		}
		if (weakResult) {
			return { run: true, reason: "weak_tool_result" };
		}
		return { run: false, reason: "unrelated" };
	};
	return {
		agents: decide(agentIntent),
		integrations: decide(integrationIntent),
	};
}
