/**
 * The Direct chat over the agent runtime: the AG-UI events the runtime's
 * Direct engine sends (`runtime/turn-translator.ts`, `direct-turn-follow.ts`)
 * must land in the same message fields the stream route's chat fills, and
 * the runtime-only behaviour (thread = conversation, reconnect after the
 * response window, reattach on open, stop, approval by resume) must hold.
 *
 * The transport is real (`@ag-ui/client`'s HTTP + SSE parsing); only `fetch`
 * is faked, answering each runtime route with a scripted event stream.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastMock = vi.fn();
vi.mock("../../lib/cancel-telemetry", () => ({
	emitCancelEvent: vi.fn(),
}));
vi.mock("@saas/payments/lib/ai-usage-limit-toast", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/payments/lib/ai-usage-limit-toast")
	>()),
	useShowAiUsageLimitToast: () => toastMock,
}));

import { emitCancelEvent } from "../../lib/cancel-telemetry";
import {
	type UseDirectRuntimeStreamOptions,
	useDirectRuntimeStream,
} from "../useDirectRuntimeStream";
import { useWorkflowConfirmation } from "../useWorkflowConfirmation";

type RuntimeEvent = Record<string, unknown>;

interface RuntimeRequest {
	url: string;
	signal?: AbortSignal | null;
	headers: Record<string, string>;
	body: {
		threadId: string;
		runId: string;
		messages: Array<{ id: string; role: string; content: string }>;
		forwardedProps?: Record<string, unknown>;
		resume?: Array<Record<string, unknown>>;
	};
}

/** An SSE response whose events can be pushed while the hook reads it. */
function liveSse() {
	const encoder = new TextEncoder();
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	return {
		response: new Response(stream, {
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
		}),
		push: (...events: RuntimeEvent[]) => {
			for (const event of events) {
				controller?.enqueue(
					encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
				);
			}
		},
		close: () => controller?.close(),
		/** What a real `fetch` does to the body of a request it aborts. */
		abortOn: (signal: AbortSignal | null | undefined) => {
			signal?.addEventListener("abort", () =>
				controller?.error(
					new DOMException(
						"The operation was aborted.",
						"AbortError",
					),
				),
			);
		},
	};
}

function sse(events: RuntimeEvent[]): Response {
	const live = liveSse();
	live.push(...events);
	live.close();
	return live.response;
}

const requests: RuntimeRequest[] = [];
let respond: (request: RuntimeRequest) => Response = () => sse([]);

beforeEach(() => {
	requests.length = 0;
	toastMock.mockReset();
	vi.mocked(emitCancelEvent).mockClear();
	respond = () => sse([]);
	vi.spyOn(global, "fetch").mockImplementation((async (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const request: RuntimeRequest = {
			url: String(input),
			signal: init?.signal,
			headers: Object.fromEntries(
				Object.entries((init?.headers ?? {}) as Record<string, string>),
			),
			body: JSON.parse(String(init?.body ?? "{}")),
		};
		requests.push(request);
		return respond(request);
	}) as typeof fetch);
});

afterEach(() => {
	vi.restoreAllMocks();
});

const RUN_URL = "/api/agents/runtime/agent/fabric-direct/run";
const CONNECT_URL = "/api/agents/runtime/agent/fabric-direct/connect";

const started = (threadId: string, runId: string, question = "hello") => ({
	type: "RUN_STARTED",
	threadId,
	runId,
	input: {
		threadId,
		runId,
		messages: [{ id: `${runId}:user`, role: "user", content: question }],
		tools: [],
		context: [],
	},
});
const execution = (executionId: string) => [
	{ type: "STATE_SNAPSHOT", snapshot: { executionId, progress: null } },
	{ type: "CUSTOM", name: "fabric.execution", value: { executionId } },
];
const text = (key: string, delta: string) => [
	{
		type: "TEXT_MESSAGE_START",
		messageId: `${key}:assistant`,
		role: "assistant",
	},
	{ type: "TEXT_MESSAGE_CONTENT", messageId: `${key}:assistant`, delta },
];
const finished = (
	threadId: string,
	runId: string,
	result: Record<string, unknown> = {},
	outcome: Record<string, unknown> = { type: "success" },
) => ({ type: "RUN_FINISHED", threadId, runId, result, outcome });

function renderRuntime(options: UseDirectRuntimeStreamOptions = {}) {
	return renderHook(
		(props: UseDirectRuntimeStreamOptions) => useDirectRuntimeStream(props),
		{ initialProps: { organizationId: "org_example", ...options } },
	);
}

function lastAssistant(result: ReturnType<typeof renderRuntime>["result"]) {
	return result.current.messages.filter((m) => m.role === "assistant").at(-1);
}

describe("useDirectRuntimeStream — a turn", () => {
	it("streams text, reasoning, tools, sources, progress and usage into the chat's fields", async () => {
		respond = ({ body }) =>
			sse([
				started(body.threadId, body.runId),
				...execution("direct-chat-1"),
				{
					type: "STATE_DELTA",
					delta: [
						{
							op: "add",
							path: "/progress",
							value: {
								phase: "retrieving_rag",
								message: "Searching documents",
								progress: 30,
							},
						},
					],
				},
				{
					type: "REASONING_START",
					messageId: `${body.runId}:reasoning`,
				},
				{
					type: "REASONING_MESSAGE_START",
					messageId: `${body.runId}:reasoning`,
					role: "reasoning",
				},
				{
					type: "REASONING_MESSAGE_CONTENT",
					messageId: `${body.runId}:reasoning`,
					delta: "thinking",
				},
				{
					type: "REASONING_MESSAGE_END",
					messageId: `${body.runId}:reasoning`,
				},
				{ type: "REASONING_END", messageId: `${body.runId}:reasoning` },
				...text(body.runId, "Before the tool."),
				{
					type: "TOOL_CALL_START",
					toolCallId: "tc-1",
					toolCallName: "search_docs",
					parentMessageId: `${body.runId}:assistant`,
					metadata: { fabric: { serverName: "example-server" } },
				},
				{
					type: "TOOL_CALL_ARGS",
					toolCallId: "tc-1",
					delta: '{"query":"q"}',
				},
				{ type: "TOOL_CALL_END", toolCallId: "tc-1" },
				{
					type: "TOOL_CALL_RESULT",
					messageId: "tc-1:result",
					toolCallId: "tc-1",
					role: "tool",
					content: JSON.stringify({ hits: 2 }),
					metadata: { fabric: { status: "complete" } },
				},
				{
					type: "TEXT_MESSAGE_CONTENT",
					messageId: `${body.runId}:assistant`,
					delta: "After the tool.",
				},
				{
					type: "CUSTOM",
					name: "fabric.reasoning-duration",
					value: {
						messageId: `${body.runId}:reasoning`,
						durationMs: 1200,
					},
				},
				{
					type: "CUSTOM",
					name: "fabric.sources",
					value: {
						messageId: `${body.runId}:assistant`,
						sources: [
							{
								id: "doc-1",
								title: "Example doc",
								type: "document",
							},
						],
					},
				},
				{
					type: "TEXT_MESSAGE_END",
					messageId: `${body.runId}:assistant`,
				},
				finished(body.threadId, body.runId, {
					durationMs: 900,
					usage: {
						inputTokens: 100,
						outputTokens: 20,
						totalTokens: 120,
					},
					model: {
						id: "example-model",
						canonicalName: "Example Model",
						provider: "example",
						contextWindow: 64000,
					},
				}),
			]);
		const { result } = renderRuntime();

		await act(async () => {
			await result.current.sendMessage("hello");
		});

		const answer = lastAssistant(result);
		expect(answer?.content).toBe("Before the tool.\n\nAfter the tool.");
		expect(answer?.reasoningText).toBe("thinking");
		expect(answer?.reasoningDurationMs).toBe(1200);
		expect(answer?.statusLabel).toBe("Searching documents");
		expect(answer?.executionId).toBe("direct-chat-1");
		expect(answer?.toolCalls).toEqual([
			expect.objectContaining({
				id: "tc-1",
				name: "search_docs",
				args: { query: "q" },
				result: { hits: 2 },
				serverName: "example-server",
				status: "complete",
			}),
		]);
		expect(answer?.sources?.[0]?.title).toBe("Example doc");
		expect(answer?.usage?.totalTokens).toBe(120);
		expect(answer?.model?.id).toBe("example-model");
		expect(answer?.streamStatus).toBe("completed");
		expect(answer?.isStreaming).toBe(false);
		expect(result.current.state.status).toBe("completed");
		expect(result.current.isLoading).toBe(false);
		expect(result.current.contextInfo.usage?.inputTokens).toBe(100);
		expect(result.current.contextInfo.maxTokens).toBe(64000);
		expect(result.current.contextInfo.modelLabel).toBe("Example Model");
	});

	it("sends the Direct route's request fields to the run, in the chat's organization", async () => {
		respond = ({ body }) =>
			sse([
				started(body.threadId, body.runId),
				finished(body.threadId, body.runId),
			]);
		const { result } = renderRuntime({
			reasoningMode: "deep",
			modelOverride: "example-model",
			enabledMcpConfigIds: ["mcp-1"],
			enabledFabricToolIds: ["tool-1"],
			workspaceIds: ["ws-1"],
			workspaceDocumentIds: ["wd-1"],
			projectId: "proj-1",
			repositoryUrl: "https://example.com/repo.git",
			storyId: "story-1",
			documentId: "doc-1",
			taskId: "task-1",
			launchWorkspaceId: "workspace-1",
			launchFrameId: "frame-1",
			launchSurface: "workspace",
			systemPrompt: "Be brief.",
		});

		await act(async () => {
			await result.current.sendMessage(
				"third",
				[
					{ role: "user", content: "first" },
					{ role: "assistant", content: "second" },
				],
				{
					attachedDocumentIds: ["att-1"],
					messageChatId: "chat-1",
					inlineAttachmentContexts: ["<file/>"],
				},
			);
		});

		const run = requests.find((r) => r.url === RUN_URL);
		expect(run?.headers["x-fabric-organization-id"]).toBe("org_example");
		expect(run?.body.messages.map((m) => [m.role, m.content])).toEqual([
			["user", "first"],
			["assistant", "second"],
			["user", "third"],
		]);
		expect(run?.body.forwardedProps).toEqual({
			reasoningMode: "deep",
			modelOverride: "example-model",
			enabledMcpConfigIds: ["mcp-1"],
			enabledFabricToolIds: ["tool-1"],
			chatId: "chat-1",
			attachedDocumentIds: ["att-1"],
			inlineAttachmentContexts: ["<file/>"],
			workspaceIds: ["ws-1"],
			workspaceDocumentIds: ["wd-1"],
			projectId: "proj-1",
			repositoryUrl: "https://example.com/repo.git",
			storyId: "story-1",
			documentId: "doc-1",
			taskId: "task-1",
			workspaceId: "workspace-1",
			launchFrameId: "frame-1",
			surface: "workspace",
			systemPrompt: "Be brief.",
		});
		expect(run?.body.forwardedProps).not.toHaveProperty("approvedToolCall");
	});

	it("reports the new conversation under its thread id once the first run started, then keeps the thread", async () => {
		respond = ({ body }) =>
			sse([
				started(body.threadId, body.runId),
				finished(body.threadId, body.runId),
			]);
		const onConversationStarted = vi.fn();
		const { result } = renderRuntime({ onConversationStarted });

		await act(async () => {
			await result.current.sendMessage("first", [], {
				forceNewChat: true,
			});
		});
		await act(async () => {
			await result.current.sendMessage("second", [
				{ role: "user", content: "first" },
			]);
		});

		const runs = requests.filter((r) => r.url === RUN_URL);
		expect(runs).toHaveLength(2);
		expect(runs[0].body.threadId).toMatch(/^[0-9a-f-]{36}$/);
		expect(runs[1].body.threadId).toBe(runs[0].body.threadId);
		expect(onConversationStarted).toHaveBeenCalledTimes(1);
		expect(onConversationStarted).toHaveBeenCalledWith(
			runs[0].body.threadId,
		);
	});

	it("runs on the conversation it was opened on without reporting a new one", async () => {
		respond = ({ url, body }) =>
			url === CONNECT_URL
				? sse([{ type: "MESSAGES_SNAPSHOT", messages: [] }])
				: sse([
						started(body.threadId, body.runId),
						finished(body.threadId, body.runId),
					]);
		const onConversationStarted = vi.fn();
		const { result } = renderRuntime({
			conversationId: "conv_example_1",
			onConversationStarted,
		});

		await act(async () => {
			await result.current.sendMessage("hello", [], {
				forceNewChat: true,
			});
		});

		expect(requests.find((r) => r.url === RUN_URL)?.body.threadId).toBe(
			"conv_example_1",
		);
		expect(onConversationStarted).not.toHaveBeenCalled();
	});
});

describe("useDirectRuntimeStream — failures", () => {
	it("shows a failed run's error under the answer", async () => {
		respond = ({ body }) =>
			sse([
				started(body.threadId, body.runId),
				...text(body.runId, "partial"),
				{
					type: "RUN_ERROR",
					message: "The model failed.",
					code: "MODEL_FAILED",
					metadata: {
						fabric: {
							limit: {
								kind: "provider_rate_limit",
								message: "Slow down",
							},
						},
					},
				},
			]);
		const { result } = renderRuntime();

		await act(async () => {
			await result.current.sendMessage("hello");
		});

		const answer = lastAssistant(result);
		expect(answer?.content).toBe("partial");
		expect(answer?.errorMessage).toBe("The model failed.");
		expect(answer?.isError).toBe(true);
		expect(answer?.limit?.kind).toBe("provider_rate_limit");
		expect(answer?.streamStatus).toBe("error");
		expect(result.current.state).toEqual({
			status: "error",
			error: "The model failed.",
		});
	});

	it("still shows the error when it names a limit the chat does not know", async () => {
		respond = ({ body }) =>
			sse([
				started(body.threadId, body.runId),
				{
					type: "RUN_ERROR",
					message: "Something new failed.",
					metadata: { fabric: { limit: { kind: "future_kind" } } },
				},
			]);
		const { result } = renderRuntime();

		await act(async () => {
			await result.current.sendMessage("hello");
		});

		expect(lastAssistant(result)?.errorMessage).toBe(
			"Something new failed.",
		);
		expect(lastAssistant(result)?.limit).toBeUndefined();
	});

	it("keeps a partial answer and its error when the turn stopped on a limit", async () => {
		respond = ({ body }) =>
			sse([
				started(body.threadId, body.runId),
				...text(body.runId, "half an answer"),
				{
					type: "CUSTOM",
					name: "fabric.partial-error",
					value: {
						messageId: `${body.runId}:assistant`,
						message: "Stopped at the output limit.",
					},
				},
				finished(body.threadId, body.runId, {
					truncated: "output_limit",
				}),
			]);
		const { result } = renderRuntime();

		await act(async () => {
			await result.current.sendMessage("hello");
		});

		const answer = lastAssistant(result);
		expect(answer?.content).toBe("half an answer");
		expect(answer?.errorMessage).toBe("Stopped at the output limit.");
		expect(answer?.truncated).toBe("output_limit");
		expect(answer?.streamStatus).toBe("error");
	});

	it("drops the placeholder and raises the usage-limit toast when admission refuses on the limit", async () => {
		const data = {
			limitId: "limit-1",
			dimension: "TOKENS",
			window: "MONTHLY",
			used: "100",
			max: "100",
			manageLimitsUrl: "/app/example-org/settings/ai-usage",
		};
		respond = () =>
			sse([
				{
					type: "RUN_ERROR",
					message: "Limit reached",
					code: "AI_USAGE_LIMIT_EXCEEDED",
					metadata: { fabric: { status: 429, data } },
				},
			]);
		const { result } = renderRuntime();

		await act(async () => {
			await result.current.sendMessage("hello");
		});

		expect(toastMock).toHaveBeenCalledWith(data);
		expect(result.current.messages.map((m) => m.role)).toEqual(["user"]);
		expect(result.current.state.status).toBe("idle");
		expect(result.current.isLoading).toBe(false);
	});

	it("carries the API-billing notice the runtime sends", async () => {
		respond = ({ body }) =>
			sse([
				started(body.threadId, body.runId),
				{
					type: "CUSTOM",
					name: "fabric.billing",
					value: { resetAt: "2026-11-01T00:00:00.000Z" },
				},
				finished(body.threadId, body.runId),
			]);
		const { result } = renderRuntime();

		await act(async () => {
			await result.current.sendMessage("hello");
		});

		expect(lastAssistant(result)?.apiBilling).toEqual({
			resetAt: "2026-11-01T00:00:00.000Z",
		});
	});

	it("shows the route's message when the runtime refuses the request", async () => {
		respond = () =>
			new Response(
				JSON.stringify({
					error: "Forbidden",
					message: "This thread is not accessible.",
				}),
				{
					status: 403,
					headers: { "Content-Type": "application/json" },
				},
			);
		const { result } = renderRuntime();

		await act(async () => {
			await result.current.sendMessage("hello");
		});

		expect(lastAssistant(result)?.errorMessage).toBe(
			"This thread is not accessible.",
		);
		expect(result.current.state.status).toBe("error");
	});
});

describe("useDirectRuntimeStream — stop", () => {
	it("flips the answer to cancelled at once, stops the thread's run and drops later deltas", async () => {
		const live = liveSse();
		respond = ({ url }) =>
			url === RUN_URL
				? live.response
				: new Response(JSON.stringify({ stopped: true }), {
						status: 200,
					});
		const onStopFailed = vi.fn();
		const { result } = renderRuntime({ onStopFailed });

		let sending: Promise<unknown> | undefined;
		act(() => {
			sending = result.current.sendMessage("hello");
		});
		await waitFor(() => expect(requests[0]?.url).toBe(RUN_URL));
		const { threadId, runId } = requests[0].body;
		await act(async () => {
			live.push(
				started(threadId, runId),
				...execution("direct-chat-2"),
				...text(runId, "part 1 "),
			);
		});
		await waitFor(() =>
			expect(lastAssistant(result)?.content).toBe("part 1 "),
		);

		act(() => {
			result.current.stop("button");
		});

		expect(lastAssistant(result)?.streamStatus).toBe("cancelled");
		expect(result.current.isLoading).toBe(false);
		expect(result.current.state.status).toBe("cancelled");
		const stop = requests.find((r) => r.url.includes("/stop/"));
		expect(stop?.url).toBe(
			`/api/agents/runtime/agent/fabric-direct/stop/${threadId}`,
		);
		expect(stop?.body).toEqual({ runId });
		expect(vi.mocked(emitCancelEvent)).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "direct-chat-2",
				triggered_by: "button",
			}),
		);

		await act(async () => {
			live.push(
				{
					type: "TEXT_MESSAGE_CONTENT",
					messageId: `${runId}:assistant`,
					delta: "part 2",
				},
				finished(threadId, runId, {}, { type: "cancelled" }),
			);
			live.close();
			await sending;
		});

		expect(lastAssistant(result)?.content).toBe("part 1 ");
		expect(lastAssistant(result)?.streamStatus).toBe("cancelled");
		expect(onStopFailed).not.toHaveBeenCalled();
		// The response ended on the cancellation: no reconnect followed.
		expect(requests.filter((r) => r.url === CONNECT_URL)).toHaveLength(0);
	});

	it("reports a failed stop without reverting the cancelled view", async () => {
		const live = liveSse();
		respond = ({ url }) =>
			url === RUN_URL
				? live.response
				: new Response("{}", { status: 500 });
		const onStopFailed = vi.fn();
		const { result } = renderRuntime({ onStopFailed });

		let sending: Promise<unknown> | undefined;
		act(() => {
			sending = result.current.sendMessage("hello");
		});
		await waitFor(() => expect(requests[0]?.url).toBe(RUN_URL));
		const { threadId, runId } = requests[0].body;
		await act(async () => {
			live.push(started(threadId, runId));
		});

		act(() => {
			result.current.stop("esc");
		});
		await waitFor(() => expect(onStopFailed).toHaveBeenCalledTimes(1));
		expect(lastAssistant(result)?.streamStatus).toBe("cancelled");

		await act(async () => {
			live.push(finished(threadId, runId, {}, { type: "cancelled" }));
			live.close();
			await sending;
		});
	});
});

describe("useDirectRuntimeStream — approval", () => {
	it("answers the run's interrupt with a resume rather than sending the call back", async () => {
		const confirmation = {
			requiresConfirmation: true,
			toolName: "fabric_create_task",
			args: { title: "Example task" },
			message: "Create this task?",
		};
		respond = ({ body }) =>
			body.resume
				? sse([
						started(body.threadId, body.runId, "Approved"),
						...text(
							`${String(body.resume[0].interruptId)}:resume`,
							"Created.",
						),
						finished(body.threadId, body.runId),
					])
				: sse([
						started(body.threadId, body.runId),
						{
							type: "TOOL_CALL_START",
							toolCallId: "tc-approve",
							toolCallName: "fabric_create_task",
						},
						{
							type: "TOOL_CALL_ARGS",
							toolCallId: "tc-approve",
							delta: "{}",
						},
						{ type: "TOOL_CALL_END", toolCallId: "tc-approve" },
						{
							type: "TOOL_CALL_RESULT",
							messageId: "tc-approve:result",
							toolCallId: "tc-approve",
							role: "tool",
							content: JSON.stringify(confirmation),
							metadata: { fabric: { status: "complete" } },
						},
						finished(
							body.threadId,
							body.runId,
							{},
							{
								type: "interrupt",
								interrupts: [
									{
										id: `${body.runId}:approval`,
										reason: "tool_approval",
										message: "Create this task?",
										toolCallId: "tc-approve",
										metadata: {
											toolName: "fabric_create_task",
											args: { title: "Example task" },
										},
									},
								],
							},
						),
					]);
		const { result } = renderRuntime();

		await act(async () => {
			await result.current.sendMessage("make a task");
		});
		const asked = lastAssistant(result);
		expect(asked?.pendingConfirmation).toEqual(
			expect.objectContaining({ toolName: "fabric_create_task" }),
		);
		expect(asked?.toolCalls?.[0]?.result).toEqual(confirmation);

		await act(async () => {
			await result.current.sendMessage(
				"Approved: create the task.",
				[{ role: "user", content: "make a task" }],
				{
					approvedToolCall: {
						toolName: "fabric_create_task",
						args: { title: "something else" },
					},
				},
			);
		});

		const [first, resume] = requests.filter((r) => r.url === RUN_URL);
		expect(resume.body.threadId).toBe(first.body.threadId);
		expect(resume.body.resume).toEqual([
			{
				interruptId: `${first.body.runId}:approval`,
				status: "resolved",
				payload: { approved: true },
			},
		]);
		// No new message: the runtime runs the call it recorded.
		expect(resume.body.messages.map((m) => m.content)).toEqual([
			"make a task",
		]);
		expect(JSON.stringify(resume.body)).not.toContain("something else");
		expect(lastAssistant(result)?.content).toBe("Created.");
	});
});

describe("useDirectRuntimeStream — reconnect and reattach", () => {
	it("reconnects when the response window ends and follows the same turn without repeating it", async () => {
		respond = ({ url, body }) => {
			const run = requests.find((r) => r.url === RUN_URL)?.body;
			if (url === RUN_URL) {
				return sse([
					started(body.threadId, body.runId),
					...text(body.runId, "Hello"),
					{
						type: "CUSTOM",
						name: "fabric.reconnect",
						value: {
							executionId: "direct-chat-3",
							runId: body.runId,
						},
					},
				]);
			}
			const key = run?.runId ?? "";
			return sse([
				{ type: "MESSAGES_SNAPSHOT", messages: [] },
				started(body.threadId, key),
				...text(key, "Hello, world"),
				{ type: "TEXT_MESSAGE_END", messageId: `${key}:assistant` },
				finished(body.threadId, key),
			]);
		};
		const { result } = renderRuntime();

		await act(async () => {
			await result.current.sendMessage("hello");
		});

		expect(requests.map((r) => r.url)).toEqual([RUN_URL, CONNECT_URL]);
		expect(lastAssistant(result)?.content).toBe("Hello, world");
		expect(lastAssistant(result)?.streamStatus).toBe("completed");
	});

	it("takes the saved answer from the snapshot when the turn finished between responses", async () => {
		respond = ({ url, body }) => {
			const run = requests.find((r) => r.url === RUN_URL)?.body;
			if (url === RUN_URL) {
				return sse([
					started(body.threadId, body.runId),
					...text(body.runId, "Hel"),
					{ type: "CUSTOM", name: "fabric.reconnect", value: {} },
				]);
			}
			const key = run?.runId ?? "";
			return sse([
				{
					type: "MESSAGES_SNAPSHOT",
					messages: [
						{ id: `${key}:user`, role: "user", content: "hello" },
						{
							id: `${key}:assistant`,
							role: "assistant",
							content: "Hello, all of it",
							metadata: {
								fabric: {
									timestamp: "2026-10-30T10:00:00.000Z",
									streamStatus: "completed",
									metadata: {
										usage: {
											inputTokens: 5,
											outputTokens: 4,
											totalTokens: 9,
										},
									},
								},
							},
						},
					],
				},
			]);
		};
		const { result } = renderRuntime();

		await act(async () => {
			await result.current.sendMessage("hello");
		});

		const answer = lastAssistant(result);
		expect(answer?.content).toBe("Hello, all of it");
		expect(answer?.usage?.totalTokens).toBe(9);
		expect(answer?.streamStatus).toBe("completed");
		expect(result.current.isLoading).toBe(false);
	});

	it("reattaches to a running turn when opened on its conversation, without the workflow's SYSTEM rows", async () => {
		const live = liveSse();
		respond = () => live.response;
		const { result } = renderRuntime({ conversationId: "conv_live_1" });

		await waitFor(() => expect(requests[0]?.url).toBe(CONNECT_URL));
		expect(requests[0].body.threadId).toBe("conv_live_1");
		const op = (id: string) => ({
			id,
			role: "system",
			content: "SYSTEM\n\nsummary",
			metadata: {
				fabric: {
					timestamp: "2026-10-30T09:00:00.000Z",
					metadata: { kind: "operation_result", outcome: "success" },
				},
			},
		});
		await act(async () => {
			live.push(
				{
					type: "MESSAGES_SNAPSHOT",
					messages: [
						{
							id: "run-a:user",
							role: "user",
							content: "earlier question",
						},
						{
							id: "run-a:assistant",
							role: "assistant",
							content: "earlier answer",
						},
						// The workflow appends its row while the turn runs,
						// after the question the runtime saved on admission.
						op("op-1"),
					],
				},
				started("conv_live_1", "run-b", "live question"),
				...execution("direct-chat-4"),
				...text("run-b", "streaming"),
			);
		});

		await waitFor(() =>
			expect(result.current.messages.map((m) => m.content)).toEqual([
				"earlier question",
				"earlier answer",
				"live question",
				"streaming",
			]),
		);
		expect(result.current.isLoading).toBe(true);
		expect(lastAssistant(result)?.executionId).toBe("direct-chat-4");

		await act(async () => {
			live.push(
				{
					type: "TEXT_MESSAGE_CONTENT",
					messageId: "run-b:assistant",
					delta: " done",
				},
				finished("conv_live_1", "run-b"),
			);
			live.close();
		});

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(lastAssistant(result)?.content).toBe("streaming done");
		expect(lastAssistant(result)?.streamStatus).toBe("completed");
	});

	it("leaves the chat's loaded conversation alone when the thread has no running turn", async () => {
		respond = () =>
			sse([
				{
					type: "MESSAGES_SNAPSHOT",
					messages: [
						{
							id: "run-a:user",
							role: "user",
							content: "earlier question",
						},
						{
							id: "run-a:assistant",
							role: "assistant",
							content: "Create this task?",
						},
					],
				},
				// A finished turn's unanswered approval, raised again.
				started("conv_idle_1", "run-a"),
				finished(
					"conv_idle_1",
					"run-a",
					{},
					{
						type: "interrupt",
						interrupts: [
							{ id: "run-a:approval", reason: "tool_approval" },
						],
					},
				),
			]);
		const { result } = renderRuntime({ conversationId: "conv_idle_1" });

		await waitFor(() => expect(requests).toHaveLength(1));
		await act(async () => {});

		expect(result.current.messages).toEqual([]);
		expect(result.current.isLoading).toBe(false);
		expect(result.current.state.status).toBe("idle");
	});

	describe("a conversation reopened after its turn ended unwatched", () => {
		const ASKED_AT = "2026-10-30T09:00:00.000Z";
		const question = {
			id: "run-a:user",
			role: "user",
			content: "earlier question",
			metadata: { fabric: { timestamp: ASKED_AT } },
		};
		const answer = {
			id: "run-a:assistant",
			role: "assistant",
			content: "the answer",
			metadata: {
				fabric: {
					timestamp: "2026-10-30T09:00:04.000Z",
					streamStatus: "completed",
					metadata: {
						usage: {
							inputTokens: 30,
							outputTokens: 12,
							totalTokens: 42,
						},
						model: { id: "example-model", contextWindow: 100_000 },
					},
				},
			},
		};
		const shownQuestion = {
			id: "run-a:user",
			role: "user" as const,
			content: "earlier question",
			timestamp: new Date(ASKED_AT),
		};

		it("shows the answer the connect saved, which the loaded conversation lacks", async () => {
			// The tab closed mid-turn; the chat loaded the question only, and
			// this connect saved the finished answer before its snapshot.
			respond = () =>
				sse([
					{ type: "MESSAGES_SNAPSHOT", messages: [question, answer] },
				]);
			const { result } = renderRuntime({
				conversationId: "conv_reopen_1",
				shownMessages: [shownQuestion],
			});

			await waitFor(() =>
				expect(
					result.current.messages.map((m) => [m.id, m.content]),
				).toEqual([
					["run-a:user", "earlier question"],
					["run-a:assistant", "the answer"],
				]),
			);
			expect(lastAssistant(result)?.streamStatus).toBe("completed");
			expect(result.current.isLoading).toBe(false);
			expect(result.current.state.status).toBe("idle");
			// The context meter reads the adopted answer, as a reopened one does.
			expect(result.current.contextInfo.usage?.totalTokens).toBe(42);
			expect(result.current.contextInfo.maxTokens).toBe(100_000);
		});

		it("changes nothing when the snapshot holds only what the chat shows", async () => {
			respond = () =>
				sse([
					{ type: "MESSAGES_SNAPSHOT", messages: [question, answer] },
				]);
			const { result } = renderRuntime({
				conversationId: "conv_reopen_2",
				shownMessages: [
					shownQuestion,
					{
						id: "run-a:assistant",
						role: "assistant",
						content: "the answer",
						timestamp: new Date("2026-10-30T09:00:04.000Z"),
					},
				],
			});
			const contextBefore = result.current.contextInfo;

			await waitFor(() => expect(requests).toHaveLength(1));
			await act(async () => {});

			expect(result.current.messages).toEqual([]);
			expect(result.current.contextInfo).toEqual(contextBefore);
			expect(result.current.isLoading).toBe(false);
			expect(result.current.state.status).toBe("idle");
		});
	});

	it("shows the running turn's question once when the runtime saved it on admission", async () => {
		const live = liveSse();
		respond = () => live.response;
		const { result } = renderRuntime({ conversationId: "conv_live_2" });

		await waitFor(() => expect(requests[0]?.url).toBe(CONNECT_URL));
		await act(async () => {
			live.push(
				{
					type: "MESSAGES_SNAPSHOT",
					messages: [
						{
							id: "run-c:user",
							role: "user",
							content: "live question",
							metadata: {
								fabric: {
									timestamp: "2026-10-30T09:00:00.000Z",
								},
							},
						},
					],
				},
				started("conv_live_2", "run-c", "live question"),
				...text("run-c", "streaming"),
			);
		});

		await waitFor(() =>
			expect(
				result.current.messages.map((m) => [m.id, m.content]),
			).toEqual([
				["run-c:user", "live question"],
				["run-c:assistant", "streaming"],
			]),
		);
		expect(result.current.messages[0]?.timestamp.toISOString()).toBe(
			"2026-10-30T09:00:00.000Z",
		);

		await act(async () => {
			live.push(finished("conv_live_2", "run-c"));
			live.close();
		});
		await waitFor(() => expect(result.current.isLoading).toBe(false));
	});
});

describe("useDirectRuntimeStream — letting go of a turn", () => {
	async function streamingTurn() {
		const live = liveSse();
		respond = ({ url, signal }) => {
			if (url !== RUN_URL) {
				return new Response(JSON.stringify({ stopped: true }), {
					status: 200,
				});
			}
			live.abortOn(signal);
			return live.response;
		};
		const rendered = renderRuntime();
		let sending: Promise<unknown> | undefined;
		act(() => {
			sending = rendered.result.current.sendMessage("hello");
		});
		await waitFor(() => expect(requests[0]?.url).toBe(RUN_URL));
		const { threadId, runId } = requests[0].body;
		await act(async () => {
			live.push(started(threadId, runId), ...text(runId, "part 1 "));
		});
		await waitFor(() =>
			expect(lastAssistant(rendered.result)?.content).toBe("part 1 "),
		);
		return { ...rendered, live, threadId, runId, sending: () => sending };
	}

	it("lets a stopped turn's response run to its end after a reset, so the runtime saves what it streamed", async () => {
		const { result, live, threadId, runId, sending } =
			await streamingTurn();

		act(() => {
			result.current.stop("button");
		});
		// The chat switches conversation.
		act(() => {
			result.current.reset();
		});

		expect(requests[0].signal?.aborted).toBe(false);
		await act(async () => {
			live.push(
				{
					type: "TEXT_MESSAGE_CONTENT",
					messageId: `${runId}:assistant`,
					delta: "part 2",
				},
				finished(threadId, runId, {}, { type: "cancelled" }),
			);
			live.close();
			await sending();
		});

		// Nothing of the released turn reaches the chat it was reset to.
		expect(result.current.messages).toEqual([]);
		expect(result.current.isLoading).toBe(false);
		expect(result.current.state.status).toBe("idle");
		expect(requests.filter((r) => r.url === CONNECT_URL)).toHaveLength(0);
	});

	it("aborts the response of a turn the chat lets go of without a stop", async () => {
		const { result, sending } = await streamingTurn();

		act(() => {
			result.current.reset();
		});

		expect(requests[0].signal?.aborted).toBe(true);
		await act(async () => {
			await sending();
		});
		expect(result.current.messages).toEqual([]);
		expect(result.current.state.status).toBe("idle");
	});
});

describe("useDirectRuntimeStream — workflow confirmation", () => {
	it("offers the workflow the turn asks to start, and its approve and decline go where the stream route's did", async () => {
		const executeBodies: unknown[] = [];
		respond = ({ url, body }) => {
			if (url === "/api/agents/fabric-ai/execute-workflow") {
				executeBodies.push(body);
				return Response.json({
					success: true,
					executionId: "workflow-run-1",
				});
			}
			return sse([
				started(body.threadId, body.runId),
				...text(body.runId, "I can run the release workflow."),
				{
					type: "CUSTOM",
					name: "fabric.workflow-confirmation",
					value: {
						messageId: `${body.runId}:assistant`,
						workflowId: "workflow-example-1",
						workflowName: "Release",
						description: "Builds and tags a release",
						message: "Run the release workflow?",
					},
				},
				finished(body.threadId, body.runId),
			]);
		};
		const { result } = renderHook(() => {
			const stream = useDirectRuntimeStream({
				organizationId: "org_example",
			});
			const workflow = useWorkflowConfirmation({
				messages: stream.messages,
				organizationId: "org_example",
				isLoading: stream.isLoading,
			});
			return { stream, workflow };
		});

		await act(async () => {
			await result.current.stream.sendMessage("Release it");
		});

		expect(result.current.workflow.confirmation).toMatchObject({
			workflowId: "workflow-example-1",
			workflowName: "Release",
			description: "Builds and tags a release",
			message: "Run the release workflow?",
			status: "requested",
		});
		await act(async () => {
			await result.current.workflow.confirm();
		});
		expect(executeBodies).toEqual([
			{ workflowId: "workflow-example-1", organizationId: "org_example" },
		]);
		expect(result.current.workflow.confirmation).toMatchObject({
			status: "started",
			executionId: "workflow-run-1",
		});

		// The next turn asks again; this time it is declined, and nothing starts.
		await act(async () => {
			await result.current.stream.sendMessage("Release it again");
		});
		act(() => {
			result.current.workflow.decline();
		});
		expect(result.current.workflow.confirmation?.status).toBe("declined");
		expect(executeBodies).toHaveLength(1);
	});
});
