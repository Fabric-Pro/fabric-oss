/**
 * The Publishing Suite "Beta" marker (Fizzy #2348, FR5).
 *
 * Two surfaces carry it and they are gated by ONE flag, so both directions are
 * pinned here for each: on when `PUBLISHING_SUITE_BETA_LABEL` resolves true,
 * gone when it resolves false. The off case is the one worth having — the
 * marker is meant to disappear at general availability without a deploy, and a
 * test that only ever asserts the label is present would stay green if the
 * flag were ignored entirely.
 *
 * The tab marker is asserted through the accessible name rather than the
 * painted text, because a tab may be showing its icon alone (card #1837): the
 * name is the only thing every paint mode has.
 */

import { render, screen } from "@testing-library/react";
import { MegaphoneIcon } from "lucide-react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { flagState } = vi.hoisted(() => ({
	flagState: { betaLabel: true },
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) =>
		key === "PUBLISHING_SUITE_BETA_LABEL" ? flagState.betaLabel : false,
}));

import { ProjectTabButton } from "../ProjectTabButton";
import { PublishingBetaBadge } from "../publishing-suite/PublishingBetaBadge";

beforeEach(() => {
	flagState.betaLabel = true;
});

describe("PublishingBetaBadge", () => {
	it("renders the Beta label when the flag is on", () => {
		render(<PublishingBetaBadge />);

		expect(screen.getByText("Beta")).toBeInTheDocument();
	});

	it("renders nothing when the flag is off", () => {
		flagState.betaLabel = false;

		const { container } = render(<PublishingBetaBadge />);

		expect(screen.queryByText("Beta")).not.toBeInTheDocument();
		expect(container).toBeEmptyDOMElement();
	});
});

describe("ProjectTabButton beta marker", () => {
	const baseProps = {
		icon: MegaphoneIcon,
		isActive: false,
		showIcon: true,
		showTitle: true,
		anchor: "project-tab-publishing-suite",
		onSelect: vi.fn(),
		registerRef: vi.fn(),
	};

	it("puts Beta in the accessible name when the tab is marked beta", () => {
		render(
			<ProjectTabButton
				{...baseProps}
				label="Publishing Suite"
				beta={true}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "Publishing Suite (Beta)" }),
		).toBeInTheDocument();
	});

	it("leaves the accessible name alone when the tab is not beta", () => {
		render(
			<ProjectTabButton
				{...baseProps}
				label="Publishing Suite"
				beta={false}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "Publishing Suite" }),
		).toBeInTheDocument();
	});

	it("paints the marker beside the title when the title is shown", () => {
		render(
			<ProjectTabButton
				{...baseProps}
				label="Publishing Suite"
				beta={true}
			/>,
		);

		expect(screen.getByText("Beta")).toBeInTheDocument();
	});

	it("paints a marker on an icon-only tab, where no title carries it", () => {
		render(
			<ProjectTabButton
				{...baseProps}
				showTitle={false}
				label="Publishing Suite"
				beta={true}
			/>,
		);

		// Nothing textual is painted in this mode, so the dot is the only
		// visible signal. It is decorative — the accessible name above is what
		// a screen reader gets — hence a test id rather than a role.
		expect(screen.getByTestId("tab-beta-dot")).toBeInTheDocument();
	});
});
