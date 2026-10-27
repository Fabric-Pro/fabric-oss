import { ChatApprovalCard } from "@saas/ai/components/ChatApprovalCard";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApprovalPanel } from "../orchestrator/ApprovalPanel";

const fetchMock = vi.fn();
const pending = {
	approvalId: "approval-1",
	stepId: "step-1",
	reason: "HIGH RISK: Update an example record",
};
beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
});
it("shows accessible actions and records only an acknowledged decision", async () => {
	const onDecision = vi.fn();
	fetchMock.mockResolvedValue(
		new Response(JSON.stringify({ success: true, approved: true }), {
			status: 200,
		}),
	);
	render(
		<ApprovalPanel
			executionId="execution-1"
			pending={pending}
			plan={null}
			onDecision={onDecision}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
	await waitFor(() =>
		expect(onDecision).toHaveBeenCalledWith(
			expect.objectContaining({
				approvalId: "approval-1",
				stepId: "step-1",
				approved: true,
			}),
		),
	);
	expect(screen.getByRole("status")).toHaveTextContent("Approval accepted");
	expect(screen.getByRole("button", { name: /Approve/ })).toBeDisabled();
});
it("announces uncertainty without adding a successful history entry", async () => {
	const onDecision = vi.fn();
	fetchMock.mockRejectedValue(new Error("offline"));
	render(
		<ApprovalPanel
			executionId="execution-1"
			pending={pending}
			plan={null}
			onDecision={onDecision}
		/>,
	);
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
	});
	expect(onDecision).not.toHaveBeenCalled();
	expect(
		screen
			.getAllByRole("alert")
			.some((alert) =>
				alert.textContent?.includes("connection was lost"),
			),
	).toBe(true);
	expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
it("uses the same bound decision on the Research card", async () => {
	fetchMock.mockResolvedValue(
		new Response(JSON.stringify({ success: true, approved: false }), {
			status: 200,
		}),
	);
	render(<ChatApprovalCard executionId="execution-1" {...pending} />);
	fireEvent.click(screen.getByRole("button", { name: "Reject" }));
	await screen.findByText("Rejection accepted.");
	expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
		executionId: "execution-1",
		approvalId: "approval-1",
		approved: false,
	});
	expect(screen.queryByText(/workflow stopped/i)).not.toBeInTheDocument();
});
