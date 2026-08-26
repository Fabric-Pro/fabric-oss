import type { Storyline } from "@repo/database";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StorylinesPanel } from "../StorylinesPanel";

describe("StorylinesPanel", () => {
	it("renders nothing when storylines is empty", () => {
		const { container } = render(<StorylinesPanel storylines={[]} />);
		expect(container.firstChild).toBeNull();
	});

	it("renders headlines and narratives", () => {
		const storylines: Storyline[] = [
			{
				storyCuid: "s1",
				storyIdentifier: "F-12",
				headline: "Refund split moved forward",
				narrative: "Decision on Mon led to PR #412 and a doc update.",
				relatedItems: [],
			},
		];
		render(<StorylinesPanel storylines={storylines} />);
		expect(
			screen.getByText("Refund split moved forward"),
		).toBeInTheDocument();
		expect(screen.getByText(/Decision on Mon/)).toBeInTheDocument();
		expect(screen.getByText("F-12")).toBeInTheDocument();
	});
});
