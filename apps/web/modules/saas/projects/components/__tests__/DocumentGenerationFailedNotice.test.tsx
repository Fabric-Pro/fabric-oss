/**
 * Regression test for the Business Case QA finding (AC-7): a document whose
 * AI generation FAILED was rendered as an empty document labeled "Saved" with
 * no error surfaced to the user. `DocumentEditor` only reacted to the local
 * `isRegenerating` flag and never read the document's server-side `status` /
 * `generationError`. This notice is what the editor now renders when the
 * persisted document status is FAILED, so it must: surface the failure, show
 * the server-provided reason when present, and offer a retry action.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DocumentGenerationFailedNotice } from "../DocumentGenerationFailedNotice";

describe("DocumentGenerationFailedNotice", () => {
	it("surfaces that generation failed", () => {
		render(
			<DocumentGenerationFailedNotice error={null} onRetry={vi.fn()} />,
		);
		expect(screen.getByText(/generation failed/i)).toBeInTheDocument();
	});

	it("shows the server-provided failure reason when present", () => {
		render(
			<DocumentGenerationFailedNotice
				error="Fallback generation produced empty content"
				onRetry={vi.fn()}
			/>,
		);
		expect(
			screen.getByText(/Fallback generation produced empty content/i),
		).toBeInTheDocument();
	});

	it("invokes onRetry when the regenerate action is clicked", async () => {
		const onRetry = vi.fn();
		render(
			<DocumentGenerationFailedNotice error={null} onRetry={onRetry} />,
		);
		await userEvent.click(
			screen.getByRole("button", { name: /regenerate/i }),
		);
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("disables the retry action while retrying", () => {
		render(
			<DocumentGenerationFailedNotice
				error={null}
				onRetry={vi.fn()}
				isRetrying
			/>,
		);
		expect(
			screen.getByRole("button", { name: /regenerat/i }),
		).toBeDisabled();
	});
});
