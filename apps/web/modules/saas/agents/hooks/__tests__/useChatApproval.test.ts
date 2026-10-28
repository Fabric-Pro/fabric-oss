import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatApproval } from "../useChatApproval";

const fetchMock = vi.fn();
beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockReset();
});
afterEach(() => {
	vi.unstubAllGlobals();
});
function response(status: number, body: unknown) {
	return new Response(JSON.stringify(body), { status });
}
it("sends the exact displayed approval once despite simultaneous clicks", async () => {
	fetchMock.mockResolvedValue(
		response(200, { success: true, approved: true }),
	);
	const { result } = renderHook(() =>
		useChatApproval("execution-1", "approval-1"),
	);
	await act(async () => {
		expect(
			await Promise.all([
				result.current.respond(true),
				result.current.respond(false),
			]),
		).toEqual([true, false]);
	});
	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
		executionId: "execution-1",
		approvalId: "approval-1",
		approved: true,
	});
	expect(result.current.decision).toBe(true);
});
it.each([503, 409, 403])(
	"does not clear or claim success for HTTP %s",
	async (status) => {
		fetchMock.mockResolvedValue(response(status, { error: "failure" }));
		const { result } = renderHook(() =>
			useChatApproval("execution-1", "approval-1"),
		);
		await act(async () => {
			expect(await result.current.respond(true)).toBe(false);
		});
		expect(result.current.error).toBeTruthy();
		expect(result.current.decision).toBeNull();
		expect(result.current.disabled).toBe(true);
	},
);
it("keeps a network failure unconfirmed and never automatically retries", async () => {
	fetchMock.mockRejectedValue(new Error("offline"));
	const { result } = renderHook(() =>
		useChatApproval("execution-1", "approval-1"),
	);
	await act(async () => {
		await result.current.respond(true);
	});
	await act(async () => {
		expect(await result.current.respond(true)).toBe(false);
	});
	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(result.current.error).toContain("connection was lost");
});
it("ignores late receipts after the conversation changes", async () => {
	let finish!: (r: Response) => void;
	fetchMock.mockImplementation(
		() =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			}),
	);
	const { result, rerender } = renderHook(
		({ run }) => useChatApproval(run, "approval-1"),
		{ initialProps: { run: "run-1" } },
	);
	let receipt!: Promise<boolean>;
	act(() => {
		receipt = result.current.respond(true);
	});
	rerender({ run: "run-2" });
	await act(async () => {
		finish(response(200, { success: true, approved: true }));
		expect(await receipt).toBe(false);
	});
	expect(result.current.decision).toBeNull();
	expect(result.current.disabled).toBe(false);
});
it("ignores late receipts after the approval card unmounts", async () => {
	let finish!: (r: Response) => void;
	fetchMock.mockImplementation(
		() =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			}),
	);
	const { result, unmount } = renderHook(() =>
		useChatApproval("run-1", "approval-1"),
	);
	let receipt!: Promise<boolean>;
	act(() => {
		receipt = result.current.respond(true);
	});
	unmount();
	finish(response(200, { success: true, approved: true }));
	expect(await receipt).toBe(false);
});
it("requires the workflow to acknowledge the chosen decision", async () => {
	fetchMock.mockResolvedValue(
		response(200, { success: true, approved: false }),
	);
	const { result } = renderHook(() => useChatApproval("run-1", "approval-1"));
	await act(async () => {
		expect(await result.current.respond(true)).toBe(false);
	});
	expect(result.current.decision).toBeNull();
});
