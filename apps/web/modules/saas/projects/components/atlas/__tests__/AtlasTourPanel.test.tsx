/**
 * Component tests for `<AtlasTourPanel variant="hero" />` — the inline
 * walkthrough merged into the Atlas Overview hero.
 *
 * The hero variant drops the card chrome / header (the hero owns the editorial
 * label + serif title) and renders a paged body: the tour intro is page 1,
 * then one page per business-tour capability (name + narrative + "Show in
 * graph"), with a prev · dots · next navigator that clamps at both ends.
 *
 * next-intl is stubbed globally (vitest.setup) to echo its key, so control
 * labels assert on the key (e.g. "back", "next", "focusNode", "title") while
 * page content asserts on the tour data itself. The dots all echo the same
 * "goToPage" label, so they are queried positionally with getAllByRole.
 */

import type { BusinessTour } from "@repo/atlas/types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AtlasTourPanel } from "../AtlasTourPanel";

const tour: BusinessTour = {
	intro: "This codebase runs a billing platform.",
	steps: [
		{
			capabilityKey: "cap-billing",
			title: "Billing & Payments",
			narrative: "Charges customers and reconciles invoices.",
		},
		{
			capabilityKey: "cap-auth",
			title: "Authentication",
			narrative: "Signs users in and guards every request.",
		},
	],
};

/** Controlled wrapper — mirrors the Overview, which owns the page state. */
function HeroHarness({ onFocusNode }: { onFocusNode: (key: string) => void }) {
	const [activeStep, setActiveStep] = useState(0);
	return (
		<AtlasTourPanel
			variant="hero"
			tour={tour}
			activeStep={activeStep}
			onStepChange={setActiveStep}
			onFocusNode={onFocusNode}
		/>
	);
}

describe("AtlasTourPanel — hero variant", () => {
	it("opens on the intro page with both pager controls enabled (it loops)", () => {
		render(<HeroHarness onFocusNode={vi.fn()} />);

		expect(screen.getByText(tour.intro)).toBeInTheDocument();
		// The intro page carries no capability heading or graph action.
		expect(screen.queryByText(tour.steps[0].title)).toBeNull();
		expect(screen.queryByRole("button", { name: "focusNode" })).toBeNull();
		// It is a true carousel — neither control is clamped, even at the ends.
		expect(screen.getByRole("button", { name: "back" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "next" })).toBeEnabled();
	});

	it("pages forward to a capability with name, narrative and graph action — no intro duplicate", async () => {
		const user = userEvent.setup();
		render(<HeroHarness onFocusNode={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "next" }));

		expect(
			screen.getByRole("heading", { name: tour.steps[0].title }),
		).toBeInTheDocument();
		expect(screen.getByText(tour.steps[0].narrative)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "focusNode" }),
		).toBeInTheDocument();
		// The intro lives only on page 1 — it must not be duplicated here.
		expect(screen.queryByText(tour.intro)).toBeNull();
		// Prev is now reachable.
		expect(screen.getByRole("button", { name: "back" })).toBeEnabled();
	});

	it("'Show in graph' focuses the current capability's node via the callback", async () => {
		const onFocusNode = vi.fn();
		const user = userEvent.setup();
		render(<HeroHarness onFocusNode={onFocusNode} />);

		await user.click(screen.getByRole("button", { name: "next" }));
		await user.click(screen.getByRole("button", { name: "focusNode" }));

		expect(onFocusNode).toHaveBeenCalledWith("cap-billing");
	});

	it("loops forward: Next on the last page wraps back to the intro", async () => {
		const user = userEvent.setup();
		render(<HeroHarness onFocusNode={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "next" })); // → billing
		await user.click(screen.getByRole("button", { name: "next" })); // → auth (last)

		// On the final page Next stays enabled and wraps round to the intro.
		expect(
			screen.getByRole("heading", { name: tour.steps[1].title }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "next" })).toBeEnabled();

		await user.click(screen.getByRole("button", { name: "next" })); // wraps → intro
		expect(screen.getByText(tour.intro)).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: tour.steps[1].title }),
		).toBeNull();
	});

	it("loops backward: Back on the intro wraps to the last page", async () => {
		const user = userEvent.setup();
		render(<HeroHarness onFocusNode={vi.fn()} />);

		// Starts on the intro; Back wraps round to the final capability.
		await user.click(screen.getByRole("button", { name: "back" }));
		expect(
			screen.getByRole("heading", { name: tour.steps[1].title }),
		).toBeInTheDocument();
		expect(screen.queryByText(tour.intro)).toBeNull();
	});

	it("dots jump to the chosen page and mark the active one with aria-current", async () => {
		const user = userEvent.setup();
		render(<HeroHarness onFocusNode={vi.fn()} />);

		// intro + 2 steps → 3 dot buttons, all echoing the same "goToPage" label.
		const dots = () => screen.getAllByRole("button", { name: "goToPage" });
		expect(dots()).toHaveLength(3);
		// On the intro the first dot is current.
		expect(dots()[0]).toHaveAttribute("aria-current", "true");
		expect(dots()[2]).not.toHaveAttribute("aria-current");

		// Click the third dot → jumps straight to the last capability.
		await user.click(dots()[2]);
		expect(
			screen.getByRole("heading", { name: tour.steps[1].title }),
		).toBeInTheDocument();
		expect(dots()[2]).toHaveAttribute("aria-current", "true");
		expect(dots()[0]).not.toHaveAttribute("aria-current");
	});

	it("exposes the pager as a labelled navigation landmark", () => {
		render(<HeroHarness onFocusNode={vi.fn()} />);
		// <nav aria-label={t("title")}> → echoed key "title".
		expect(
			screen.getByRole("navigation", { name: "title" }),
		).toBeInTheDocument();
	});
});
