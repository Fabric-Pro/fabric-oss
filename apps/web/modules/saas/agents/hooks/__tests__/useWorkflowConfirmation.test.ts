import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectStreamMessage } from "../useDirectStream";
import { useWorkflowConfirmation } from "../useWorkflowConfirmation";

const message: DirectStreamMessage = {
	id: "message-1",
	role: "assistant",
	content: "",
	timestamp: new Date(0),
	streamStatus: "completed",
	pendingConfirmation: {
		workflowId: "workflow-1",
		workflowName: "Example workflow",
		message: "Start this workflow?",
	},
};
const options = {
	messages: [message],
	organizationId: "example-org",
	isLoading: false,
};
afterEach(() => vi.restoreAllMocks());

describe("workflow confirmation", () => {
	it("displays explicit confirmations without tool calls or text", () => {
		const { result } = renderHook(() => useWorkflowConfirmation(options));
		expect(result.current.confirmation).toMatchObject({
			messageId: "message-1",
			status: "requested",
		});
	});

	it("consumes approval synchronously and reports started, not completed", async () => {
		let resolve: (response: Response) => void = () => {};
		const fetchMock = vi.spyOn(global, "fetch").mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const { result, rerender } = renderHook(() =>
			useWorkflowConfirmation(options),
		);
		let pending: Promise<void> | undefined;
		act(() => {
			pending = result.current.confirm();
			void result.current.confirm();
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
			workflowId: "workflow-1",
			organizationId: "example-org",
		});
		expect(result.current.confirmation?.status).toBe("submitting");
		await act(async () => {
			resolve(
				Response.json({ success: true, executionId: "execution-1" }),
			);
			await pending;
		});
		rerender();
		expect(result.current.confirmation).toMatchObject({
			status: "started",
			executionId: "execution-1",
		});
		await act(async () => result.current.confirm());
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each(["network", "invalid reply", "server error", "unconfirmed"])(
		"does not retry an ambiguous %s outcome",
		async (failure) => {
			const fetchMock = vi.spyOn(global, "fetch");
			if (failure === "network") {
				fetchMock.mockRejectedValue(new Error("Connection lost"));
			} else if (failure === "invalid reply") {
				fetchMock.mockResolvedValue(new Response(""));
			} else {
				fetchMock.mockResolvedValue(
					Response.json(
						{ status: "unconfirmed" },
						{ status: failure === "server error" ? 500 : 202 },
					),
				);
			}
			const { result } = renderHook(() =>
				useWorkflowConfirmation(options),
			);
			await act(async () => result.current.confirm());
			expect(result.current.confirmation?.status).toBe("unconfirmed");
			await act(async () => result.current.confirm());
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);

	it("keeps an authorization rejection distinct from an unknown outcome", async () => {
		vi.spyOn(global, "fetch").mockResolvedValue(
			Response.json({ error: "Workflow access denied" }, { status: 403 }),
		);
		const { result } = renderHook(() => useWorkflowConfirmation(options));
		await act(async () => result.current.confirm());
		expect(result.current.confirmation).toMatchObject({
			status: "failed",
			message: "Workflow access denied",
		});
	});

	it("does not resurrect a declined prompt on re-render", async () => {
		const fetchMock = vi.spyOn(global, "fetch");
		const { result, rerender } = renderHook(() =>
			useWorkflowConfirmation(options),
		);
		act(() => result.current.decline());
		rerender();
		expect(result.current.confirmation?.status).toBe("declined");
		await act(async () => result.current.confirm());
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("never offers an old organization's confirmation in a new organization", () => {
		const { result, rerender } = renderHook(
			(props) => useWorkflowConfirmation(props),
			{ initialProps: options },
		);
		rerender({ ...options, organizationId: "other-org" });
		expect(result.current.confirmation).toBeNull();
	});

	it.each(["cancelled", "error"] as const)(
		"does not authorize a %s turn",
		(streamStatus) => {
			const { result } = renderHook(() =>
				useWorkflowConfirmation({
					...options,
					messages: [{ ...message, streamStatus }],
				}),
			);
			expect(result.current.confirmation).toBeNull();
		},
	);
});
