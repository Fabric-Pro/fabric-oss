import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UserStory } from "../../../lib/stories/types";
import { StartWorkButton } from "../StartWorkButton";

vi.mock("@saas/weave/components", () => ({
	ExecuteWithWeaveButton: () => null,
}));

vi.mock("../../coding-runs/StartImplementationSessionButton", () => ({
	StartImplementationSessionButton: () => null,
}));

const story = {
	id: "story_1",
	identifier: "US-1",
	title: "User registration",
	description: "Allow users to sign up",
	acceptanceCriteria: "- account created",
	tasks: [
		{
			id: "task_1",
			identifier: "TASK-1",
			title: "Build form",
			isCompleted: false,
			order: 0,
			latestCodingRun: null,
		},
	],
} as unknown as UserStory;

function renderStartWorkButton() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});

	return render(
		<QueryClientProvider client={client}>
			<StartWorkButton
				projectId="project_1"
				storyId="story_1"
				story={story}
				repositoryOwner="acme"
				repositoryName="fabric"
			/>
		</QueryClientProvider>,
	);
}

describe("StartWorkButton", () => {
	it("shows Fabric Agents Remote Server and Fabric Agents Desktop options with clear descriptions", async () => {
		const user = userEvent.setup();
		renderStartWorkButton();

		await user.click(screen.getByRole("button", { name: /Start work/i }));

		expect(screen.getByText(/Plan with Weave/i)).toBeInTheDocument();
		expect(
			screen.getByText(/^Fabric Agents Remote Server$/i),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Fabric Agents Desktop & Subscription CLI/i),
		).toBeInTheDocument();
		expect(
			screen.getByText(/isolated git worktree on Fabric Agents/i),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/Personal or Organization Fabric Agents Remote Server/i,
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Powered by Fabric Agents Desktop/i),
		).toBeInTheDocument();
		expect(screen.queryByText(/Fabric Kanban/i)).not.toBeInTheDocument();
	});
});
