/**
 * The Agent Builder Sidekick picks its transport once, when it mounts
 * (`COPILOTKIT_SIDEKICK_CHAT`):
 *
 *   - off, or no organization on screen: the panel streams from
 *     `/api/agents/sidekick/stream`;
 *   - on: it runs the agent runtime's `agent-builder-sidekick` agent in the
 *     organization on screen, the agent and the form as it is now in
 *     `forwardedProps`, one thread for the panel's lifetime, and the tool
 *     calls and results sent back as history;
 *   - a flag flipped after mount changes nothing until the next mount;
 *   - on both transports, form auto-apply reads the tool results, the limit
 *     toasts fire, and the opening message survives a re-render with a new
 *     form snapshot, carrying the newest one.
 *
 * Both hooks and the AI SDK and AG-UI clients are real; `fetch` answers by
 * URL and records each request.
 */
import { EventType } from "@ag-ui/client";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	flagOn: false,
	organizationOnScreen: "org-example-1" as string | null,
	getSnapshot: (): Record<string, unknown> => ({ name: "First" }),
	setFormField: vi.fn(),
	showLimitToast: vi.fn(),
	showAiUsageLimitToast: vi.fn(),
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) =>
		key === "COPILOTKIT_SIDEKICK_CHAT" && m.flagOn,
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: m.organizationOnScreen }),
}));
vi.mock("../SidekickFormContext", () => ({
	useSidekickForm: () => ({
		getSnapshot: m.getSnapshot,
		setFormField: m.setFormField,
	}),
}));
vi.mock("@saas/ai/hooks/useLimitToast", () => ({
	useLimitToast: () => m.showLimitToast,
}));
vi.mock("@saas/payments/lib/ai-usage-limit-toast", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/payments/lib/ai-usage-limit-toast")
	>()),
	useShowAiUsageLimitToast: () => m.showAiUsageLimitToast,
}));
vi.mock("../../../../../components/ai-elements/response", () => ({
	Response: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const { AgentBuilderSidekick } = await import("../AgentBuilderSidekick");

const ROUTE_URL = "/api/agents/sidekick/stream";
const RUNTIME_URL = "/api/agents/runtime/agent/agent-builder-sidekick/run";
const OPENING = "Help me improve this agent";
const APPLY = [
	"<sidekick_apply_tools>",
	'[{"action":"add","toolId":"web-search","toolName":"Web search"}]',
	"</sidekick_apply_tools>",
	"<sidekick_apply_metadata>",
	'{"name":"Researcher","description":"Finds sources"}',
	"</sidekick_apply_metadata>",
].join("\n");
const LIMIT_PAYLOAD = {
	limitId: "limit-1",
	dimension: "TOKENS",
	window: "MONTHLY",
	used: "100",
	max: "100",
	manageLimitsUrl: "https://example.com/limits",
};

interface RecordedRequest {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
	signal: AbortSignal | null | undefined;
}

let requests: RecordedRequest[] = [];
/** How the next requests are answered; the default finishes a short reply. */
let respond: (request: RecordedRequest) => Response;

function sse(frames: unknown[], extraHeaders: Record<string, string> = {}) {
	return new Response(
		frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
		{
			status: 200,
			headers: { "Content-Type": "text/event-stream", ...extraHeaders },
		},
	);
}

/** A UI message stream, as the route answers. */
function routeReply(chunks: unknown[]): Response {
	return sse([...chunks], { "x-vercel-ai-ui-message-stream": "v1" });
}

/** The thread and run a runtime request names, which its events echo. */
function runIds(request: RecordedRequest | undefined) {
	return { threadId: request?.body.threadId, runId: request?.body.runId };
}

/** A runtime run carrying `events` between RUN_STARTED and RUN_FINISHED. */
function runtimeReply(request: RecordedRequest, events: unknown[]): Response {
	const ids = runIds(request);
	return sse([
		{ type: EventType.RUN_STARTED, ...ids },
		...events,
		{ type: EventType.RUN_FINISHED, ...ids },
	]);
}

const TEXT_CHUNKS = [
	{ type: "start" },
	{ type: "start-step" },
	{ type: "text-start", id: "t1" },
	{ type: "text-delta", id: "t1", delta: "Here is a start." },
	{ type: "text-end", id: "t1" },
	{ type: "finish-step" },
	{ type: "finish" },
];

function textEvents(messageId: string, text: string): unknown[] {
	return [
		{ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
		{ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text },
		{ type: EventType.TEXT_MESSAGE_END, messageId },
	];
}

function toolEvents(content: string): unknown[] {
	return [
		...textEvents("run:s0:m0", "Adding a tool."),
		{
			type: EventType.TOOL_CALL_START,
			toolCallId: "call-1",
			toolCallName: "suggest_tools",
			parentMessageId: "run:s0:m0",
		},
		{
			type: EventType.TOOL_CALL_ARGS,
			toolCallId: "call-1",
			delta: '{"suggestions":[]}',
		},
		{ type: EventType.TOOL_CALL_END, toolCallId: "call-1" },
		{
			type: EventType.TOOL_CALL_RESULT,
			messageId: "call-1:result",
			toolCallId: "call-1",
			role: "tool",
			content,
		},
	];
}

function defaultReply(request: RecordedRequest): Response {
	return request.url === RUNTIME_URL
		? runtimeReply(request, textEvents("run:s0:m0", "Here is a start."))
		: routeReply(TEXT_CHUNKS);
}

const originalFetch = global.fetch;

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	m.flagOn = false;
	m.organizationOnScreen = "org-example-1";
	m.getSnapshot = () => ({ name: "First" });
	m.setFormField.mockReset();
	m.showLimitToast.mockReset();
	m.showAiUsageLimitToast.mockReset();
	requests = [];
	respond = defaultReply;
	global.fetch = vi.fn<typeof fetch>(async (input, init) => {
		const request: RecordedRequest = {
			url: String(input),
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body ?? "{}")),
			signal: init?.signal,
		};
		requests.push(request);
		return respond(request);
	});
	Element.prototype.scrollTo = vi.fn();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	global.fetch = originalFetch;
});

function sidekick() {
	return <AgentBuilderSidekick agentId="agent-example-1" />;
}

/** Mount the panel and let its opening message go. */
async function mountAndOpen() {
	const view = render(sidekick());
	await act(async () => {
		await vi.advanceTimersByTimeAsync(500);
	});
	await waitFor(() => expect(requests).toHaveLength(1));
	return view;
}

/** The text of the last user message a request carries. */
function lastUserText(
	request: RecordedRequest | undefined,
): string | undefined {
	const messages = request?.body.messages;
	if (!Array.isArray(messages)) {
		return undefined;
	}
	const last = messages.at(-1);
	if (typeof last?.content === "string") {
		return last.content;
	}
	return last?.parts?.find((part: { type: string }) => part.type === "text")
		?.text;
}

async function settled() {
	await waitFor(() =>
		expect(screen.getByRole<HTMLTextAreaElement>("textbox").disabled).toBe(
			false,
		),
	);
}

describe("AgentBuilderSidekick transport", () => {
	it.each([false, true])(
		"hides assistant control markup without changing the raw follow-up history (runtime: %s)",
		async (flagOn) => {
			m.flagOn = flagOn;
			const protocolText =
				'Visible explanation.\n<sidekick_apply_metadata>\n{"name":"Example"}\n</sidekick_apply_metadata>\nVisible conclusion.';
			respond = (request) =>
				flagOn
					? runtimeReply(
							request,
							textEvents("run:s0:m0", protocolText),
						)
					: sse(
							TEXT_CHUNKS.map((chunk) =>
								chunk.type === "text-delta"
									? { ...chunk, delta: protocolText }
									: chunk,
							),
						);
			await mountAndOpen();
			await settled();
			expect(document.body.textContent).not.toContain(
				"sidekick_apply_metadata",
			);
			expect(document.body.textContent).toContain("Visible explanation.");
			fireEvent.change(screen.getByRole("textbox"), {
				target: { value: "Follow up" },
			});
			fireEvent.click(
				screen.getByRole("button", { name: "Send message" }),
			);
			await waitFor(() => expect(requests).toHaveLength(2));
			expect(JSON.stringify(requests[1]?.body.messages)).toContain(
				"sidekick_apply_metadata",
			);
		},
	);
	it("keeps control-like text visible when the user types it", async () => {
		m.flagOn = true;
		await mountAndOpen();
		await settled();
		const userText = "Explain <sidekick_apply_metadata> literally";
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: userText },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		expect(await screen.findByText(userText)).toBeDefined();
	});
	it("streams from the Sidekick route while the flag is off", async () => {
		await mountAndOpen();
		await settled();

		expect(requests.map((request) => request.url)).toEqual([ROUTE_URL]);
		expect(lastUserText(requests[0])).toBe(OPENING);
	});

	it("runs the agent runtime's Sidekick in the organization on screen when the flag is on", async () => {
		m.flagOn = true;

		await mountAndOpen();
		await settled();

		expect(requests.map((request) => request.url)).toEqual([RUNTIME_URL]);
		const [request] = requests;
		expect(request?.headers.get("x-fabric-organization-id")).toBe(
			"org-example-1",
		);
		expect(request?.body.forwardedProps).toEqual({
			agentId: "agent-example-1",
			entityType: "registered",
			formSnapshot: { name: "First" },
		});
		expect(lastUserText(request)).toBe(OPENING);
		expect(await screen.findByText("Here is a start.")).toBeTruthy();
	});

	it("stays on the route with no organization on screen", async () => {
		m.flagOn = true;
		m.organizationOnScreen = null;

		await mountAndOpen();

		expect(requests.map((request) => request.url)).toEqual([ROUTE_URL]);
	});

	it.each([
		["off to on, staying on the route", false, ROUTE_URL],
		["on to off, staying on the runtime", true, RUNTIME_URL],
	])(
		"keeps its transport when the flag flips after mount (%s)",
		async (_label, initial, url) => {
			m.flagOn = initial;
			const view = render(sidekick());
			m.flagOn = !initial;
			view.rerender(sidekick());
			await act(async () => {
				await vi.advanceTimersByTimeAsync(500);
			});
			await waitFor(() => expect(requests).toHaveLength(1));

			expect(requests[0]?.url).toBe(url);
		},
	);

	it("sends the first run's tool calls and results back, on the same thread", async () => {
		m.flagOn = true;
		respond = (request) =>
			runtimeReply(request, [
				...toolEvents("Suggested a tool."),
				...textEvents("run:s1:m1", "Done."),
			]);
		await mountAndOpen();
		await settled();

		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "Rename the agent" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		await waitFor(() => expect(requests).toHaveLength(2));

		const [first, second] = requests;
		expect(second?.body.threadId).toBe(first?.body.threadId);
		expect(second?.body.messages).toEqual([
			expect.objectContaining({ role: "user", content: OPENING }),
			expect.objectContaining({
				id: "run:s0:m0",
				role: "assistant",
				content: "Adding a tool.",
				toolCalls: [
					expect.objectContaining({
						id: "call-1",
						function: {
							name: "suggest_tools",
							arguments: '{"suggestions":[]}',
						},
					}),
				],
			}),
			expect.objectContaining({
				role: "tool",
				toolCallId: "call-1",
				content: "Suggested a tool.",
			}),
			expect.objectContaining({ role: "assistant", content: "Done." }),
			expect.objectContaining({
				role: "user",
				content: "Rename the agent",
			}),
		]);
	});

	it.each([
		[
			"runtime",
			true,
			(request: RecordedRequest) =>
				runtimeReply(request, toolEvents(APPLY)),
		],
		[
			"route",
			false,
			() =>
				routeReply([
					{ type: "start" },
					{ type: "start-step" },
					{
						type: "tool-input-available",
						toolCallId: "call-1",
						toolName: "suggest_tools",
						input: { suggestions: [] },
					},
					{
						type: "tool-output-available",
						toolCallId: "call-1",
						output: APPLY,
					},
					{ type: "finish-step" },
					{ type: "finish" },
				]),
		],
	])(
		"applies a tool result's tools, name and description to the form (%s)",
		async (_label, flagOn, reply) => {
			m.flagOn = flagOn;
			respond = reply;

			await mountAndOpen();
			await waitFor(() =>
				expect(
					m.setFormField.mock.calls.map(([field]) => field),
				).toEqual(["tools", "name", "description"]),
			);

			const updates = Object.fromEntries(
				m.setFormField.mock.calls.map(([field, update]) => [
					field,
					update([]),
				]),
			);
			expect(updates).toEqual({
				tools: [{ id: "web-search", name: "Web search" }],
				name: "Researcher",
				description: "Finds sources",
			});
		},
	);

	it("shows the usage-limit toast for a runtime run that ends with one", async () => {
		m.flagOn = true;
		respond = (request) =>
			sse([
				{ type: EventType.RUN_STARTED, ...runIds(request) },
				{
					type: EventType.RUN_ERROR,
					message: "AI usage limit exceeded",
					code: "AI_USAGE_LIMIT_EXCEEDED",
					metadata: {
						fabric: {
							status: 429,
							error: "AI usage limit exceeded",
							code: "AI_USAGE_LIMIT_EXCEEDED",
							data: LIMIT_PAYLOAD,
						},
					},
				},
			]);

		await mountAndOpen();
		await waitFor(() =>
			expect(m.showAiUsageLimitToast).toHaveBeenCalledTimes(1),
		);

		expect(m.showAiUsageLimitToast).toHaveBeenCalledWith(LIMIT_PAYLOAD);
		expect(m.showLimitToast).not.toHaveBeenCalled();
		await settled();
	});

	// The fetch interceptor toasts these from the run's `metadata.fabric`
	// (CopilotFetchErrorInterceptor.coverage.test.tsx, "inside an agent
	// runtime stream"); a second toast from the panel would repeat it.
	it.each([
		{
			refusal: "a ChatGPT plan to reconnect",
			fabric: {
				status: 409,
				error: "Reconnect the ChatGPT plan.",
				code: "CHATGPT_PLAN_UNAVAILABLE",
			},
		},
		{
			refusal: "a model the ChatGPT plan does not serve",
			fabric: {
				status: 409,
				error: "The ChatGPT plan does not serve example-model.",
				code: "CHATGPT_PLAN_MODEL_NOT_SERVED",
			},
		},
		{
			refusal: "a spent ChatGPT plan",
			fabric: {
				status: 429,
				error: "Your ChatGPT plan has no usage left until 15:00.",
				code: "subscription_sharing_usage_limit_exceeded",
				resetAt: "2026-10-30T15:00:00.000Z",
			},
		},
	])(
		"leaves the toast for $refusal on the runtime to the fetch interceptor",
		async ({ fabric }) => {
			m.flagOn = true;
			respond = (request) =>
				sse([
					{ type: EventType.RUN_STARTED, ...runIds(request) },
					{
						type: EventType.RUN_ERROR,
						message: fabric.error,
						code: fabric.code,
						metadata: { fabric },
					},
				]);

			await mountAndOpen();
			await waitFor(() =>
				expect(console.error).toHaveBeenCalledWith(
					"[AgentBuilderSidekick] Stream error:",
					expect.objectContaining({ message: fabric.error }),
				),
			);

			expect(requests.map((request) => request.url)).toEqual([
				RUNTIME_URL,
			]);
			expect(m.showLimitToast).not.toHaveBeenCalled();
			expect(m.showAiUsageLimitToast).not.toHaveBeenCalled();
			await settled();
		},
	);

	it("shows the usage-limit toast for the route's 429", async () => {
		respond = () =>
			Response.json(
				{
					error: "AI usage limit exceeded",
					code: "AI_USAGE_LIMIT_EXCEEDED",
					data: LIMIT_PAYLOAD,
				},
				{ status: 429 },
			);

		await mountAndOpen();
		await waitFor(() =>
			expect(m.showAiUsageLimitToast).toHaveBeenCalledTimes(1),
		);

		expect(m.showAiUsageLimitToast).toHaveBeenCalledWith(LIMIT_PAYLOAD);
	});

	it("shows Thinking... on the runtime until the reply's first content", async () => {
		m.flagOn = true;
		const encoder = new TextEncoder();
		let push: (frame: unknown) => void = () => {};
		let close: () => void = () => {};
		respond = () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						push = (frame) =>
							controller.enqueue(
								encoder.encode(
									`data: ${JSON.stringify(frame)}\n\n`,
								),
							);
						close = () => controller.close();
					},
				}),
				{
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				},
			);

		await mountAndOpen();
		const ids = runIds(requests[0]);
		push({ type: EventType.RUN_STARTED, ...ids });
		expect(await screen.findByText("Thinking...")).toBeTruthy();

		push({
			type: EventType.TEXT_MESSAGE_START,
			messageId: "run:s0:m0",
			role: "assistant",
		});
		push({
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: "run:s0:m0",
			delta: "First words",
		});
		expect(await screen.findByText("First words")).toBeTruthy();
		expect(screen.queryByText("Thinking...")).toBeNull();

		push({ type: EventType.TEXT_MESSAGE_END, messageId: "run:s0:m0" });
		push({ type: EventType.RUN_FINISHED, ...ids });
		close();
		await settled();
	});

	it("reports nothing when the panel closes mid-run on the runtime", async () => {
		m.flagOn = true;
		const encoder = new TextEncoder();
		respond = (request) =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							encoder.encode(
								`data: ${JSON.stringify({ type: EventType.RUN_STARTED, ...runIds(request) })}\n\n`,
							),
						);
						// As fetch does, the body fails with an AbortError once the
						// request is aborted.
						request.signal?.addEventListener("abort", () =>
							controller.error(
								new DOMException(
									"The request was aborted.",
									"AbortError",
								),
							),
						);
					},
				}),
				{
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				},
			);

		const view = await mountAndOpen();
		expect(await screen.findByText("Thinking...")).toBeTruthy();
		view.unmount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(50);
		});

		expect(requests[0]?.signal?.aborted).toBe(true);
		expect(console.error).not.toHaveBeenCalledWith(
			"[AgentBuilderSidekick] Stream error:",
			expect.anything(),
		);
		expect(m.showLimitToast).not.toHaveBeenCalled();
		expect(m.showAiUsageLimitToast).not.toHaveBeenCalled();
	});

	it.each([
		["runtime", true],
		["route", false],
	])(
		"sends the opening message once, with the newest snapshot, after a re-render (%s)",
		async (_label, flagOn) => {
			m.flagOn = flagOn;
			const encoder = new TextEncoder();
			let finish: () => void = () => {};
			respond = (request) => {
				if (request.url !== RUNTIME_URL) {
					return defaultReply(request);
				}
				const ids = runIds(request);
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							const send = (frame: unknown) =>
								controller.enqueue(
									encoder.encode(
										`data: ${JSON.stringify(frame)}\n\n`,
									),
								);
							send({ type: EventType.RUN_STARTED, ...ids });
							finish = () => {
								send({ type: EventType.RUN_FINISHED, ...ids });
								controller.close();
							};
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "text/event-stream" },
					},
				);
			};

			const view = render(sidekick());
			m.getSnapshot = () => ({ name: "Second" });
			view.rerender(sidekick());
			await act(async () => {
				await vi.advanceTimersByTimeAsync(500);
			});
			await waitFor(() => expect(requests).toHaveLength(1));

			const [request] = requests;
			const newest = { formSnapshot: { name: "Second" } };
			expect(request?.body).toMatchObject(
				flagOn ? { forwardedProps: newest } : newest,
			);
			expect(lastUserText(request)).toBe(OPENING);

			if (flagOn) {
				m.getSnapshot = () => ({ name: "Third" });
				view.rerender(sidekick());
				await act(async () => {
					await vi.advanceTimersByTimeAsync(50);
				});
				expect(request?.signal?.aborted).toBe(false);
				finish();
			}
			await settled();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(600);
			});
			expect(requests).toHaveLength(1);
		},
	);
});
