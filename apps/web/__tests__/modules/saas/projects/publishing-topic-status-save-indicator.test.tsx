import { TopicStatusSaveIndicator } from "@saas/projects/components/publishing-suite/TopicStatusSaveIndicator";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("TopicStatusSaveIndicator", () => {
	it("is an always-mounted, empty polite live region at rest", () => {
		render(<TopicStatusSaveIndicator state="idle" />);
		const region = screen.getByRole("status");
		expect(region).toHaveAttribute("aria-live", "polite");
		expect(region).toHaveTextContent("");
	});

	it.each([
		["saving", "Saving…"],
		["saved", "Saved"],
		["error", "Not saved"],
	] as const)("says %s in words", (state, text) => {
		render(<TopicStatusSaveIndicator state={state} />);
		expect(screen.getByRole("status")).toHaveTextContent(text);
	});
});
