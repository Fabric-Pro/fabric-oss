/**
 * ConfirmChangeSummaryCard — confirm-time "Changes in this update" summary.
 *
 * Advisory card above the diff bar: shows a
 * loading line while summarizing, the bulleted summary when present, and renders
 * nothing when empty/errored so it never blocks the review. next-intl is
 * globally key-mocked in vitest.setup.ts (labels === keys).
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConfirmChangeSummaryCard } from "../ConfirmChangeSummaryCard";

describe("ConfirmChangeSummaryCard", () => {
	it("shows a loading line while summarizing", () => {
		render(<ConfirmChangeSummaryCard bullets={null} isLoading={true} />);
		expect(screen.getByText("loading")).toBeInTheDocument();
		expect(screen.queryByText("heading")).not.toBeInTheDocument();
	});

	it("renders the bullets under the heading when present", () => {
		render(
			<ConfirmChangeSummaryCard
				bullets={[
					"Must Haves — restricted MFA methods to email and SMS",
					"Acceptance Criteria — added lockout-after-5-attempts case",
				]}
				isLoading={false}
			/>,
		);
		expect(screen.getByText("heading")).toBeInTheDocument();
		expect(
			screen.getByText(
				"Must Haves — restricted MFA methods to email and SMS",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"Acceptance Criteria — added lockout-after-5-attempts case",
			),
		).toBeInTheDocument();
	});

	it("renders nothing when the summary is empty (no substantive change)", () => {
		const { container } = render(
			<ConfirmChangeSummaryCard bullets={[]} isLoading={false} />,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing when the summary errored (bullets null, not loading)", () => {
		const { container } = render(
			<ConfirmChangeSummaryCard bullets={null} isLoading={false} />,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
