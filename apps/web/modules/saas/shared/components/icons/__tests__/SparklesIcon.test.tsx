import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SparklesIcon } from "../SparklesIcon";

describe("SparklesIcon", () => {
	it("renders the decorative Genie emoji with SVG sizing", () => {
		render(<SparklesIcon data-testid="genie-icon" className="size-4" />);

		const icon = screen.getByTestId("genie-icon");
		expect(icon.tagName).toBe("svg");
		expect(icon).toHaveTextContent("🧞");
		expect(icon).toHaveAttribute("aria-hidden", "true");
		expect(icon).toHaveClass("size-4");
	});
});
