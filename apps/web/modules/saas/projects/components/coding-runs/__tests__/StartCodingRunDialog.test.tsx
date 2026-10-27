import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UserStory } from "../../../lib/stories/types";
import { StartCodingRunDialog } from "../StartCodingRunDialog";

const story = {
	id: "story_1",
	identifier: "US-1",
	title: "User registration",
	description: "Allow users to register",
	acceptanceCriteria: "- user can sign up",
	tasks: [
		{
			id: "task_1",
			identifier: "TASK-1",
			title: "Build form",
			isCompleted: false,
			order: 0,
			repositoryUrl: null,
			repositoryOwner: null,
			repositoryName: null,
			targetBranch: null,
			latestCodingRun: null,
		},
	],
} as unknown as UserStory;

describe("StartCodingRunDialog", () => {
	it("explains missing repository context and blocks direct start", () => {
		render(
			<StartCodingRunDialog
				open
				onOpenChange={vi.fn()}
				story={story}
				onConfirm={vi.fn()}
			/>,
		);

		expect(screen.getByText("Repository required")).toBeInTheDocument();
		expect(
			screen.getByText(
				/Direct implementation sessions need a connected project repository/i,
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: "Start implementation session",
			}),
		).toBeDisabled();
	});

	it("allows selecting a Fabric Agents backend connection and passes it to onConfirm", () => {
		const onConfirm = vi.fn();

		render(
			<StartCodingRunDialog
				open
				onOpenChange={vi.fn()}
				story={story}
				repositoryOwner="acme"
				repositoryName="fabric"
				defaultBranch="main"
				onConfirm={onConfirm}
			/>,
		);

		expect(screen.getByText("Send to Fabric Agents")).toBeInTheDocument();

		const select = screen.getByLabelText("Agent backend");
		fireEvent.change(select, { target: { value: "codex" } });

		fireEvent.click(
			screen.getByRole("button", {
				name: "Start implementation session",
			}),
		);

		expect(onConfirm).toHaveBeenCalledWith({ llmConnection: "codex" });
	});

	it("allows assigning a specific primary task, updates effective repository/branch from task, and displays setup instructions", () => {
		const onConfirm = vi.fn();
		const storyWithTaskRepo = {
			...story,
			tasks: [
				{
					id: "task_1",
					identifier: "TASK-1",
					title: "Build form",
					isCompleted: false,
					order: 0,
					repositoryUrl: "https://github.com/acme/sub-service",
					repositoryOwner: "acme",
					repositoryName: "sub-service",
					targetBranch: "release/2026.10",
					latestCodingRun: null,
				},
			],
		} as unknown as UserStory;

		render(
			<StartCodingRunDialog
				open
				onOpenChange={vi.fn()}
				story={storyWithTaskRepo}
				onConfirm={onConfirm}
			/>,
		);

		expect(
			screen.getByText(/How setup & PR execution works/i),
		).toBeInTheDocument();
		// Initially blocked because project has no repo and no task is selected yet
		expect(
			screen.getByRole("button", {
				name: "Start implementation session",
			}),
		).toBeDisabled();

		const taskButton = screen.getByRole("button", {
			name: /TASK-1.*Build form/i,
		});
		fireEvent.click(taskButton);

		// Selecting TASK-1 resolves acme/sub-service and release/2026.10
		expect(screen.getByText("acme/sub-service")).toBeInTheDocument();
		expect(
			screen.getByText("Target branch: release/2026.10"),
		).toBeInTheDocument();

		const startButton = screen.getByRole("button", {
			name: "Start implementation session",
		});
		expect(startButton).not.toBeDisabled();
		fireEvent.click(startButton);

		expect(onConfirm).toHaveBeenCalledWith({ taskId: "task_1" });
	});
});
