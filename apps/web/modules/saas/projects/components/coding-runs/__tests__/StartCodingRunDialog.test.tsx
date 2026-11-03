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
			screen.getByText(
				/Your selected server creates an isolated worktree/i,
			),
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

	it("allows selecting a pre-configured harness model and choosing organization paid API fallback", () => {
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

		fireEvent.change(screen.getByLabelText("Agent backend"), {
			target: { value: "claude-max" },
		});
		fireEvent.change(screen.getByLabelText("Agent model"), {
			target: { value: "claude-opus-5-5" },
		});
		fireEvent.click(
			screen.getByRole("radio", {
				name: /Prefer organization’s paid API provider/i,
			}),
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Start implementation session",
			}),
		);

		expect(onConfirm).toHaveBeenCalledWith({
			llmConnection: "claude-max",
			model: "claude-opus-5-5",
			fallbackPolicy: "org_paid_api",
		});
	});

	it("renders 1-click Fabric Desktop deep links for new session and AI connections and updates link with selected subscription harness", () => {
		render(
			<StartCodingRunDialog
				open
				onOpenChange={vi.fn()}
				story={story}
				projectId="proj_123"
				repositoryOwner="acme"
				repositoryName="fabric"
				defaultBranch="main"
				bridgeEnabled={false}
				onConfirm={vi.fn()}
			/>,
		);

		// Even when bridgeEnabled={false}, subscription harness & model remain selectable for Fabric Agents Desktop
		const backendSelect = screen.getByLabelText("Agent backend");
		expect(backendSelect).not.toBeDisabled();
		fireEvent.change(backendSelect, { target: { value: "claude-max" } });

		const modelSelect = screen.getByLabelText("Agent model");
		expect(modelSelect).not.toBeDisabled();
		fireEvent.change(modelSelect, { target: { value: "claude-opus-5-5" } });

		const desktopLink = screen.getByTestId("dialog-launch-fabric-desktop");
		const href = desktopLink.getAttribute("href") ?? "";
		expect(href).toContain("fabricagents://action/new-chat?");
		expect(href).toContain("projectId=proj_123");
		expect(href).toContain("harness=claude-max");
		expect(href).toContain("model=claude-opus-5-5");
		expect(href).toContain("fallback=subscription_harnesses");

		const aiSettingsLink = screen.getByTestId(
			"dialog-fabric-desktop-ai-settings",
		);
		expect(aiSettingsLink).toHaveAttribute(
			"href",
			"fabricagents://settings",
		);
	});

	it("copies the MCP task prompt without any hardcoded agents.example.com hostname", () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, {
			clipboard: { writeText },
		});

		render(
			<StartCodingRunDialog
				open
				onOpenChange={vi.fn()}
				story={story}
				repositoryOwner="acme"
				repositoryName="fabric"
				defaultBranch="main"
				onConfirm={vi.fn()}
			/>,
		);

		expect(
			screen.getByText(
				/Assign to Fabric Agents Desktop or Subscription CLI/i,
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/Prefer to run Claude Code, Codex, Cursor, Antigravity, or Fabric Desktop directly\?/i,
			),
		).toBeInTheDocument();
		expect(document.body.textContent).not.toContain("agents.example.com");

		const copyBtn = screen.getByTestId("dialog-copy-mcp-prompt");
		fireEvent.click(copyBtn);

		expect(writeText).toHaveBeenCalledTimes(1);
		const copiedPrompt = writeText.mock.calls[0]?.[0] as string;
		expect(copiedPrompt).toContain(
			'Implement feature US-1 ("User registration")',
		);
		expect(copiedPrompt).toContain("fabric_complete_task");
		expect(copiedPrompt).not.toContain("agents.example.com");
	});
});
