import {
	type NormalizedToolDefinition,
	normalizeAdvisorToolDefinition,
} from "./advisor-tool-definition";
import type { RiskAssessmentOptions } from "./risk-assessment";
import type { IterativeMessage, WorkflowState } from "./types";

export const CALL_TOOL_PATCH = "orch-call-tool-v1";
export const META_TOOL_NAMES = new Set([
	"search_tools",
	"get_tool_schema",
	"call_tool",
]);
export type ToolBinding =
	| { kind: "config"; configId: string }
	| { kind: "agent"; agentId: string }
	| {
			kind: "oauth";
			prefix: "microsoft_teams__" | "github__" | "slack__";
			configId?: string;
	  }
	| {
			kind: "databricks";
			metadata: NonNullable<
				NonNullable<
					WorkflowState["preloadedResources"]
				>["toolMap"][string]["dispatchMetadata"]
			>;
	  }
	| { kind: "loop" }
	| { kind: "offered_lookup" };
export interface CallableEntry {
	definition: NormalizedToolDefinition;
	binding: ToolBinding;
	provenance: "initial" | "search";
	admittedAtRequest: number;
}
export type CallableRegistry = Map<string, CallableEntry>;
export type RefusalReason =
	| "not_admitted"
	| "meta_tool"
	| "suppressed"
	| "malformed_arguments"
	| "binding_conflict";
export interface EffectiveToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	binding: ToolBinding;
	outcome?: "success" | "error" | "interrupted" | "refused";
	riskOptions?: RiskAssessmentOptions;
}
export type EffectiveToolCalls = Record<string, EffectiveToolCall | null>;
export function admitCallable(
	registry: CallableRegistry,
	name: string,
	entry: CallableEntry,
	suppressed: ReadonlySet<string>,
): RefusalReason | undefined {
	if (META_TOOL_NAMES.has(name)) {
		return "meta_tool";
	}
	if (suppressed.has(name)) {
		return "suppressed";
	}
	const previous = registry.get(name);
	if (previous) {
		// OAuth executors use the selected provider and tool name, not the config label.
		const dispatchIdentity = (binding: ToolBinding) =>
			binding.kind === "oauth"
				? { kind: binding.kind, prefix: binding.prefix }
				: binding;
		return JSON.stringify(dispatchIdentity(previous.binding)) ===
			JSON.stringify(dispatchIdentity(entry.binding))
			? undefined
			: "binding_conflict";
	}
	registry.set(name, entry);
}
export function toolBinding(
	name: string,
	configId: string | undefined,
	preloaded?: NonNullable<
		WorkflowState["preloadedResources"]
	>["toolMap"][string],
	directMeetingListing = false,
): ToolBinding {
	// Mirrors the workflow dispatch order, then EMT's OAuth prefix order.
	if (name.startsWith("delegate_to_")) {
		return { kind: "agent", agentId: name.slice("delegate_to_".length) };
	}
	if (
		preloaded?.serverName === "databricks-vector-search" &&
		preloaded.dispatchMetadata
	) {
		return { kind: "databricks", metadata: preloaded.dispatchMetadata };
	}
	if (
		name.startsWith("workspace_rag") ||
		name === "project_rag_query" ||
		(name === "fabric_list_meeting_transcripts" && directMeetingListing) ||
		name === "search_slack_messages" ||
		name === "search_teams_messages" ||
		name === "list_skills" ||
		name === "load_skill" ||
		name === "read_skill_file"
	) {
		return { kind: "loop" };
	}
	const lower = name.toLowerCase();
	// Integration operations precede OAuth routing in executeMcpTool.
	if (!lower.startsWith("integration__")) {
		for (const [prefix, configPrefix] of [
			["microsoft_teams__", "microsoft-teams-connected:"],
			["github__", "github-connected:"],
			["slack__", "slack-connected:"],
		] as const) {
			if (
				configId?.startsWith(configPrefix) ||
				lower.startsWith(prefix)
			) {
				return {
					kind: "oauth",
					prefix,
					// Retain a config-driven route when the name cannot select it.
					...(!lower.startsWith(prefix) && configId
						? { configId }
						: {}),
				};
			}
		}
	}
	if (configId) {
		return { kind: "config", configId };
	}
	return { kind: "offered_lookup" };
}
export function objectArguments(
	input: unknown,
): Record<string, unknown> | undefined {
	let value = input;
	if (typeof value === "string") {
		try {
			value = value.trim() ? JSON.parse(value) : {};
		} catch {
			return undefined;
		}
	}
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
export function unwrapCall(
	call: { id: string; args: Record<string, unknown> },
	targets: CallableRegistry,
	suppressed: ReadonlySet<string>,
): { call: EffectiveToolCall } | { reason: RefusalReason } {
	const name = call.args.name;
	if (typeof name !== "string") {
		return { reason: "not_admitted" };
	}
	if (META_TOOL_NAMES.has(name)) {
		return { reason: "meta_tool" };
	}
	if (suppressed.has(name)) {
		return { reason: "suppressed" };
	}
	const entry = targets.get(name);
	if (!entry) {
		return { reason: "not_admitted" };
	}
	const args = objectArguments(
		call.args.arguments === undefined ? "" : call.args.arguments,
	);
	if (!args) {
		return { reason: "malformed_arguments" };
	}
	return { call: { id: call.id, name, args, binding: entry.binding } };
}
/** Bound the discovery response as valid JSON; omitted schemas remain in the registry. */
export function foundToolDefinitions(
	names: string[],
	registry: CallableRegistry,
) {
	const entries = [...new Set(names)].flatMap((name) => {
		const entry = registry.get(name);
		return entry ? [{ name, ...entry.definition }] : [];
	});
	const stubs = entries.map((entry) => ({
		name: entry.name,
		description: "",
		schemaNote: "Use get_tool_schema.",
	}));
	// Reserve a name and a description slot before including full schemas.
	const fixed = JSON.stringify(stubs).length;
	const descriptionLimit = Math.min(
		160,
		Math.max(0, Math.floor((9_000 - fixed) / Math.max(entries.length, 1))),
	);
	const result: Array<{
		name: string;
		description: string;
		inputSchema?: Record<string, unknown>;
		schemaNote?: string;
	}> = stubs.map((stub, index) => ({
		...stub,
		description: entries[index].description.slice(0, descriptionLimit),
	}));
	let chars = JSON.stringify(result).length;
	for (let index = 0; index < entries.length; index++) {
		const delta =
			JSON.stringify(entries[index]).length -
			JSON.stringify(result[index]).length;
		if (chars + delta <= 9_000) {
			result[index] = entries[index];
			chars += delta;
		}
	}
	return result;
}

export const CALL_TOOL_DEFINITIONS = {
	get_tool_schema: {
		description:
			"Return a tool definition admitted for this request. Search with search_tools first if the name is unknown.",
		inputSchema: {
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		},
	},
	call_tool: {
		description:
			"Run an admitted tool by exact name using its arguments. Tools found by search_tools are callable from the next request. Use get_tool_schema for its definition.",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string" },
				arguments: {
					description:
						"Tool arguments as an object or a JSON object string.",
				},
			},
			required: ["name"],
		},
	},
};
export function normalizedEntry(
	name: string,
	definition: { description?: string; inputSchema?: Record<string, unknown> },
	binding: ToolBinding,
	provenance: CallableEntry["provenance"],
	request: number,
): CallableEntry {
	return {
		definition: normalizeAdvisorToolDefinition(name, definition),
		binding,
		provenance,
		admittedAtRequest: request,
	};
}
/** Resolve only host-recorded identities. Wrapper arguments are not authority. */
export function resolveEffectiveCall<
	T extends { id: string; name: string; args: Record<string, unknown> },
>(call: T, effective?: EffectiveToolCalls): T | EffectiveToolCall | undefined {
	if (call.name !== "call_tool" || !effective) {
		return call;
	}
	return effective && Object.hasOwn(effective, call.id)
		? (effective[call.id] ?? undefined)
		: undefined;
}
export function historyCallIndex(
	history: IterativeMessage[],
	effective?: EffectiveToolCalls,
	strictDuplicates = effective !== undefined,
) {
	const calls = new Map<
		string,
		{ id: string; name: string; args: Record<string, unknown> } | null
	>();
	for (const message of history) {
		if (message.role !== "assistant") {
			continue;
		}
		for (const call of message.toolCalls ?? []) {
			calls.set(
				call.id,
				strictDuplicates && calls.has(call.id)
					? null
					: (resolveEffectiveCall(call, effective) ?? null),
			);
		}
	}
	return calls;
}
