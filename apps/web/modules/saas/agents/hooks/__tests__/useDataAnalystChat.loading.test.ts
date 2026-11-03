import { EventType } from "@ag-ui/client";
import type { loadDataAnalystRuntime } from "@saas/agents/lib/load-data-analyst-runtime";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataAnalystChat } from "../useDataAnalystChat";

type Runtime = Awaited<ReturnType<typeof loadDataAnalystRuntime>>;

const m = vi.hoisted(() => ({
	load: vi.fn<() => Promise<Runtime>>(),
	usageToast: vi.fn(),
}));
vi.mock("@saas/agents/lib/load-data-analyst-runtime", () => ({
	loadDataAnalystRuntime: m.load,
}));
vi.mock("@saas/payments/lib/ai-usage-limit-toast", () => ({
	useShowAiUsageLimitToast: () => m.usageToast,
}));

function runtime(): Runtime {
	return {
		applyEvent: (turn) => ({ ...turn, status: "finished" }),
		stream: vi
			.fn<Runtime["stream"]>()
			.mockImplementation(async ({ onEvent }) => {
				onEvent({
					type: EventType.RUN_FINISHED,
					threadId: "thread",
					runId: "run",
				});
			}),
		errorMessageOf: (error) =>
			error instanceof Error ? error.message : "Stream failed",
		isAbortError: (error) =>
			error instanceof Error && error.name === "AbortError",
	};
}

beforeEach(() => vi.clearAllMocks());

describe("Data Analyst runtime loading", () => {
	it("does not load on mount and publishes the pending turn before loading on Send", async () => {
		const loaded = Promise.withResolvers<Runtime>();
		m.load.mockReturnValueOnce(loaded.promise);
		const run = runtime();
		const { result } = renderHook(() =>
			useDataAnalystChat({ organizationId: "example-org" }),
		);
		expect(m.load).not.toHaveBeenCalled();
		let sending: Promise<void> | undefined;
		act(() => {
			sending = result.current.send("Question");
		});
		expect(m.load).toHaveBeenCalledOnce();
		expect(result.current.running).toBe(true);
		expect(result.current.messages).toMatchObject([
			{ role: "user", content: "Question" },
			{ role: "assistant", turn: { status: "running", text: "" } },
		]);
		expect(run.stream).not.toHaveBeenCalled();
		await act(async () => {
			loaded.resolve(run);
			await sending;
		});
		expect(run.stream).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "data-analyst",
				organizationId: "example-org",
			}),
		);
		expect(result.current.running).toBe(false);
	});

	it("Stop while loading does not wait for the import or start its request", async () => {
		const loaded = Promise.withResolvers<Runtime>();
		m.load.mockReturnValueOnce(loaded.promise);
		const run = runtime();
		const { result } = renderHook(() =>
			useDataAnalystChat({ organizationId: "example-org" }),
		);
		let sending: Promise<void> | undefined;
		act(() => {
			sending = result.current.send("Question");
		});
		await act(async () => {
			result.current.stop();
			await sending;
		});
		expect(result.current.running).toBe(false);
		expect(result.current.messages.at(-1)).toMatchObject({
			role: "assistant",
			turn: { status: "stopped" },
		});
		await act(async () => {
			loaded.resolve(run);
			await sending;
		});
		expect(run.stream).not.toHaveBeenCalled();
	});

	it("Stop retains ownership of an active stream until it settles", async () => {
		const finished = Promise.withResolvers<void>();
		const stream = vi
			.fn<Runtime["stream"]>()
			.mockReturnValueOnce(finished.promise);
		m.load.mockResolvedValueOnce({ ...runtime(), stream });
		const { result } = renderHook(() =>
			useDataAnalystChat({ organizationId: "example-org" }),
		);
		let sending: Promise<void> | undefined;
		act(() => {
			sending = result.current.send("Question");
		});
		await waitFor(() => expect(stream).toHaveBeenCalledOnce());
		act(() => result.current.stop());
		expect(stream.mock.calls[0]?.[0].signal.aborted).toBe(true);
		expect(result.current.running).toBe(true);
		await act(() => result.current.send("Wait for settlement"));
		expect(m.load).toHaveBeenCalledOnce();
		expect(stream).toHaveBeenCalledOnce();
		expect(result.current.messages).toHaveLength(2);
		await act(async () => {
			finished.resolve();
			await sending;
		});
		expect(result.current.running).toBe(false);
		expect(result.current.messages.at(-1)).toMatchObject({
			turn: { status: "stopped" },
		});
		m.load.mockResolvedValueOnce(runtime());
		await act(() => result.current.send("After settlement"));
		expect(m.load).toHaveBeenCalledTimes(2);
	});

	it("a reset and newer Send supersede an older pending loader", async () => {
		const old = Promise.withResolvers<Runtime>();
		const oldRun = runtime();
		const newRun = runtime();
		m.load.mockReturnValueOnce(old.promise).mockResolvedValueOnce(newRun);
		const { result } = renderHook(() =>
			useDataAnalystChat({ organizationId: "example-org" }),
		);
		let oldSend: Promise<void> | undefined;
		act(() => {
			oldSend = result.current.send("Old question");
		});
		act(() => result.current.reset());
		await act(() => result.current.send("New question"));
		await act(async () => {
			old.resolve(oldRun);
			await oldSend;
		});
		expect(oldRun.stream).not.toHaveBeenCalled();
		expect(newRun.stream).toHaveBeenCalledOnce();
		expect(result.current.messages).toHaveLength(2);
		expect(result.current.messages[0]).toMatchObject({
			role: "user",
			content: "New question",
		});
		expect(result.current.messages[1]).toMatchObject({
			turn: { status: "finished" },
		});
	});

	it("unmount during loading never starts a request", async () => {
		const loaded = Promise.withResolvers<Runtime>();
		m.load.mockReturnValueOnce(loaded.promise);
		const run = runtime();
		const { result, unmount } = renderHook(() =>
			useDataAnalystChat({ organizationId: "example-org" }),
		);
		let sending: Promise<void> | undefined;
		act(() => {
			sending = result.current.send("Question");
		});
		unmount();
		loaded.resolve(run);
		await sending;
		expect(run.stream).not.toHaveBeenCalled();
	});

	it("a loader failure is visible and a subsequent Send retries loading", async () => {
		const run = runtime();
		m.load
			.mockRejectedValueOnce(new Error("Analysis could not load"))
			.mockResolvedValueOnce(run);
		const { result } = renderHook(() =>
			useDataAnalystChat({ organizationId: "example-org" }),
		);
		await act(() => result.current.send("Question"));
		expect(result.current.running).toBe(false);
		expect(result.current.messages.at(-1)).toMatchObject({
			turn: {
				status: "failed",
				error: "The analysis could not load. Please try again.",
			},
		});
		await act(() => result.current.send("Retry"));
		expect(m.load).toHaveBeenCalledTimes(2);
		expect(run.stream).toHaveBeenCalledOnce();
		expect(result.current.messages.at(-1)).toMatchObject({
			turn: { status: "finished" },
		});
	});
});
