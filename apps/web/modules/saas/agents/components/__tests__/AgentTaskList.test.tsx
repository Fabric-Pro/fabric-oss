/**
 * Agents > Execution History: an agent's tasks and the sessions that carry an
 * execution, newest first. With no agent chosen it lists the caller's sessions
 * across every agent; sessions are read a page at a time by cursor.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	tasksList: vi.fn(),
	conversationsList: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agents: {
			tasks: { list: mocks.tasksList },
			conversations: { list: mocks.conversationsList },
		},
	},
}));

vi.mock("@saas/agents/hooks/useAgentLabel", () => ({
	useAgentLabel: () => (agentId: string) => agentId,
}));

import { AgentTaskList } from "../AgentTaskList";

const session = (id: string, userMessage: string, agentId = "agent-a") => ({
	id,
	agentId,
	title: null,
	createdAt: "2026-10-14T09:00:00.000Z",
	updatedAt: "2026-10-14T10:00:00.000Z",
	lastMessage: null,
	metadata: {
		mode: "orchestrator",
		executions: [
			{
				id: `${id}-e`,
				userMessage,
				status: "running",
				startedAt: "2026-10-14T09:30:00.000Z",
			},
		],
	},
});

function renderList(props: React.ComponentProps<typeof AgentTaskList> = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<AgentTaskList {...props} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.tasksList.mockResolvedValue([]);
	mocks.conversationsList.mockResolvedValue({
		conversations: [session("c1", "Plan the quarter")],
	});
});

describe("the sessions in the execution history", () => {
	it("lists the caller's sessions across every agent when none is chosen, by cursor and with no offset", async () => {
		renderList({ organizationId: "org-1" });

		expect(await screen.findByText("Plan the quarter")).toBeInTheDocument();
		expect(mocks.conversationsList).toHaveBeenCalledTimes(1);
		const request = mocks.conversationsList.mock.calls[0][0];
		expect(request).toEqual({
			limit: 100,
			status: "ACTIVE",
			organizationId: "org-1",
		});
		expect(request).not.toHaveProperty("agentId");
		expect(request).not.toHaveProperty("offset");
	});

	it("narrows the sessions to the agent that is chosen", async () => {
		renderList({ organizationId: "org-1", agentId: "agent-a" });

		await screen.findByText("Plan the quarter");

		expect(mocks.conversationsList.mock.calls[0][0]).toMatchObject({
			agentId: "agent-a",
		});
		expect(mocks.tasksList.mock.calls[0][0]).toMatchObject({
			agentId: "agent-a",
		});
	});

	it("reads on by cursor and shows the sessions of every page", async () => {
		mocks.conversationsList
			.mockResolvedValueOnce({
				conversations: [session("c1", "Plan the quarter")],
				nextCursor: "cursor-1",
			})
			.mockResolvedValueOnce({
				conversations: [session("c2", "Review the backlog", "agent-b")],
			});

		renderList();

		expect(await screen.findByText("Plan the quarter")).toBeInTheDocument();
		expect(screen.getByText("Review the backlog")).toBeInTheDocument();
		expect(mocks.conversationsList).toHaveBeenCalledTimes(2);
		expect(mocks.conversationsList.mock.calls[1][0]).toMatchObject({
			cursor: "cursor-1",
		});
		expect(mocks.conversationsList.mock.calls[0][0]).not.toHaveProperty(
			"cursor",
		);
	});

	it("stops after five pages, so a long history does not cost a request per page on every refresh", async () => {
		mocks.conversationsList.mockImplementation(async () => ({
			conversations: [session("c1", "Plan the quarter")],
			nextCursor: "more",
		}));

		renderList();

		await screen.findAllByText("Plan the quarter");
		await waitFor(() =>
			expect(mocks.conversationsList).toHaveBeenCalledTimes(5),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(mocks.conversationsList).toHaveBeenCalledTimes(5);
	});

	it("says it is showing the first 500 when the history is longer than the pages it reads", async () => {
		mocks.conversationsList.mockImplementation(async () => ({
			conversations: [session("c1", "Plan the quarter")],
			nextCursor: "more",
		}));

		renderList();

		expect(
			await screen.findByText("Showing the first 500 conversations."),
		).toBeInTheDocument();
	});

	it("says nothing about a cap when the whole history was read", async () => {
		renderList();

		await screen.findByText("Plan the quarter");

		expect(screen.queryByText(/Showing the first/)).toBeNull();
		expect(screen.queryByText(/could not be loaded/)).toBeNull();
	});

	it("keeps the pages already read when a later page fails, and says the history may be incomplete", async () => {
		mocks.conversationsList
			.mockResolvedValueOnce({
				conversations: [session("c1", "Plan the quarter")],
				nextCursor: "cursor-1",
			})
			.mockRejectedValueOnce(new Error("offline"));
		vi.spyOn(console, "warn").mockImplementation(() => {});

		renderList();

		expect(await screen.findByText("Plan the quarter")).toBeInTheDocument();
		expect(
			screen.getByText(/Some conversations could not be loaded/),
		).toBeInTheDocument();
		expect(screen.queryByText(/Showing the first/)).toBeNull();
	});

	it("does not call a history that failed to load an empty one", async () => {
		mocks.conversationsList.mockRejectedValue(new Error("offline"));
		vi.spyOn(console, "warn").mockImplementation(() => {});

		renderList();

		expect(
			await screen.findByText(/Some conversations could not be loaded/),
		).toBeInTheDocument();
		expect(screen.queryByText("No History Found")).toBeNull();
	});

	it("still says there is no history when nothing failed and nothing is there", async () => {
		mocks.conversationsList.mockResolvedValue({ conversations: [] });

		renderList();

		expect(await screen.findByText("No History Found")).toBeInTheDocument();
	});

	it("still shows the tasks when the sessions cannot be read", async () => {
		mocks.conversationsList.mockRejectedValue(new Error("offline"));
		mocks.tasksList.mockResolvedValue([
			{
				id: "t1",
				agentId: "agent-a",
				status: "running",
				stage: "Indexing",
				createdAt: "2026-10-14T09:00:00.000Z",
				completedAt: null,
				error: null,
			},
		]);
		vi.spyOn(console, "warn").mockImplementation(() => {});

		renderList();

		expect(await screen.findByText("Stage: Indexing")).toBeInTheDocument();
	});
});
