import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConfidenceChip } from "../ConfidenceChip";

describe("ConfidenceChip", () => {
	it("renders the level as visible text (not color alone)", () => {
		render(<ConfidenceChip confidence={0.9} />);
		// The level word is rendered as text — meaning never rests on color.
		expect(screen.getByText("High")).toBeInTheDocument();
	});

	it("exposes the full confidence label to assistive tech", () => {
		render(<ConfidenceChip confidence={0.6} />);
		expect(screen.getByLabelText("Medium confidence")).toBeInTheDocument();
	});

	it("renders Low for a low confidence float", () => {
		render(<ConfidenceChip confidence={0.2} />);
		expect(screen.getByText("Low")).toBeInTheDocument();
	});

	it("renders nothing for a legacy row with no confidence", () => {
		const { container } = render(<ConfidenceChip confidence={null} />);
		expect(container).toBeEmptyDOMElement();
	});
});
