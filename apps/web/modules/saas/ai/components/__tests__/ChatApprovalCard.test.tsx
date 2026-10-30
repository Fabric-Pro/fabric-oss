/**
 * The Copilot page's approval card answers one approval. The run takes an
 * answer only for the approval it names, so a card left on an earlier
 * response cannot approve whatever the run is asking now.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatApprovalCard } from "../ChatApprovalCard";

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

function renderCard() {
	render(
		<ChatApprovalCard
			approvalId="authority-sess-1-call-1"
			stepId="authority-call-1"
			reason='HIGH RISK: Allow "fabric_execute_workflow" to run once in Fabric?'
			executionId="orch-1"
		/>,
	);
}

function approveRespondsWith(status: number, body: Record<string, unknown>) {
	global.fetch = vi.fn(async () => ({
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	})) as unknown as typeof fetch;
}

describe("ChatApprovalCard", () => {
	const originalFetch = global.fetch;
	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it("says calmly that a card the run no longer waits on is stale", async () => {
		approveRespondsWith(409, {
			error: "This approval is no longer pending.",
			code: "APPROVAL_NOT_PENDING",
		});
		renderCard();

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
		});

		const message = "This approval was already answered or has expired.";
		expect(toast.info).toHaveBeenCalledWith(message);
		expect(toast.error).not.toHaveBeenCalled();
		expect(screen.getByText(message)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
	});

	it("tells the person when the answer could not be sent, and keeps the card", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		approveRespondsWith(500, { error: "Temporal unavailable" });
		renderCard();

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /Reject/ }));
		});

		expect(toast.error).toHaveBeenCalledWith("Failed to send rejection");
		expect(screen.getByRole("button", { name: /Approve/ })).toBeTruthy();
	});

	it("names the approval it answers", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			json: async () => ({ success: true }),
		}));
		global.fetch = fetchMock as unknown as typeof fetch;
		render(
			<ChatApprovalCard
				approvalId="authority-sess-1-call-1"
				stepId="authority-call-1"
				reason='HIGH RISK: Allow "fabric_execute_workflow" to run once in Fabric?'
				executionId="orch-1"
			/>,
		);

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/agents/fabric-ai/orchestrator-temporal/approve",
			expect.objectContaining({ method: "POST" }),
		);
		const [, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(JSON.parse(String(init.body))).toEqual({
			executionId: "orch-1",
			approved: true,
			approvalId: "authority-sess-1-call-1",
		});
	});

	it("answers through its host when given one, with the feedback, and never calls the route", async () => {
		const fetchMock = vi.fn();
		global.fetch = fetchMock as unknown as typeof fetch;
		const onRespond = vi.fn(async () => "sent" as const);
		render(
			<ChatApprovalCard
				approvalId="agent-2:approval-1"
				stepId="step-1"
				reason="Send the email?"
				onRespond={onRespond}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: /Add feedback/ }));
		fireEvent.change(screen.getByLabelText("Approval feedback"), {
			target: { value: " Today only. " },
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /Reject/ }));
		});

		expect(onRespond).toHaveBeenCalledWith({
			approved: false,
			feedback: "Today only.",
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(screen.getByText("Rejection accepted.")).toBeTruthy();
	});
});
