import { detailOf } from "../../../../../../../../../packages/api/modules/agents/procedures/conversations/conversation-view";
/**
 * A conversation someone else shared: read-only, with one way on, a chat of the
 * reader's own.
 */
import { FABRIC_AGENT_ID } from "@repo/utils/page-limits";
import type { ConversationDetail } from "@saas/agents/lib/conversation-list";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	continueInNewChat: vi.fn(),
	toast: { error: vi.fn() },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agents: {
			conversations: { continueInNewChat: mocks.continueInNewChat },
		},
	},
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("../../../../../../../components/ai-elements/response", () => ({
	Response: ({ children }: { children?: string }) => (
		<div data-testid="markdown">{children}</div>
	),
}));

import type { ChatEngine } from "@saas/agents/lib/interface-mode-engine";
import { SharedSessionView } from "../SharedSessionView";

const conversation: ConversationDetail = {
	id: "shared-1",
	agentId: FABRIC_AGENT_ID,
	title: "Quarterly plan",
	messages: [
		{
			id: "m1",
			role: "user",
			content: "Plan the quarter.",
			timestamp: "2026-10-14T09:00:00.000Z",
		},
		{
			id: "m2",
			role: "assistant",
			content: "Here is **a plan**.",
			timestamp: "2026-10-14T09:01:00.000Z",
		},
		{
			id: "m3",
			role: "system",
			content: "operation result",
			timestamp: "2026-10-14T09:01:01.000Z",
		},
	],
	trajectory: null,
	metadata: { mode: "orchestrator" },
	pinned: false,
	status: "ACTIVE",
	createdAt: "2026-10-14T09:00:00.000Z",
	updatedAt: "2026-10-14T10:00:00.000Z",
	visibility: "ORGANIZATION",
	isOwn: false,
	owner: { id: "u2", name: "Sam Example" },
	parentConversationId: null,
	carriedOverSummary: null,
	carriedOverAt: null,
};

function renderView(
	overrides: Partial<ConversationDetail> = {},
	engine: ChatEngine = "direct",
) {
	const onContinue = vi.fn();
	const client = new QueryClient();
	const invalidate = vi.spyOn(client, "invalidateQueries");
	render(
		<QueryClientProvider client={client}>
			<SharedSessionView
				conversation={{ ...conversation, ...overrides }}
				organizationId="org-1"
				engine={engine}
				onContinue={onContinue}
			/>
		</QueryClientProvider>,
	);
	return { onContinue, invalidate };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("reading a shared conversation", () => {
	it("says whose it is, that it is read only, and shows the transcript as it was", () => {
		renderView();

		expect(
			screen.getByRole("heading", { name: "Quarterly plan" }),
		).toBeInTheDocument();
		expect(screen.getByText("Shared by Sam Example")).toBeInTheDocument();
		expect(screen.getByText("Read only")).toBeInTheDocument();
		expect(screen.getByText("Plan the quarter.")).toBeInTheDocument();
		expect(screen.getByTestId("markdown")).toHaveTextContent(
			"Here is **a plan**.",
		);
		expect(screen.getByText("Fabric Agent")).toBeInTheDocument();
	});

	it("leaves out the system rows the workflow records", () => {
		renderView();

		expect(screen.queryByText("operation result")).toBeNull();
	});

	it("names no tool, whatever the transcript carries", () => {
		renderView({
			messages: [
				{
					id: "m1",
					role: "assistant",
					content: "Done.",
					timestamp: "2026-10-14T09:01:00.000Z",
					toolCalls: [
						{ id: "t1", name: "fabric_list_projects", args: {} },
					],
				},
			],
		});

		expect(screen.queryByText(/fabric_list_projects/)).toBeNull();
		expect(screen.queryByText(/^Used /)).toBeNull();
	});

	it("offers nothing to send into it and nothing to approve", () => {
		renderView();

		expect(screen.queryByRole("textbox")).toBeNull();
		expect(
			screen.queryByRole("button", { name: /send|approve|allow/i }),
		).toBeNull();
		expect(
			screen.getAllByRole("button").map((button) => button.textContent),
		).toEqual(["Continue in my own chat"]);
	});

	it("can be scrolled from the keyboard, and says what it is", () => {
		renderView();

		const transcript = screen.getByRole("region", {
			name: "Shared conversation transcript",
		});
		expect(transcript).toHaveAttribute("tabindex", "0");
	});

	it("says so when there is nothing in it", () => {
		renderView({ messages: [] });

		expect(
			screen.getByText("This conversation has no messages yet."),
		).toBeInTheDocument();
	});

	it("says conversation, never session, and says whose permissions the new chat runs with", () => {
		renderView();

		expect(document.body.textContent).not.toMatch(/session/i);
		expect(screen.getByText(/not Sam Example's\./)).toBeInTheDocument();
	});
});

describe("continuing in a chat of the reader's own", () => {
	it("starts a new chat linked to the conversation and sends none of the transcript", async () => {
		mocks.continueInNewChat.mockResolvedValue({
			id: "mine-1",
			title: "Continuing: Quarterly plan",
		});
		const { onContinue } = renderView();

		await userEvent.click(
			screen.getByRole("button", { name: "Continue in my own chat" }),
		);

		await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
		expect(mocks.continueInNewChat).toHaveBeenCalledWith({
			organizationId: "org-1",
			parentConversationId: "shared-1",
			title: "Continuing: Quarterly plan",
		});
		expect(mocks.continueInNewChat.mock.calls[0][0]).not.toHaveProperty(
			"summary",
		);
	});

	it.each(["direct", "orchestrator", "research"] as const)(
		"hands over the new chat on the reader's %s engine, not the one the owner used",
		async (engine) => {
			mocks.continueInNewChat.mockResolvedValue({
				id: "mine-1",
				title: "Continuing: Quarterly plan",
			});
			const { onContinue } = renderView(
				{
					metadata: {
						mode: engine === "direct" ? "orchestrator" : "direct",
					},
				},
				engine,
			);

			await userEvent.click(
				screen.getByRole("button", { name: "Continue in my own chat" }),
			);

			await waitFor(() =>
				expect(onContinue).toHaveBeenCalledWith({
					id: "mine-1",
					title: "Continuing: Quarterly plan",
					engine,
				}),
			);
		},
	);

	it("refreshes every list of conversations, so the new chat shows in the page's list and the drawer's", async () => {
		mocks.continueInNewChat.mockResolvedValue({
			id: "mine-1",
			title: null,
		});
		const { invalidate } = renderView();

		await userEvent.click(
			screen.getByRole("button", { name: "Continue in my own chat" }),
		);

		await waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: ["agents", "conversations"],
			}),
		);
	});

	it("says it could not be started, without the server's words, and stays where it is", async () => {
		mocks.continueInNewChat.mockRejectedValue(
			new Error("Parent not found"),
		);
		const { onContinue } = renderView();

		await userEvent.click(
			screen.getByRole("button", { name: "Continue in my own chat" }),
		);

		await waitFor(() =>
			expect(mocks.toast.error).toHaveBeenCalledWith(
				"Could not start a chat from this conversation",
				{ description: "Please try again." },
			),
		);
		expect(onContinue).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "Continue in my own chat" }),
		).toBeEnabled();
	});
});

it("shows a projected clarification exchange with owner attribution", () => {
	const messages: ConversationDetail["messages"] = [
		{
			id: "clarification-1",
			role: "user",
			timestamp: new Date().toISOString(),
			content: "Clarification — Which branch?: staging",
			metadata: {
				clarification: { question: "Which branch?", answer: "staging" },
			},
		},
	];
	const projected = detailOf({
		...conversation,
		messages,
		userId: "example-owner",
		organizationId: "example-org",
		createdAt: new Date(conversation.createdAt),
		updatedAt: new Date(conversation.updatedAt),
		carriedOverAt: null,
		isOwn: false,
	});
	renderView(projected);
	const exchange = screen.getByRole("group", { name: "Clarifying question" });
	expect(exchange).toHaveTextContent("Advisor asked:");
	expect(exchange).toHaveTextContent("↳ Sam Example:");
	expect(screen.getByText("staging").closest(".is-user")).toBeNull();
	expect(screen.getByText("Which branch?")).toBeInTheDocument();
	expect(screen.getByText("staging")).toBeInTheDocument();
	expect(screen.getByText("Sam Example answered:")).toBeInTheDocument();
	expect(screen.queryByText("Your answer")).not.toBeInTheDocument();
	expect(
		screen.queryByText("Clarification — Which branch?: staging"),
	).not.toBeInTheDocument();
});
