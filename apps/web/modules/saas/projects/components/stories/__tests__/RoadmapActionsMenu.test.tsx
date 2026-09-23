import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SparklesIcon, TrashIcon } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { RoadmapActionsMenu } from "../RoadmapActionsMenu";
import type { RoadmapActionItem } from "../roadmap-entry/roadmap-action-items";

function item(overrides: Partial<RoadmapActionItem> = {}): RoadmapActionItem {
	return {
		id: "recommend",
		label: "Recommend Features from Context",
		icon: SparklesIcon,
		onSelect: vi.fn(),
		disabledReason: null,
		...overrides,
	};
}

describe("RoadmapActionsMenu", () => {
	it("renders nothing without items", () => {
		const { container } = render(<RoadmapActionsMenu items={[]} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders a labelled kebab carrying the get-started anchor", () => {
		render(<RoadmapActionsMenu items={[item()]} />);
		const trigger = screen.getByRole("button", { name: "trigger" });
		expect(trigger).toHaveAttribute(
			"data-onboarding-target",
			"roadmap-actions",
		);
	});

	it("lists the items and runs the selected one", async () => {
		const user = userEvent.setup();
		const recommend = item();
		render(
			<RoadmapActionsMenu
				items={[
					recommend,
					item({ id: "remove", label: "Remove", icon: TrashIcon }),
				]}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "trigger" }));
		await user.click(
			await screen.findByRole("menuitem", {
				name: /Recommend Features from Context/,
			}),
		);
		expect(recommend.onSelect).toHaveBeenCalledTimes(1);
	});

	it("shows a disabled item's reason and does not run it", async () => {
		const user = userEvent.setup();
		const blocked = item({ disabledReason: "Add more project context" });
		render(<RoadmapActionsMenu items={[blocked]} />);
		await user.click(screen.getByRole("button", { name: "trigger" }));
		const menuItem = await screen.findByRole("menuitem", {
			name: /Recommend Features from Context/,
		});
		expect(menuItem).toHaveAttribute("aria-disabled", "true");
		expect(menuItem).toHaveTextContent("Add more project context");
	});

	it("keeps a disabled item keyboard-reachable and inert (AC-14, AC-20)", async () => {
		const user = userEvent.setup();
		const blocked = item({
			disabledReason: "Not enough project context yet",
			disabledDetail: "FR37 body",
		});
		render(<RoadmapActionsMenu items={[blocked]} />);
		await user.click(screen.getByRole("button", { name: "trigger" }));
		const menuItem = await screen.findByRole("menuitem", {
			name: /Recommend Features from Context/,
		});
		// Not Radix `disabled`: that drops the item from arrow-key focus.
		expect(menuItem).not.toHaveAttribute("data-disabled");
		await user.keyboard("{ArrowDown}");
		expect(menuItem).toHaveFocus();
		expect(menuItem).toHaveTextContent("FR37 body");
		await user.keyboard("{Enter}");
		expect(blocked.onSelect).not.toHaveBeenCalled();
		// The menu stays open so the reason can still be read.
		expect(screen.getByRole("menu")).toBeInTheDocument();
	});

	it("renders the description, a warning, and the remedy as its own item", async () => {
		const user = userEvent.setup();
		render(
			<RoadmapActionsMenu
				items={[
					item({
						description: "FR10 description",
						warning: "Thin context",
					}),
					item({
						id: "blocked",
						label: "Blocked",
						disabledReason: "Why",
						remedy: { label: "Add context", href: "/context" },
					}),
				]}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "trigger" }));
		const recommend = await screen.findByRole("menuitem", {
			name: /Recommend Features from Context/,
		});
		expect(recommend).toHaveTextContent("FR10 description");
		expect(recommend).toHaveTextContent("Thin context");
		expect(recommend).not.toHaveAttribute("aria-disabled");
		expect(
			screen.getByRole("menuitem", { name: "Add context" }),
		).toHaveAttribute("href", "/context");
	});

	it("hides the kebab icon from assistive tech", () => {
		render(<RoadmapActionsMenu items={[item()]} />);
		expect(
			screen
				.getByRole("button", { name: "trigger" })
				.querySelector("svg"),
		).toHaveAttribute("aria-hidden", "true");
	});
});
