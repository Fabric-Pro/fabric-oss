import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
	DocumentGenerationProgress,
	getGenerationStage,
} from "../DocumentGenerationProgress";

describe("DocumentGenerationProgress", () => {
	it("renders queued badge and step 1 description when progress is 0", () => {
		render(
			<DocumentGenerationProgress
				status="GENERATING"
				progress={0}
				title="System Architecture Spec"
			/>,
		);

		expect(screen.getByText("Queued in Job Queue")).toBeInTheDocument();
		expect(
			screen.getByText("System Architecture Spec"),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Step 1 of 4: Queued in Job Queue/i),
		).toBeInTheDocument();
		expect(screen.getByText("0%")).toBeInTheDocument();
	});

	it("renders the preserved reassurance message", () => {
		render(
			<DocumentGenerationProgress
				status="GENERATING"
				progress={15}
				title="PRD Document"
			/>,
		);

		expect(
			screen.getByText(
				/This will take a few minutes\. Please wait while we generate your document\.\.\./i,
			),
		).toBeInTheDocument();
	});

	it("renders in-progress badge, percentage, and AI drafting stage when progress is 35", () => {
		render(
			<DocumentGenerationProgress
				status="GENERATING"
				progress={35}
				title="API Design Document"
			/>,
		);

		expect(screen.getByText("In Progress (35%)")).toBeInTheDocument();
		expect(
			screen.getByText(/Step 3 of 4: Drafting Content/i),
		).toBeInTheDocument();
		expect(screen.getByText("35%")).toBeInTheDocument();
		expect(
			screen.getByText(
				/AI agent is analyzing context and drafting document sections/i,
			),
		).toBeInTheDocument();
	});

	it("renders finalizing stage when progress is 85", () => {
		render(
			<DocumentGenerationProgress
				status="GENERATING"
				progress={85}
				title="Security Architecture"
			/>,
		);

		expect(screen.getByText("In Progress (85%)")).toBeInTheDocument();
		expect(
			screen.getByText(/Step 4 of 4: Finalizing Document/i),
		).toBeInTheDocument();
		expect(screen.getByText("85%")).toBeInTheDocument();
	});

	it("renders complete badge when status is COMPLETE or progress is 100", () => {
		render(
			<DocumentGenerationProgress
				status="COMPLETE"
				progress={100}
				title="Complete Document"
			/>,
		);

		expect(screen.getByText("Complete")).toBeInTheDocument();
		expect(screen.getByText("100%")).toBeInTheDocument();
	});

	it("renders failed state and triggers onRetry when clicked", async () => {
		const onRetry = vi.fn();
		render(
			<DocumentGenerationProgress
				status="FAILED"
				progress={0}
				error="Temporal workflow timed out"
				onRetry={onRetry}
			/>,
		);

		expect(screen.getByText("Failed")).toBeInTheDocument();
		expect(
			screen.getByText("Temporal workflow timed out"),
		).toBeInTheDocument();

		const retryButton = screen.getByRole("button", {
			name: /Retry Generation/i,
		});
		expect(retryButton).toBeInTheDocument();
		await userEvent.click(retryButton);
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("disables retry button when isRetrying is true", () => {
		render(
			<DocumentGenerationProgress
				status="FAILED"
				progress={0}
				error="Error"
				onRetry={vi.fn()}
				isRetrying
			/>,
		);

		const retryButton = screen.getByRole("button", {
			name: /Retry Generation/i,
		});
		expect(retryButton).toBeDisabled();
	});

	it("renders regenerating title when isRegenerating is true", () => {
		render(
			<DocumentGenerationProgress
				status="GENERATING"
				progress={20}
				isRegenerating
			/>,
		);

		expect(screen.getByText("Regenerating Document")).toBeInTheDocument();
	});

	it("renders dismiss button and calls onDismiss when clicked", async () => {
		const onDismiss = vi.fn();
		render(
			<DocumentGenerationProgress
				status="GENERATING"
				progress={20}
				onDismiss={onDismiss}
			/>,
		);

		const dismissButton = screen.getByRole("button", {
			name: /Dismiss progress overlay/i,
		});
		expect(dismissButton).toBeInTheDocument();
		await userEvent.click(dismissButton);
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it("renders staleness warning and retry/dismiss buttons when generation is older than 3 minutes", async () => {
		const onRetry = vi.fn();
		const onDismiss = vi.fn();
		const fourMinutesAgo = new Date(Date.now() - 4 * 60 * 1000);

		render(
			<DocumentGenerationProgress
				status="GENERATING"
				progress={20}
				generationStartedAt={fourMinutesAgo}
				onRetry={onRetry}
				onDismiss={onDismiss}
			/>,
		);

		expect(
			screen.getByText(/Generation is taking longer than expected/i),
		).toBeInTheDocument();

		const dismissToEditor = screen.getByRole("button", {
			name: /Dismiss to Editor/i,
		});
		await userEvent.click(dismissToEditor);
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it("renders staleness warning and retry/dismiss buttons when updatedAt is older than 3 minutes (fallback)", async () => {
		const onRetry = vi.fn();
		const onDismiss = vi.fn();
		const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

		render(
			<DocumentGenerationProgress
				status="GENERATING"
				progress={0}
				generationStartedAt={null}
				updatedAt={fiveMinutesAgo}
				onRetry={onRetry}
				onDismiss={onDismiss}
			/>,
		);

		expect(
			screen.getByText(/Generation is taking longer than expected/i),
		).toBeInTheDocument();
	});

	it("does not render staleness warning when generation is fresh (< 3 minutes)", () => {
		const oneMinuteAgo = new Date(Date.now() - 1 * 60 * 1000);
		render(
			<DocumentGenerationProgress
				status="GENERATING"
				progress={20}
				generationStartedAt={oneMinuteAgo}
			/>,
		);

		expect(
			screen.queryByText(/Generation is taking longer than expected/i),
		).not.toBeInTheDocument();
	});

	it("does not render staleness warning when status is COMPLETE or FAILED even if timestamp is old", () => {
		const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
		const { rerender } = render(
			<DocumentGenerationProgress
				status="COMPLETE"
				progress={100}
				generationStartedAt={tenMinutesAgo}
			/>,
		);

		expect(
			screen.queryByText(/Generation is taking longer than expected/i),
		).not.toBeInTheDocument();

		rerender(
			<DocumentGenerationProgress
				status="FAILED"
				progress={0}
				error="Failed"
				generationStartedAt={tenMinutesAgo}
			/>,
		);

		expect(
			screen.queryByText(/Generation is taking longer than expected/i),
		).not.toBeInTheDocument();
	});

	it("correctly handles ISO string timestamps for staleness detection", () => {
		const fiveMinutesAgoISO = new Date(
			Date.now() - 5 * 60 * 1000,
		).toISOString();

		render(
			<DocumentGenerationProgress
				status="GENERATING"
				progress={20}
				generationStartedAt={fiveMinutesAgoISO}
			/>,
		);

		expect(
			screen.getByText(/Generation is taking longer than expected/i),
		).toBeInTheDocument();
	});

	it("clamps negative progress to 0% and overflow progress to 100%", () => {
		const { rerender } = render(
			<DocumentGenerationProgress status="GENERATING" progress={-15} />,
		);
		expect(screen.getByText("0%")).toBeInTheDocument();

		rerender(
			<DocumentGenerationProgress status="GENERATING" progress={125} />,
		);
		expect(screen.getByText("100%")).toBeInTheDocument();
		expect(screen.getByText("Complete")).toBeInTheDocument();
	});

	it("renders fallback title when title is omitted", () => {
		const { rerender } = render(
			<DocumentGenerationProgress status="GENERATING" progress={10} />,
		);
		expect(screen.getByText("Generating Document")).toBeInTheDocument();

		rerender(
			<DocumentGenerationProgress
				status="GENERATING"
				progress={10}
				isRegenerating
			/>,
		);
		expect(screen.getByText("Regenerating Document")).toBeInTheDocument();
	});

	it("renders fallback error message when status is FAILED and error is null or undefined", () => {
		render(<DocumentGenerationProgress status="FAILED" progress={0} />);
		expect(
			screen.getByText(
				"Document generation failed. No content could be produced.",
			),
		).toBeInTheDocument();
	});

	it("does not render dismiss button when onDismiss is omitted", () => {
		render(
			<DocumentGenerationProgress status="GENERATING" progress={10} />,
		);
		expect(
			screen.queryByRole("button", {
				name: /Dismiss progress overlay/i,
			}),
		).not.toBeInTheDocument();
	});

	describe("getGenerationStage helper", () => {
		it("returns queued stage when progress is 0", () => {
			const stage = getGenerationStage(0, "GENERATING");
			expect(stage.isQueued).toBe(true);
			expect(stage.step).toBe(1);
			expect(stage.label).toBe("Queued in Job Queue");
		});

		it("returns retrieving context stage for progress 15", () => {
			const stage = getGenerationStage(15, "GENERATING");
			expect(stage.isQueued).toBe(false);
			expect(stage.step).toBe(2);
			expect(stage.label).toBe("Retrieving Context");
		});

		it("returns drafting content stage for progress 50", () => {
			const stage = getGenerationStage(50, "GENERATING");
			expect(stage.isQueued).toBe(false);
			expect(stage.step).toBe(3);
			expect(stage.label).toBe("Drafting Content");
		});

		it("returns finalizing stage for progress 90", () => {
			const stage = getGenerationStage(90, "GENERATING");
			expect(stage.isQueued).toBe(false);
			expect(stage.step).toBe(4);
			expect(stage.label).toBe("Finalizing Document");
		});

		it("returns complete stage when status is COMPLETE even if progress < 100", () => {
			const stage = getGenerationStage(50, "COMPLETE");
			expect(stage.label).toBe("Generation Complete");
			expect(stage.step).toBe(4);
			expect(stage.isQueued).toBe(false);
		});
	});
});
