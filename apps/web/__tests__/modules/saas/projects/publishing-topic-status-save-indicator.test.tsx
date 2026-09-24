import { TopicStatusSaveIndicator } from "@saas/projects/components/publishing-suite/TopicStatusSaveIndicator";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const STATES = ["idle", "saving", "saved", "error"] as const;

describe("TopicStatusSaveIndicator", () => {
	it("is an always-mounted, empty polite live region at rest", () => {
		render(<TopicStatusSaveIndicator state="idle" />);
		const region = screen.getByRole("status");
		expect(region).toHaveAttribute("aria-live", "polite");
		// Not `toHaveTextContent("")`: that also passes for an icon with no
		// text, and at rest the region must hold nothing at all.
		expect(region).toBeEmptyDOMElement();
	});

	it.each([
		["saving", "Saving…"],
		["saved", "Saved"],
		["error", "Not saved"],
	] as const)("says %s in words", (state, text) => {
		render(<TopicStatusSaveIndicator state={state} />);
		expect(screen.getByRole("status")).toHaveTextContent(text);
	});

	// jsdom has no layout: these pin the classes that keep the box one size
	// whatever it holds, so the status control beside it never moves.
	it.each(STATES)(
		"with reserveWidth, holds a fixed, non-wrapping slot from sm up (%s)",
		(state) => {
			render(<TopicStatusSaveIndicator state={state} reserveWidth />);
			const region = screen.getByRole("status");
			expect(region).toHaveClass(
				"sm:w-20",
				"shrink-0",
				"whitespace-nowrap",
			);
			// Never below sm: the Inbox control is full-width there, and a
			// fixed slot would squeeze it too narrow for "In progress".
			expect(region).not.toHaveClass("w-20");
		},
	);

	it.each(STATES)(
		"without reserveWidth, reserves no slot but still never wraps (%s)",
		(state) => {
			render(<TopicStatusSaveIndicator state={state} />);
			const region = screen.getByRole("status");
			expect(region).not.toHaveClass("sm:w-20");
			expect(region).toHaveClass("whitespace-nowrap");
		},
	);
});
