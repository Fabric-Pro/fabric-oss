import type {
	DirectStreamMessage,
	DirectStreamToolCall,
} from "../hooks/useDirectStream";
import type { TrajectoryStep } from "../components/FabricChat/TrajectorySteps";

const TITLE_TEMPLATES: Record<string, (tc: DirectStreamToolCall) => string> = {
	// Generic / third-party tool conventions (illustrative, used by MCP servers
	// that adopt these common names).
	search_codebase: (tc) =>
		`Searched codebase for “${argString(tc, "query")}”`,
	list_tickets: (tc) => `Listed tickets matching “${argString(tc, "query")}”`,
	fetch_url: (tc) => `Fetched ${argString(tc, "url")}`,
	read_file: (tc) => `Read file ${argString(tc, "path")}`,
	web_search: (tc) => `Searched the web for “${argString(tc, "query")}”`,

	// Fabric skills as tools — loaded via the skill registry. The slug is a
	// human-readable identifier (e.g. "mention-users", "discover-knowledge").
	load_skill: (tc) => `Loaded skill ${argString(tc, "slug")}`,

	// Fabric platform tools (see apps/web/modules/saas/mcp/lib/gateway/
	// platform-tools.ts). Read-style tools enrich the title with a
	// human-readable label pulled from the completed tool result so that
	// multiple reads in one assistant turn remain distinguishable
	// (e.g. reading two different documents must not produce two identical
	// "Read document" rows). While the tool is still running and no result
	// is available yet, the title falls back to a generic label.
	fabric_get_identity: () => "Checked identity",
	fabric_list_projects: () => "Listed projects",
	fabric_get_project: (tc) => {
		const name = resultString(tc, "name");
		return name ? `Read project “${name}”` : "Read project";
	},
	fabric_list_features: () => "Listed features",
	fabric_get_feature: (tc) => {
		const identifier = resultString(tc, "identifier");
		const title = resultString(tc, "title");
		if (identifier && title) {
			return `Read feature ${identifier} “${title}”`;
		}
		if (identifier) {
			return `Read feature ${identifier}`;
		}
		if (title) {
			return `Read feature “${title}”`;
		}
		return "Read feature details";
	},
	fabric_query_workspace: (tc) =>
		`Queried workspace for “${argString(tc, "query")}”`,
	fabric_list_documents: () => "Listed documents",
	fabric_get_document: (tc) => {
		const title = resultString(tc, "title");
		const type = resultString(tc, "type");
		if (title && type) {
			return `Read ${type} “${title}”`;
		}
		if (title) {
			return `Read document “${title}”`;
		}
		return "Read document";
	},
	fabric_list_workflows: () => "Listed workflows",
};

function argString(tc: DirectStreamToolCall, key: string): string {
	const args = (tc.args ?? {}) as Record<string, unknown>;
	return stringArg(args, key);
}

function stringArg(args: Record<string, unknown>, key: string): string {
	const v = args?.[key];
	return typeof v === "string" && v.length > 0 ? v : "(unspecified)";
}

/**
 * Pulls a non-empty string field from a completed tool call's result.
 * Returns null when the result is not yet available (tool still running),
 * when the field is missing, or when the field is not a non-empty string.
 *
 * Callers should treat null as "no enrichment available" and fall back to a
 * generic title — never to an "(unspecified)" placeholder, because that would
 * be misleading in a result preview where the field genuinely does not exist.
 */
function resultString(tc: DirectStreamToolCall, key: string): string | null {
	if (
		!tc.result ||
		typeof tc.result !== "object" ||
		Array.isArray(tc.result)
	) {
		return null;
	}
	const v = (tc.result as Record<string, unknown>)[key];
	return typeof v === "string" && v.length > 0 ? v : null;
}

function statusFromToolCall(
	s: DirectStreamToolCall["status"],
): TrajectoryStep["status"] {
	switch (s) {
		case "complete":
			return "success";
		case "error":
			return "error";
		case "running":
		case "pending":
			return "running";
	}
}

export function deriveTrajectorySteps(
	message: DirectStreamMessage,
): TrajectoryStep[] {
	const toolCalls = message.toolCalls ?? [];
	const steps: TrajectoryStep[] = toolCalls.map(humanizeToolCall);

	// Prepend a thinking step when the model produced reasoning content.
	// We treat whitespace-only reasoningText as "no reasoning" so a model
	// that streams a stray blank chunk does not get a noisy header.
	const reasoningText = message.reasoningText;
	if (typeof reasoningText === "string" && reasoningText.trim().length > 0) {
		const isStillStreaming = message.isStreaming === true;
		steps.unshift({
			id: `${message.id}-thinking`,
			type: "thinking",
			title: isStillStreaming ? "Thinking…" : "Thought",
			description: reasoningText,
			status: isStillStreaming ? "running" : "success",
			// Pass duration through; TrajectorySteps.tsx renders "Thought for X.Ys"
			// when step.status === "success" && step.duration is set.
			duration: isStillStreaming
				? undefined
				: message.reasoningDurationMs,
		});
	}

	const isComplete = message.isStreaming === false;
	const hasContent =
		typeof message.content === "string" &&
		message.content.trim().length > 0;
	if (isComplete && hasContent && toolCalls.length > 0) {
		steps.push({
			id: `${message.id}-reflection`,
			type: "reflection",
			title: "Summarized findings",
			status: "success",
		});
	}

	return steps;
}

export function humanizeToolCall(tc: DirectStreamToolCall): TrajectoryStep {
	const args = (tc.args ?? {}) as Record<string, unknown>;
	const template = TITLE_TEMPLATES[tc.name];
	const title = template ? template(tc) : `Called ${tc.name}`;
	const isError = tc.status === "error";

	return {
		id: tc.id,
		type: isError ? "error" : "tool_call",
		title,
		status: statusFromToolCall(tc.status),
		metadata: {
			toolName: tc.name,
			input: args,
			output: !isError ? tc.result : undefined,
			error:
				isError && tc.result != null
					? typeof tc.result === "string"
						? tc.result
						: JSON.stringify(tc.result)
					: undefined,
		},
	};
}
