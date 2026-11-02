import { EventType } from "@ag-ui/client";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDataAnalystChat } from "../useDataAnalystChat";

const m = vi.hoisted(() => ({ usageToast: vi.fn() }));
vi.mock("@saas/payments/lib/ai-usage-limit-toast", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/payments/lib/ai-usage-limit-toast")
	>()),
	useShowAiUsageLimitToast: () => m.usageToast,
}));
const fetchMock = vi.fn<typeof fetch>();
function response(events: object[]): Response {
	return new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}
const answer = () =>
	response([
		{
			type: EventType.TEXT_MESSAGE_START,
			messageId: "answer",
			role: "assistant",
		},
		{
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: "answer",
			delta: "Example answer",
		},
		{ type: EventType.TEXT_MESSAGE_END, messageId: "answer" },
		{ type: EventType.RUN_FINISHED, threadId: "thread", runId: "run" },
	]);
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockImplementation(async () => answer());
});
afterEach(() => vi.unstubAllGlobals());

describe("useDataAnalystChat", () => {
	it("uses the runtime, current organization and stable text history; reset changes the thread", async () => {
		const { result } = renderHook(() =>
			useDataAnalystChat({ organizationId: "org-example-1" }),
		);
		await act(() => result.current.send(" First "));
		await act(() => result.current.send("Second"));
		const [url, options] = fetchMock.mock.calls[1];
		expect(url).toBe("/api/agents/runtime/agent/data-analyst/run");
		expect(options?.headers).toMatchObject({
			"x-fabric-organization-id": "org-example-1",
		});
		const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
		const second = JSON.parse(String(options?.body));
		expect(second.threadId).toBe(first.threadId);
		expect(second.forwardedProps).toEqual({});
		expect(
			second.messages.map(
				({ role, content }: { role: string; content: string }) => ({
					role,
					content,
				}),
			),
		).toEqual([
			{ role: "user", content: "First" },
			{ role: "assistant", content: "Example answer" },
			{ role: "user", content: "Second" },
		]);
		act(() => result.current.reset());
		expect(result.current.messages).toEqual([]);
		await act(() => result.current.send("New thread"));
		expect(
			JSON.parse(String(fetchMock.mock.calls[2][1]?.body)).threadId,
		).not.toBe(first.threadId);
	});
	it("ignores blank sends and overlapping sends, and Stop aborts without a stop POST", async () => {
		fetchMock.mockImplementation(
			(_url, options) =>
				new Promise((_resolve, reject) => {
					options?.signal?.addEventListener(
						"abort",
						() => reject(new DOMException("Stopped", "AbortError")),
						{ once: true },
					);
				}),
		);
		const { result } = renderHook(() =>
			useDataAnalystChat({ organizationId: "org-example-1" }),
		);
		await act(() => result.current.send("  "));
		expect(fetchMock).not.toHaveBeenCalled();
		let sending: Promise<void> | undefined;
		act(() => {
			sending = result.current.send("Question");
		});
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		await act(() => result.current.send("Ignored"));
		await act(async () => {
			result.current.stop();
			await sending;
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
		expect(result.current.running).toBe(false);
		expect(result.current.messages.at(-1)).toMatchObject({
			role: "assistant",
			turn: { status: "stopped" },
		});
	});
	it("marks an early end as a failure and settles pending tools", async () => {
		fetchMock.mockResolvedValue(
			response([
				{
					type: EventType.TOOL_CALL_START,
					toolCallId: "call",
					toolCallName: "query",
				},
			]),
		);
		const { result } = renderHook(() =>
			useDataAnalystChat({ organizationId: "org-example-1" }),
		);
		await act(() => result.current.send("Question"));
		expect(result.current.messages.at(-1)).toMatchObject({
			turn: {
				status: "failed",
				error: "The connection to this analysis was lost. Please ask again.",
				toolCalls: [{ status: "error" }],
			},
		});
	});
	it("shows an HTTP refusal's message and dispatches the shared usage-limit toast", async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json(
				{ message: "This organization is unavailable" },
				{ status: 403 },
			),
		);
		const { result } = renderHook(() =>
			useDataAnalystChat({ organizationId: "org-example-1" }),
		);
		await act(() => result.current.send("Question"));
		expect(result.current.messages.at(-1)).toMatchObject({
			turn: {
				status: "failed",
				error: "This organization is unavailable",
			},
		});
		const data = {
			limitId: "limit-example",
			dimension: "TOKENS",
			window: "DAILY",
			used: "11",
			max: "10",
			manageLimitsUrl: "/limits",
		};
		fetchMock.mockResolvedValueOnce(
			response([
				{
					type: EventType.RUN_ERROR,
					message: "Limit reached",
					code: "AI_USAGE_LIMIT_EXCEEDED",
					metadata: { fabric: { data } },
				},
			]),
		);
		await act(() => result.current.send("Another question"));
		expect(m.usageToast).toHaveBeenCalledWith(data);
	});
	it("reset drops an old reply that resolves after the next thread answered", async () => {
		let resolveOld: ((response: Response) => void) | undefined;
		fetchMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveOld = resolve;
				}),
		);
		const { result } = renderHook(() =>
			useDataAnalystChat({ organizationId: "org-example-1" }),
		);
		let oldSend: Promise<void> | undefined;
		act(() => {
			oldSend = result.current.send("Old question");
		});
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		act(() => result.current.reset());
		await act(() => result.current.send("New question"));
		await act(async () => {
			resolveOld?.(answer());
			await oldSend;
		});
		expect(result.current.messages).toHaveLength(2);
		expect(result.current.messages[0]).toMatchObject({
			role: "user",
			content: "New question",
		});
		expect(result.current.messages[1]).toMatchObject({
			role: "assistant",
			turn: { text: "Example answer", status: "finished" },
		});
	});

	it("unmount aborts a running request", async () => {
		fetchMock.mockImplementation(
			(_url, options) =>
				new Promise((_resolve, reject) => {
					options?.signal?.addEventListener(
						"abort",
						() => reject(new DOMException("Stopped", "AbortError")),
						{ once: true },
					);
				}),
		);
		const { result, unmount } = renderHook(() =>
			useDataAnalystChat({ organizationId: "org-example-1" }),
		);
		let sending: Promise<void> | undefined;
		act(() => {
			sending = result.current.send("Question");
		});
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		unmount();
		await sending;
		expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
	});
});
