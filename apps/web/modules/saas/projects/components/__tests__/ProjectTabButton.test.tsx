/**
 * Project tab bar buttons (Fizzy card #1837).
 *
 * Every tab paints its icon and its title by default, selected or not. A
 * viewer may drop either one per tab: icon-only, or title-only. Dropping both
 * is not a paint state at all — it means the tab is hidden, which the resolver
 * handles before this component is ever asked to render.
 *
 * The title carries the accessible name whether or not it is painted, so an
 * icon-only tab is never a mystery to a screen reader, and the tooltip appears
 * only when the title is missing from the bar.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MapIcon } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { ProjectTabButton } from "../ProjectTabButton";

function renderButton(overrides: {
	isActive?: boolean;
	showIcon?: boolean;
	showTitle?: boolean;
	onSelect?: () => void;
}) {
	return render(
		<ProjectTabButton
			label="Roadmap"
			icon={MapIcon}
			isActive={overrides.isActive ?? false}
			showIcon={overrides.showIcon ?? true}
			showTitle={overrides.showTitle ?? true}
			anchor="project-tab-stories"
			onSelect={overrides.onSelect ?? (() => {})}
			registerRef={() => {}}
		/>,
	);
}

const button = () => screen.getByRole("button", { name: "Roadmap" });
const iconOf = (el: HTMLElement) => el.querySelector("svg");

describe("what a tab paints", () => {
	it("shows both the icon and the title by default", () => {
		renderButton({});

		expect(button().textContent).toBe("Roadmap");
		expect(iconOf(button())).not.toBeNull();
	});

	it("keeps the title when the tab is not the selected one", () => {
		// The pre-refinement bar labelled only the active tab. Andrew asked for
		// the label by default, so being inactive must not remove it.
		renderButton({ isActive: false });

		expect(button().textContent).toBe("Roadmap");
	});

	it("paints the icon alone when the viewer drops the title", () => {
		renderButton({ showTitle: false });

		expect(button().textContent).toBe("");
		expect(iconOf(button())).not.toBeNull();
	});

	it("paints the title alone when the viewer drops the icon", () => {
		renderButton({ showIcon: false });

		expect(button().textContent).toBe("Roadmap");
		expect(iconOf(button())).toBeNull();
	});
});

describe("the name a tab answers to", () => {
	it("keeps the title as the accessible name when only the icon paints", () => {
		renderButton({ showTitle: false });

		expect(button()).toHaveAttribute("aria-label", "Roadmap");
	});

	it("names an icon-only tab on hover", async () => {
		const user = userEvent.setup();
		renderButton({ showTitle: false });

		await user.hover(button());

		expect(await screen.findByRole("tooltip")).toHaveTextContent("Roadmap");
	});

	it("gives no tooltip to a tab whose title is already on screen", async () => {
		const user = userEvent.setup();
		renderButton({ showTitle: true });

		await user.hover(button());
		// Past the tooltip's open delay. Asserting straight after the hover
		// would pass against a button that does have a tooltip and simply has
		// not opened it yet.
		await new Promise((resolve) => setTimeout(resolve, 700));

		expect(screen.queryByRole("tooltip")).toBeNull();
	});
});

describe("the rest of the button", () => {
	it("keeps the Get Started anchor on the button itself", () => {
		renderButton({});

		expect(button()).toHaveAttribute(
			"data-onboarding-target",
			"project-tab-stories",
		);
	});

	it("selects the tab on click", async () => {
		const onSelect = vi.fn();
		const user = userEvent.setup();
		renderButton({ onSelect });

		await user.click(button());

		expect(onSelect).toHaveBeenCalledTimes(1);
	});
});
