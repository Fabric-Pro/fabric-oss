import {
	type AGUIEvent,
	type Message,
	type RunAgentInput,
	runHttpRequest,
	transformHttpEventStream,
} from "@ag-ui/client";
import { EventSchemas } from "@ag-ui/core/schemas";
import { z } from "zod";
import type {
	DirectSendOptions,
	UseDirectStreamOptions,
} from "../hooks/useDirectStream";
import { trimHistoryForRequest } from "./direct-chat-turns";
import type { loadInstanceAgentConfig } from "./load-instance-agent-config";

/**
 * The agent runtime's REST endpoints (CopilotKit's v2 routes, served by
 * `app/api/agents/runtime/[[...path]]/route.ts`) for one runtime agent.
 */
export function runtimePaths(agentId: string) {
	return {
		run: `/api/agents/runtime/agent/${agentId}/run`,
		connect: `/api/agents/runtime/agent/${agentId}/connect`,
		stop: (threadId: string) =>
			`/api/agents/runtime/agent/${agentId}/stop/${encodeURIComponent(threadId)}`,
	} as const;
}

/** The Direct agent's endpoints. */
export const DIRECT_RUNTIME_PATHS = runtimePaths("fabric-direct");

/** The organization a runtime request runs in. */
const ORGANIZATION_HEADER = "x-fabric-organization-id";

const httpErrorSchema = z.object({
	payload: z
		.object({
			message: z.string().optional(),
			error: z.string().optional(),
		})
		.passthrough(),
});

/** The endpoint answered with an HTTP error (a definite refusal, not a dropped connection). */
export function isRuntimeHttpError(error: unknown): boolean {
	return httpErrorSchema.safeParse(error).success;
}

export function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/** What a failed request says, as the stream route's chat words it. */
export function errorMessageOf(error: unknown): string {
	const http = httpErrorSchema.safeParse(error);
	if (http.success) {
		return (
			http.data.payload.message ||
			http.data.payload.error ||
			"Failed to stream response"
		);
	}
	return error instanceof Error ? error.message : "Stream failed";
}

export function runtimeHeaders(
	organizationId: string | undefined,
): HeadersInit {
	return {
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		...(organizationId ? { [ORGANIZATION_HEADER]: organizationId } : {}),
	};
}

/**
 * POST one runtime request and hand each AG-UI event over until the response
 * ends; rejects with the request's failure (an `AbortError` once aborted).
 */
export function streamRuntime(args: {
	url: string;
	input: RunAgentInput;
	organizationId: string | undefined;
	signal: AbortSignal;
	onEvent: (event: AGUIEvent) => void;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		transformHttpEventStream(
			runHttpRequest(() =>
				fetch(args.url, {
					method: "POST",
					headers: runtimeHeaders(args.organizationId),
					body: JSON.stringify(args.input),
					signal: args.signal,
				}),
			),
		).subscribe({
			next: (event) => {
				const parsed = EventSchemas.safeParse(event);
				if (parsed.success) {
					args.onEvent(parsed.data);
				}
			},
			error: reject,
			complete: resolve,
		});
	});
}

/** A connect names only the thread; AG-UI's input shape carries it. */
export function connectInput(threadId: string): RunAgentInput {
	return {
		threadId,
		runId: crypto.randomUUID(),
		messages: [],
		tools: [],
		context: [],
		state: {},
	};
}

/** The chat's options a turn's request carries. */
type TurnRequestOptions = Pick<
	UseDirectStreamOptions,
	| "reasoningMode"
	| "modelOverride"
	| "enabledMcpConfigIds"
	| "restrictInstanceMcpScope"
	| "enabledFabricToolIds"
	| "instanceId"
	| "chatId"
	| "workspaceIds"
	| "workspaceDocumentIds"
	| "projectId"
	| "repositoryUrl"
	| "storyId"
	| "documentId"
	| "taskId"
	| "launchWorkspaceId"
	| "launchFrameId"
	| "launchSurface"
	| "systemPrompt"
>;

/**
 * One turn's run request. The Direct route's request fields ride in
 * `forwardedProps`, which the runtime admits with the route's own validation;
 * the message, the history, the organization and the conversation are the
 * runtime's own, and an approved call is the one it recorded. An approval
 * (`interruptId`) sends no new message: it resumes the interrupt.
 */
export function directTurnInput(args: {
	threadId: string;
	runId: string;
	question: { id: string; content: string };
	history: Array<{ role: "user" | "assistant"; content: string }>;
	interruptId: string | null;
	options: TurnRequestOptions;
	send: Pick<
		DirectSendOptions,
		"attachedDocumentIds" | "messageChatId" | "inlineAttachmentContexts"
	>;
	agentConfig: Awaited<ReturnType<typeof loadInstanceAgentConfig>> | null;
}): RunAgentInput {
	const { options, send, agentConfig } = args;
	const history: Message[] = trimHistoryForRequest(args.history).map(
		(message, index) => ({
			id: `${args.runId}-history-${index}`,
			role: message.role,
			content: message.content,
		}),
	);
	return {
		threadId: args.threadId,
		runId: args.runId,
		messages: args.interruptId
			? history
			: [
					...history,
					{
						id: args.question.id,
						role: "user",
						content: args.question.content,
					},
				],
		tools: [],
		context: [],
		state: {},
		...(args.interruptId
			? {
					resume: [
						{
							interruptId: args.interruptId,
							status: "resolved" as const,
							payload: { approved: true },
						},
					],
				}
			: {}),
		forwardedProps: {
			reasoningMode: options.reasoningMode ?? "balanced",
			modelOverride: options.modelOverride,
			enabledMcpConfigIds:
				agentConfig &&
				(options.restrictInstanceMcpScope ||
					agentConfig.hasMcpConfiguration)
					? agentConfig.enabledMcpConfigIds
					: (options.enabledMcpConfigIds ?? null),
			enabledFabricToolIds:
				agentConfig?.enabledFabricToolIds ??
				options.enabledFabricToolIds ??
				null,
			instanceId: options.instanceId,
			chatId: send.messageChatId || options.chatId,
			attachedDocumentIds: send.attachedDocumentIds,
			inlineAttachmentContexts: send.inlineAttachmentContexts,
			workspaceIds: options.workspaceIds,
			workspaceDocumentIds: options.workspaceDocumentIds,
			projectId:
				options.projectId !== undefined
					? options.projectId
					: agentConfig?.boundProjectId,
			repositoryUrl: options.repositoryUrl,
			storyId: options.storyId,
			documentId: options.documentId,
			taskId: options.taskId,
			workspaceId: options.launchWorkspaceId ?? undefined,
			launchFrameId: options.launchFrameId ?? undefined,
			surface: options.launchSurface ?? undefined,
			systemPrompt:
				options.systemPrompt ?? agentConfig?.instructions ?? undefined,
		},
	};
}
