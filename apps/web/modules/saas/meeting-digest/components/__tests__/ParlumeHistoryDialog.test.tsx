import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParlumeHistoryDialog } from "../ParlumeHistoryDialog";

const history = vi.hoisted(() => vi.fn());
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { parlume: { history } } },
}));
beforeEach(() =>
	history.mockReset().mockResolvedValue({ items: [], nextCursor: null }),
);
afterEach(cleanup);
function show() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	render(
		<QueryClientProvider client={client}>
			<ParlumeHistoryDialog projectId="project" />
		</QueryClientProvider>,
	);
}
describe("Parlume history", () => {
	it("fetches only on open and returns keyboard focus when dismissed", async () => {
		show();
		expect(history).not.toHaveBeenCalled();
		const user = userEvent.setup();
		await user.tab();
		await user.keyboard("{Enter}");
		expect(
			await screen.findByText("No Parlume requests yet."),
		).toBeInTheDocument();
		expect(history).toHaveBeenCalledWith({
			projectId: "project",
			before: undefined,
		});
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(
			screen.getByRole("button", { name: "Parlume history" }),
		).toHaveFocus();
	});
	it("shows requester, original question, exact proposal and uncertain outcome", async () => {
		const now = new Date();
		history.mockResolvedValue({
			items: [
				{
					id: "turn",
					speakerName: "Alex",
					createdAt: now,
					requestText: "Create a ticket",
					responseText: "Please confirm.",
					status: "COMPLETED",
					session: {
						agentLabel: "Project assistant",
						toolsReadOnly: false,
					},
					actions: [
						{
							id: "action",
							summary: "Create the review ticket",
							arguments: {
								title: "Review",
								projectId: "project",
							},
							status: "OUTCOME_UNKNOWN",
							createdAt: now,
							expiresAt: now,
							confirmedAt: now,
							completedAt: now,
							outcome:
								"Check the destination before trying again.",
						},
					],
				},
			],
			nextCursor: null,
		});
		show();
		fireEvent.click(
			screen.getByRole("button", { name: "Parlume history" }),
		);
		expect(await screen.findByText("Alex")).toBeInTheDocument();
		expect(screen.getByText("Create a ticket")).toBeInTheDocument();
		fireEvent.click(screen.getByText("Action · outcome unknown"));
		expect(screen.getByLabelText("Exact action details")).toHaveTextContent(
			'"title": "Review"',
		);
		expect(
			screen.getByText("Check the destination before trying again."),
		).toBeVisible();
	});
});
