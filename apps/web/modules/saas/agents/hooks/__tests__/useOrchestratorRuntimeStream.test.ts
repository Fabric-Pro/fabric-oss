/**
 * The Orchestrator chat over the agent runtime: the AG-UI events the
 * runtime's Orchestrator engine sends (`runtime/orchestrator-translator.ts`,
 * `orchestrator-turn-follow.ts`) must land in the same turn state the stream
 * route's chat fills, and the runtime-only behaviour (thread = conversation,
 * reconnect after the window, answers by resume, follow-ups as runs, stop,
 * attach) must hold.
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
vi.mock("../useOrchestratorPartyKit", () => ({
	useOrchestratorPartyKit: () => ({
		isConnected: false,
		toolCalls: [],
		stepProgress: undefined,
		currentPhase: "idle",
		reset: vi.fn(),
		notifyStepStart: vi.fn(),
	}),
}));
vi.mock("@saas/payments/lib/ai-usage-limit-toast", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/payments/lib/ai-usage-limit-toast")
	>()),
	useShowAiUsageLimitToast: () => toastMock,
}));

import type { UseOrchestratorStreamOptions } from "../../lib/orchestrator-stream-types";
import { useOrchestratorRuntimeStream } from "../useOrchestratorRuntimeStream";

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
function liveSse(signal?: AbortSignal | null) {
	const encoder = new TextEncoder();
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let open = true;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	signal?.addEventListener("abort", () => {
		if (open) {
			open = false;
			controller?.error(
				new DOMException("The operation was aborted.", "AbortError"),
			);
		}
	});
	return {
		response: new Response(stream, {
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
		}),
		push: (...events: RuntimeEvent[]) => {
			for (const event of events) {
				if (open) {
					controller?.enqueue(
						encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
					);
				}
			}
		},
		close: () => {
			if (open) {
				open = false;
				controller?.close();
			}
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

const RUN_URL = "/api/agents/runtime/agent/fabric-orchestrator/run";
const CONNECT_URL = "/api/agents/runtime/agent/fabric-orchestrator/connect";
const EXECUTION = "orch-00000000-0000-4000-8000-000000000001";

const opened = (threadId: string, runId: string, resumed = false) => [
	{
		type: "RUN_STARTED",
		threadId,
		runId,
		input: {
			threadId,
			runId,
			messages: [{ id: `${runId}:user`, role: "user", content: "hello" }],
			tools: [],
			context: [],
		},
	},
	{ type: "STATE_SNAPSHOT", snapshot: { executionId: EXECUTION } },
	{
		type: "CUSTOM",
		name: "fabric.execution",
		value: { executionId: EXECUTION, turnId: "turn-1", resumed },
	},
];
const text = (id: string, delta: string) => [
	{ type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" },
	{ type: "TEXT_MESSAGE_CONTENT", messageId: id, delta },
];
const finished = (threadId: string, runId: string, response: string) => ({
	type: "RUN_FINISHED",
	threadId,
	runId,
	result: { status: "completed", response, toolCalls: [], stepResults: [] },
	outcome: { type: "success" },
});
const interrupt = (
	threadId: string,
	runId: string,
	event: Record<string, unknown>,
) => ({
	type: "RUN_FINISHED",
	threadId,
	runId,
	outcome: {
		type: "interrupt",
		interrupts: [
			{
				id: "interrupt",
				reason: "orchestrator_approval",
				metadata: { fabric: event },
			},
		],
	},
});

function render(options: UseOrchestratorStreamOptions = {}) {
	return renderHook(() =>
		useOrchestratorRuntimeStream({ organizationId: "org-1", ...options }),
	);
}

function lastAssistant(
	result: ReturnType<typeof render>["result"],
): { content: string; streamStatus?: string } | undefined {
	return [...result.current.messages]
		.reverse()
		.find((message) => message.role === "assistant");
}

describe("a new chat's turn", () => {
	it("runs on a new thread, reports its conversation, and ends with the run's answer", async () => {
		respond = (request) =>
			sse([
				...opened(request.body.threadId, request.body.runId),
				...text("a", "Partial"),
				finished(
					request.body.threadId,
					request.body.runId,
					"Final answer",
				),
			]);
		const onConversationStarted = vi.fn();
		const { result } = render({
			onConversationStarted,
			executionMode: "deep",
			conversationSettings: { executionMode: "deep" },
		});

		await act(async () => {
			await result.current.sendMessage("Plan the release", [
				{ role: "user", content: "Earlier" },
				{ role: "assistant", content: "Earlier answer" },
			]);
		});

		const run = requests[0];
		expect(run?.url).toBe(RUN_URL);
		expect(run?.headers["x-fabric-organization-id"]).toBe("org-1");
		expect(run?.body.messages.map((m) => [m.role, m.content])).toEqual([
			["user", "Earlier"],
			["assistant", "Earlier answer"],
			["user", "Plan the release"],
		]);
		expect(run?.body.messages.at(-1)?.id).toBe(`${run?.body.runId}:user`);
		expect(run?.body.forwardedProps).toEqual(
			expect.objectContaining({
				executionMode: "deep",
				surface: "loom-orchestrator",
				conversationSettings: { executionMode: "deep" },
			}),
		);
		expect(onConversationStarted).toHaveBeenCalledTimes(1);
		expect(onConversationStarted).toHaveBeenCalledWith(run?.body.threadId);
		expect(result.current.state.status).toBe("completed");
		expect(result.current.state.executionId).toBe(EXECUTION);
		expect(lastAssistant(result)?.content).toBe("Final answer");
		expect(requests).toHaveLength(1);
	});

	it("runs a known conversation's turn on its thread and creates nothing", async () => {
		respond = (request) =>
			sse([
				...opened(request.body.threadId, request.body.runId),
				finished(request.body.threadId, request.body.runId, "Done"),
			]);
		const onConversationStarted = vi.fn();
		const { result } = render({
			conversationId: "conversation-1",
			onConversationStarted,
		});

		await act(async () => {
			await result.current.sendMessage("Next");
		});

		expect(requests[0]?.body.threadId).toBe("conversation-1");
		expect(onConversationStarted).not.toHaveBeenCalled();
	});
});

describe("a long turn", () => {
	it("connects again when the window ends, and the next window's text replaces the cut-off text", async () => {
		respond = (request) => {
			if (request.url === RUN_URL) {
				return sse([
					...opened(request.body.threadId, request.body.runId),
					...text("a", "Cut off mid"),
					{
						type: "CUSTOM",
						name: "fabric.reconnect",
						value: { executionId: EXECUTION },
					},
				]);
			}
			return sse([
				{ type: "MESSAGES_SNAPSHOT", messages: [] },
				...opened(request.body.threadId, "turn-key", true),
				...text("b", "Whole answer"),
				finished(request.body.threadId, "turn-key", "Whole answer"),
			]);
		};
		const { result } = render({ conversationId: "conversation-1" });

		await act(async () => {
			await result.current.sendMessage("Long one");
		});

		expect(requests.map((r) => r.url)).toEqual([RUN_URL, CONNECT_URL]);
		expect(requests[1]?.body.threadId).toBe("conversation-1");
		expect(lastAssistant(result)?.content).toBe("Whole answer");
		expect(result.current.state.status).toBe("completed");
	});

	it("connects again after a response that dropped without saying why", async () => {
		let connects = 0;
		respond = (request) => {
			if (request.url === RUN_URL) {
				return sse([
					...opened(request.body.threadId, request.body.runId),
					...text("a", "Some"),
				]);
			}
			connects += 1;
			return sse([
				...opened(request.body.threadId, "turn-key", true),
				finished(request.body.threadId, "turn-key", "Recovered"),
			]);
		};
		const { result } = render({ conversationId: "conversation-1" });

		await act(async () => {
			await result.current.sendMessage("Flaky");
		});

		expect(connects).toBe(1);
		expect(lastAssistant(result)?.content).toBe("Recovered");
	});

	it("settles a turn a connect finds already saved, from the saved answer", async () => {
		respond = (request) => {
			if (request.url === RUN_URL) {
				return sse([
					...opened(request.body.threadId, request.body.runId),
				]);
			}
			const key = requests[0]?.body.runId ?? "";
			return sse([
				{
					type: "MESSAGES_SNAPSHOT",
					messages: [
						{ id: `${key}:user`, role: "user", content: "Q" },
						{
							id: `${key}:assistant`,
							role: "assistant",
							content: "Saved answer",
							metadata: { fabric: { streamStatus: "completed" } },
						},
					],
				},
			]);
		};
		const { result } = render({ conversationId: "conversation-1" });

		await act(async () => {
			await result.current.sendMessage("Q");
		});

		expect(lastAssistant(result)?.content).toBe("Saved answer");
		expect(result.current.state.status).toBe("completed");
	});
});

describe("refusals", () => {
	it("takes the question back when another message is already being answered", async () => {
		respond = () =>
			sse([
				{
					type: "RUN_ERROR",
					message: "Another turn is running",
					code: "TURN_IN_PROGRESS",
					metadata: {
						fabric: { status: 409, code: "TURN_IN_PROGRESS" },
					},
				},
			]);
		const onTurnRefused = vi.fn(() => undefined);
		const { result } = render({
			conversationId: "conversation-1",
			onTurnRefused,
		});

		await act(async () => {
			await result.current.sendMessage("Mine");
		});

		expect(result.current.messages).toEqual([]);
		expect(onTurnRefused).toHaveBeenCalledWith("Mine");
		expect(result.current.state.status).toBe("failed");
	});

	it("shows the usage-limit toast and goes idle", async () => {
		const payload = {
			code: "AI_USAGE_LIMIT_EXCEEDED",
			scope: "user",
			limit: 10,
			used: 10,
			resetAt: "2026-11-01T00:00:00.000Z",
		};
		respond = () =>
			sse([
				{
					type: "RUN_ERROR",
					message: "Limit",
					code: "AI_USAGE_LIMIT_EXCEEDED",
					metadata: {
						fabric: { status: 429, ...payload, data: payload },
					},
				},
			]);
		const { result } = render({ conversationId: "conversation-1" });

		await act(async () => {
			await result.current.sendMessage("Too much");
		});

		expect(result.current.state.status).toBe("idle");
		expect(result.current.isLoading).toBe(false);
	});

	it("waits and sends the same run again while a stopped turn is still ending", async () => {
		let runs = 0;
		respond = (request) => {
			runs += 1;
			return runs === 1
				? sse([
						{
							type: "RUN_ERROR",
							message: "Still ending",
							code: "TURN_STOPPING",
						},
					])
				: sse([
						...opened(request.body.threadId, request.body.runId),
						finished(
							request.body.threadId,
							request.body.runId,
							"Fresh",
						),
					]);
		};
		const { result } = render({ conversationId: "conversation-1" });

		await act(async () => {
			await result.current.sendMessage("After stop");
		});

		expect(requests.map((r) => r.url)).toEqual([RUN_URL, RUN_URL]);
		expect(requests[1]?.body.runId).toBe(requests[0]?.body.runId);
		expect(lastAssistant(result)?.content).toBe("Fresh");
	}, 10_000);
});

describe("answers", () => {
	it("stops on an approval, resumes it with the approval's id, and follows the turn on", async () => {
		respond = (request) => {
			if (request.body.resume) {
				return sse([
					...opened(request.body.threadId, request.body.runId, true),
					{
						type: "CUSTOM",
						name: "fabric.orchestrator.event",
						value: {
							type: "approval_resolved",
							approvalId: "approval-1",
							stepId: "step-1",
							message: "Approval resolved",
						},
					},
					finished(request.body.threadId, request.body.runId, "Done"),
				]);
			}
			return sse([
				...opened(request.body.threadId, request.body.runId),
				interrupt(request.body.threadId, request.body.runId, {
					type: "approval_required",
					approvalId: "approval-1",
					stepId: "step-1",
					reason: "Writes to the tracker",
				}),
			]);
		};
		const { result } = render({ conversationId: "conversation-1" });

		await act(async () => {
			await result.current.sendMessage("Create the tasks");
		});
		expect(result.current.state.status).toBe("awaiting_approval");
		expect(result.current.state.pendingApproval?.approvalId).toBe(
			"approval-1",
		);

		let sent: string | undefined;
		await act(async () => {
			sent = await result.current.sendApproval(true);
		});

		expect(sent).toBe("sent");
		expect(requests[1]?.body.resume).toEqual([
			{
				interruptId: "approval-1",
				status: "resolved",
				payload: { approved: true },
			},
		]);
		await waitFor(() =>
			expect(result.current.state.status).toBe("completed"),
		);
		expect(lastAssistant(result)?.content).toBe("Done");
	});

	it("answers a clarifying question and shows the exchange", async () => {
		respond = (request) => {
			if (request.body.resume) {
				return sse([
					...opened(request.body.threadId, request.body.runId, true),
					{
						type: "CUSTOM",
						name: "fabric.orchestrator.event",
						value: {
							type: "clarifying_resolved",
							clarificationId: "clarify-1",
						},
					},
					finished(request.body.threadId, request.body.runId, "Done"),
				]);
			}
			return sse([
				...opened(request.body.threadId, request.body.runId),
				interrupt(request.body.threadId, request.body.runId, {
					type: "clarifying_question",
					clarificationId: "clarify-1",
					question: "Which board?",
				}),
			]);
		};
		const { result } = render({ conversationId: "conversation-1" });

		await act(async () => {
			await result.current.sendMessage("Create the tasks");
		});
		let answered: boolean | undefined;
		await act(async () => {
			answered = await result.current.sendClarification("The team board");
		});

		expect(answered).toBe(true);
		expect(requests[1]?.body.resume).toEqual([
			{
				interruptId: "clarify-1",
				status: "resolved",
				payload: { answer: "The team board" },
			},
		]);
		expect(
			result.current.messages.some(
				(m) =>
					m.role === "user" && m.content.includes("The team board"),
			),
		).toBe(true);
		await waitFor(() =>
			expect(result.current.state.status).toBe("completed"),
		);
	});

	it("reports an approval no longer pending as stale", async () => {
		respond = (request) =>
			request.body.resume
				? sse([
						{
							type: "RUN_ERROR",
							message: "Gone",
							code: "INTERRUPT_NOT_PENDING",
						},
					])
				: request.url === CONNECT_URL
					? sse([
							{
								type: "MESSAGES_SNAPSHOT",
								messages: [
									{
										id: `${requests[0]?.body.runId}:assistant`,
										role: "assistant",
										content: "Answered elsewhere",
									},
								],
							},
						])
					: sse([
							...opened(
								request.body.threadId,
								request.body.runId,
							),
							interrupt(
								request.body.threadId,
								request.body.runId,
								{
									type: "approval_required",
									approvalId: "approval-1",
									stepId: "step-1",
									reason: "Writes",
								},
							),
						]);
		const { result } = render({ conversationId: "conversation-1" });

		await act(async () => {
			await result.current.sendMessage("Create");
		});
		let sent: string | undefined;
		await act(async () => {
			sent = await result.current.sendApproval(true);
		});

		expect(sent).toBe("stale");
		expect(result.current.state.pendingApproval).toBeNull();
		// No turn is waiting any more: a connect shows how it ended.
		await waitFor(() =>
			expect(lastAssistant(result)?.content).toBe("Answered elsewhere"),
		);
		expect(requests.at(-1)?.url).toBe(CONNECT_URL);
	});
});

describe("follow-ups", () => {
	it("sends a follow-up as a run, and its response replaces the one being read", async () => {
		const first = { live: null as ReturnType<typeof liveSse> | null };
		respond = (request) => {
			if (request.body.forwardedProps?.followUp) {
				return sse([
					...opened(request.body.threadId, request.body.runId, true),
					{
						type: "CUSTOM",
						name: "fabric.orchestrator.follow-up",
						value: { executionId: EXECUTION },
					},
					...text("b", "With the follow-up"),
					finished(
						request.body.threadId,
						request.body.runId,
						"Final",
					),
				]);
			}
			const live = liveSse(request.signal);
			live.push(
				...opened(request.body.threadId, request.body.runId),
				...text("a", "Working"),
			);
			first.live = live;
			return live.response;
		};
		const { result } = render({ conversationId: "conversation-1" });

		let sending: Promise<unknown> = Promise.resolve();
		act(() => {
			sending = result.current.sendMessage("Start");
		});
		await waitFor(() =>
			expect(lastAssistant(result)?.content).toBe("Working"),
		);

		let accepted: boolean | undefined;
		await act(async () => {
			accepted = await result.current.sendFollowUp(
				"Use the staging data",
				true,
			);
		});
		await act(async () => {
			await sending;
		});

		expect(accepted).toBe(true);
		expect(requests[1]?.body.forwardedProps).toEqual({
			followUp: { isModification: true },
		});
		expect(requests[0]?.signal?.aborted).toBe(true);
		expect(
			result.current.messages.filter((m) => m.role === "user"),
		).toHaveLength(2);
		expect(lastAssistant(result)?.content).toBe("Final");
	});

	it("takes the follow-up back when the turn is no longer running", async () => {
		respond = (request) => {
			if (request.body.forwardedProps?.followUp) {
				return sse([
					{
						type: "RUN_ERROR",
						message: "Not running",
						code: "TURN_NOT_RUNNING",
					},
				]);
			}
			const live = liveSse(request.signal);
			live.push(...opened(request.body.threadId, request.body.runId));
			return live.response;
		};
		const { result } = render({ conversationId: "conversation-1" });
		act(() => {
			void result.current.sendMessage("Start");
		});
		await waitFor(() =>
			expect(result.current.state.executionId).toBe(EXECUTION),
		);

		let accepted: boolean | undefined;
		await act(async () => {
			accepted = await result.current.sendFollowUp("Too late");
		});

		expect(accepted).toBe(false);
		expect(
			result.current.messages.filter((m) => m.role === "user"),
		).toHaveLength(1);
		expect(requests[0]?.signal?.aborted).toBe(false);
		act(() => result.current.reset());
	});
});

describe("stop", () => {
	it("stops the turn by its key and reads the response on so the runtime can save it", async () => {
		const live = { current: null as ReturnType<typeof liveSse> | null };
		respond = (request) => {
			if (request.url.includes("/stop/")) {
				return new Response(null, { status: 200 });
			}
			const response = liveSse(request.signal);
			response.push(
				...opened(request.body.threadId, request.body.runId),
				...text("a", "Partial"),
			);
			live.current = response;
			return response.response;
		};
		const { result } = render({ conversationId: "conversation-1" });
		act(() => {
			void result.current.sendMessage("Start");
		});
		await waitFor(() =>
			expect(lastAssistant(result)?.content).toBe("Partial"),
		);

		act(() => result.current.stop("button"));

		const stopRequest = requests.find((r) => r.url.includes("/stop/"));
		expect(stopRequest?.url).toBe(
			"/api/agents/runtime/agent/fabric-orchestrator/stop/conversation-1",
		);
		expect(stopRequest?.body).toEqual({ runId: requests[0]?.body.runId });
		expect(lastAssistant(result)?.streamStatus).toBe("cancelled");
		expect(requests[0]?.signal?.aborted).toBe(false);

		// Events after the stop are not shown.
		live.current?.push(...text("b", "Trailing"));
		live.current?.close();
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(lastAssistant(result)?.content).toBe("Partial");
	});
});

describe("attach", () => {
	it("follows a running turn of a conversation by connecting to it", async () => {
		respond = () =>
			sse([
				{ type: "MESSAGES_SNAPSHOT", messages: [] },
				...opened("conversation-1", "turn-key", true),
				...text("a", "Live"),
				finished("conversation-1", "turn-key", "Live answer"),
			]);
		const { result } = render();

		await act(async () => {
			await result.current.attach(
				EXECUTION,
				"Running question",
				"conversation-1",
			);
		});

		expect(requests.map((r) => [r.url, r.body.threadId])).toEqual([
			[CONNECT_URL, "conversation-1"],
		]);
		expect(result.current.messages[0]).toEqual(
			expect.objectContaining({
				role: "user",
				content: "Running question",
			}),
		);
		expect(lastAssistant(result)?.content).toBe("Live answer");
	});
});

describe("a message to several agents", () => {
	/** A send with every field the composer and a template can add. */
	const sendAll = (
		result: ReturnType<typeof render>["result"],
		content: string,
	) =>
		result.current.sendMessage(
			content,
			[{ role: "user", content: "Earlier" }],
			false,
			"Template instructions",
			["integration-template"],
			["mcp-template"],
			["fabric-template"],
			["uploads/carried.png", "uploads/new.png"],
			["uploads/new.png"],
			["document-session"],
			["<attachment>notes</attachment>"],
		);
	const options: UseOrchestratorStreamOptions = {
		conversationId: "conversation-1",
		executionMode: "deep",
		enabledMcpConfigIds: ["mcp-chat"],
		enabledFabricToolIds: ["web_search"],
		enabledIntegrationIds: ["integration-chat"],
		attachedDocumentIds: ["document-chat"],
		workspaceIds: ["workspace-chat"],
		projectId: "project-chat",
	};

	it("hands every agent the fields, images and documents a single send carries", async () => {
		respond = (request) =>
			sse([
				...opened(request.body.threadId, request.body.runId),
				finished(request.body.threadId, request.body.runId, "Done"),
			]);
		const single = render(options);
		await act(async () => {
			await sendAll(single.result, "One agent");
		});
		const singleProps = requests[0]?.body.forwardedProps;

		const multiAgentSend = vi.fn(async () => undefined);
		const multi = render({ ...options, multiAgentSend });
		await act(async () => {
			await sendAll(multi.result, "Several agents");
		});

		expect(requests).toHaveLength(1);
		expect(multiAgentSend).toHaveBeenCalledWith(
			expect.objectContaining({
				threadId: "conversation-1",
				content: "Several agents",
				history: [{ role: "user", content: "Earlier" }],
				displayImageUrls: ["uploads/new.png"],
				forwardedProps: singleProps,
			}),
		);
		expect(singleProps).toMatchObject({
			attachedImageUrls: ["uploads/carried.png", "uploads/new.png"],
			inlineAttachmentContexts: ["<attachment>notes</attachment>"],
			enabledFabricToolIds: expect.arrayContaining([
				"web_search",
				"fabric-template",
			]),
			enabledIntegrationIds: expect.arrayContaining([
				"integration-chat",
				"integration-template",
			]),
		});
	});

	it("puts a refused question back as a refused single turn does", async () => {
		const onTurnRefused = vi.fn(() => "Attach them again.");
		const multiAgentSend = vi.fn(
			async (run: { onRefused: () => string | undefined }) => {
				expect(run.onRefused()).toBe("Attach them again.");
			},
		);
		const { result } = render({
			...options,
			multiAgentSend,
			onTurnRefused,
		});

		await act(async () => {
			await result.current.sendMessage("  Several agents  ");
		});

		expect(onTurnRefused).toHaveBeenCalledWith("Several agents");
	});
});
