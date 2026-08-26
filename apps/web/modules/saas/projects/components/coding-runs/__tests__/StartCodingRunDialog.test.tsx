import { render, screen } from "@testing-library/react";
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
});
