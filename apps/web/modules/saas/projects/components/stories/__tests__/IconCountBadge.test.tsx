import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IconCountBadge } from "../IconCountBadge";

describe("IconCountBadge", () => {
	it("renders nothing at zero", () => {
		const { container } = render(<IconCountBadge count={0} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing for negative counts", () => {
		const { container } = render(<IconCountBadge count={-3} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders the exact count when positive", () => {
		render(<IconCountBadge count={3} />);
		expect(screen.getByText("3")).toBeInTheDocument();
	});

	it("caps at 99+ above one hundred", () => {
		render(<IconCountBadge count={100} />);
		expect(screen.getByText("99+")).toBeInTheDocument();
	});

	it("is decorative and non-interactive", () => {
		render(<IconCountBadge count={5} />);
		const badge = screen.getByText("5");
		expect(badge).toHaveAttribute("aria-hidden");
		expect(badge.className).toContain("pointer-events-none");
	});
});
