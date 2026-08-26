import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NewsletterReviewHighlight } from "./NewsletterReviewHighlight";

const base = {
	title: "Faster search",
	description: "Results load sooner.",
};

function renderRow(
	props: Partial<Parameters<typeof NewsletterReviewHighlight>[0]> = {},
) {
	return render(
		<ul>
			<NewsletterReviewHighlight
				{...base}
				excluded={false}
				onToggle={vi.fn()}
				{...props}
			/>
		</ul>,
	);
}

describe("NewsletterReviewHighlight", () => {
	it("names an excluded item excluded instead of striking it through", () => {
		// Strikethrough reads as "deleted" — reviewers took it to mean the
		// feature was being dropped, not left out of this one issue (#2172).
		const { container } = renderRow({ excluded: true });

		expect(screen.getByText(/excluded/i)).toBeInTheDocument();
		expect(container.querySelector(".line-through")).toBeNull();
	});

	it("shows no exclusion marker while the item is included", () => {
		renderRow({ excluded: false });

		expect(screen.queryByText(/excluded/i)).not.toBeInTheDocument();
	});

	it("checks the box when the item is included and clears it when excluded", () => {
		const { unmount } = renderRow({ excluded: false });
		expect(screen.getByRole("checkbox")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		unmount();

		renderRow({ excluded: true });
		expect(screen.getByRole("checkbox")).toHaveAttribute(
			"aria-checked",
			"false",
		);
	});

	it("raises onToggle once per click", () => {
		const onToggle = vi.fn();
		renderRow({ onToggle });

		fireEvent.click(screen.getByRole("checkbox"));

		expect(onToggle).toHaveBeenCalledTimes(1);
	});

	it("labels the checkbox with the highlight it controls", () => {
		renderRow();

		expect(
			screen.getByRole("checkbox", { name: /include faster search/i }),
		).toBeInTheDocument();
	});

	it("keeps the exclusion badge out of the accessibility tree", () => {
		// The checkbox state already announces inclusion; announcing it twice
		// makes the row read as two conflicting controls.
		renderRow({ excluded: true });

		expect(screen.getByText(/excluded/i)).toHaveAttribute(
			"aria-hidden",
			"true",
		);
	});
});
