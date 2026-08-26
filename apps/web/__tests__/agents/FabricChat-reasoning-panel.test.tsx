import { TrajectorySteps } from "@saas/agents/components/FabricChat/TrajectorySteps";
import { deriveTrajectorySteps } from "@saas/agents/lib/derive-trajectory";
import type { DirectStreamMessage } from "@saas/agents/hooks/useDirectStream";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

describe("Reasoning panel for assistant messages", () => {
	it("renders a collapsible Reasoning Trace header for assistant messages with tool calls", async () => {
		const steps = deriveTrajectorySteps({
			id: "m1",
			role: "assistant",
			content: "Found 3 hits.",
			timestamp: new Date("2026-05-13T10:00:00Z"),
			isStreaming: false,
			toolCalls: [
				{
					id: "t1",
					name: "search_codebase",
					args: { query: "auth" },
					status: "complete",
				},
			],
		});

		render(<TrajectorySteps steps={steps} />);

		expect(screen.getByText(/reasoning trace/i)).toBeInTheDocument();
		expect(
			screen.queryByText(/Searched codebase/i),
		).not.toBeInTheDocument();

		await userEvent.click(screen.getByText(/reasoning trace/i));
		expect(screen.getByText(/Searched codebase/i)).toBeInTheDocument();
	});

	it("renders nothing when there are no steps", () => {
		const { container } = render(<TrajectorySteps steps={[]} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("marks error tool results so the user can see what was skipped", async () => {
		const steps = deriveTrajectorySteps({
			id: "m2",
			role: "assistant",
			content: "Could not access codebase.",
			timestamp: new Date("2026-05-13T10:00:00Z"),
			isStreaming: false,
			toolCalls: [
				{
					id: "t1",
					name: "fetch_url",
					args: { url: "https://x" },
					status: "error",
					result: "permission denied",
				},
			],
		});

		render(<TrajectorySteps steps={steps} defaultExpanded />);
		expect(screen.getByText("1 errors")).toBeInTheDocument();
	});
});

describe("Reasoning panel — thinking step rendering", () => {
	it("renders the full reasoning text as markdown without 200-char truncation", () => {
		const longReasoning =
			"I should first check the auth middleware.\n\n" +
			"Then I'll query the workspace for related stories.\n\n" +
			"Finally, I'll summarise the findings into 3 bullets.";
		render(
			<TrajectorySteps
				defaultExpanded
				steps={[
					{
						id: "t1",
						type: "thinking",
						title: "Thought",
						description: longReasoning,
						status: "success",
					},
				]}
			/>,
		);
		// All three sentences are visible (not truncated to 200 chars).
		expect(
			screen.getByText(/check the auth middleware/i),
		).toBeInTheDocument();
		expect(
			screen.getByText(/summarise the findings into 3 bullets/i),
		).toBeInTheDocument();
	});

	it("shows 'Thinking…' with running status while still streaming", () => {
		render(
			<TrajectorySteps
				defaultExpanded
				steps={[
					{
						id: "t1",
						type: "thinking",
						title: "Thinking…",
						description: "partial…",
						status: "running",
					},
				]}
			/>,
		);
		expect(screen.getByText("Thinking…")).toBeInTheDocument();
	});

	it("shows 'Thought for X.Ys' when duration flows from DirectStreamMessage through deriveTrajectorySteps", () => {
		// Full-pipeline test (Codex Finding 3): drive the mapper, then render.
		// This supplements (or can replace) the hand-built step fixture below.
		const msg: DirectStreamMessage = {
			id: "m1",
			role: "assistant",
			content: "The answer is 42.",
			timestamp: new Date(),
			isStreaming: false,
			toolCalls: [],
			reasoningText: "I computed 6 × 7.",
			reasoningDurationMs: 2400,
		};
		const steps = deriveTrajectorySteps(msg);
		render(<TrajectorySteps defaultExpanded steps={steps} />);
		expect(screen.getByText(/Thought for 2\.4s/)).toBeInTheDocument();
	});

	it("shows 'Thought for X.Ys' when duration is provided via hand-built step", () => {
		render(
			<TrajectorySteps
				defaultExpanded
				steps={[
					{
						id: "t1",
						type: "thinking",
						title: "Thought",
						description: "done",
						status: "success",
						duration: 2400,
					},
				]}
			/>,
		);
		expect(screen.getByText(/Thought for 2\.4s/)).toBeInTheDocument();
	});
});
