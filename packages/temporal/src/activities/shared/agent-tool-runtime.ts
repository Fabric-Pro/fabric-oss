import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";

export interface AgentToolSource {
	configId: string;
	originalName: string;
}

export interface AgentToolInvocation {
	name: string;
	description?: string;
	inputSchema: unknown;
	args: unknown;
	callId?: string;
	delegates: boolean;
	source: AgentToolSource;
	execute: () => Promise<unknown>;
}

export interface AgentToolRuntime {
	invoke: (invocation: AgentToolInvocation) => Promise<unknown>;
	prepared?: (
		tools: Record<string, unknown>,
		sources: Record<string, AgentToolSource>,
	) => Promise<string>;
	requiredTool?: AgentToolSource;
	projectScope?: {
		projectId: string;
		userId: string;
		organizationId: string;
	};
	abortSignal?: AbortSignal;
	onText?: (text: string) => void;
}

interface ExecutableTool {
	description?: string;
	inputSchema: unknown;
	execute: (...args: unknown[]) => unknown;
	approvalBoundary?: "delegation";
}

const runtimeStorage = new AsyncLocalStorage<AgentToolRuntime>();
interface ApprovedTool extends AgentToolSource {
	userId: string;
	organizationId?: string;
	args: unknown;
}
const approvalStorage = new AsyncLocalStorage<ApprovedTool>();

export function withApprovedAgentTool<T>(
	approval: ApprovedTool,
	run: () => Promise<T>,
): Promise<T> {
	return approvalStorage.run(approval, run);
}

export function hasExactAgentToolApproval(invocation: ApprovedTool): boolean {
	const approval = approvalStorage.getStore();
	return Boolean(approval && isDeepStrictEqual(approval, invocation));
}

export function requiredAgentTool(): AgentToolSource | undefined {
	return runtimeStorage.getStore()?.requiredTool;
}

export function agentToolProjectScope() {
	return runtimeStorage.getStore()?.projectScope;
}

export function observeAgentText(text: string): void {
	if (text) {
		runtimeStorage.getStore()?.onText?.(text);
	}
}

export function agentToolAbortSignal(
	fallback?: AbortSignal,
): AbortSignal | undefined {
	const signal = runtimeStorage.getStore()?.abortSignal;
	return signal && fallback
		? AbortSignal.any([signal, fallback])
		: (signal ?? fallback);
}

export function withAgentToolRuntime<T>(
	runtime: AgentToolRuntime,
	run: () => Promise<T>,
): Promise<T> {
	return runtimeStorage.run(runtime, run);
}

export function isExecutableAgentTool(value: unknown): value is ExecutableTool {
	return (
		typeof value === "object" &&
		value !== null &&
		"inputSchema" in value &&
		"execute" in value &&
		typeof value.execute === "function"
	);
}

function toolCallId(options: unknown): string | undefined {
	return typeof options === "object" &&
		options !== null &&
		"toolCallId" in options &&
		typeof options.toolCallId === "string"
		? options.toolCallId
		: undefined;
}

export async function prepareAgentTools(
	tools: Record<string, unknown>,
	sources: Record<string, AgentToolSource> = {},
): Promise<string | undefined> {
	const runtime = runtimeStorage.getStore();
	if (!runtime) {
		return;
	}
	if (runtime.prepared) {
		return runtime.prepared(tools, sources);
	}
	for (const [name, definition] of Object.entries(tools)) {
		if (!isExecutableAgentTool(definition)) {
			delete tools[name];
			continue;
		}
		tools[name] = {
			...definition,
			execute: (...args: unknown[]) =>
				runtime.invoke({
					name,
					description: definition.description,
					inputSchema: definition.inputSchema,
					args: args[0],
					callId: toolCallId(args[1]),
					delegates: definition.approvalBoundary === "delegation",
					source: sources[name] ?? {
						configId: "builtin",
						originalName: name,
					},
					execute: async () => definition.execute(...args),
				}),
		};
	}
}
