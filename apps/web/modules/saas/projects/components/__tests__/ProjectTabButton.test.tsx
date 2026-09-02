/**
 * Project tab bar buttons (Fizzy card #1837 follow-up).
 *
 * The bar shows icons only — the tab name arrives on hover or keyboard focus —
 * except for the selected tab, which keeps its label inline. These tests pin
 * both halves, because "icon only" is only acceptable while the label is still
 * the button's accessible name.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MapIcon } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { ProjectTabButton } from "../ProjectTabButton";

function renderButton(overrides: {
	isActive?: boolean;
	onSelect?: () => void;
}) {
	return render(
		<ProjectTabButton
			label="Roadmap"
			icon={MapIcon}
			isActive={overrides.isActive ?? false}
			anchor="project-tab-stories"
			onSelect={overrides.onSelect ?? (() => {})}
			registerRef={() => {}}
		/>,
	);
}

describe("ProjectTabButton", () => {
	it("paints no label text when it is not the selected tab", () => {
		renderButton({});

		const button = screen.getByRole("button", { name: "Roadmap" });
		expect(button.textContent).toBe("");
	});

	it("keeps the label as the accessible name so the icon is not the only cue", () => {
		renderButton({});

		expect(screen.getByRole("button", { name: "Roadmap" })).toHaveAttribute(
			"aria-label",
			"Roadmap",
		);
	});

	it("names the tab on hover", async () => {
		const user = userEvent.setup();
		renderButton({});

		await user.hover(screen.getByRole("button", { name: "Roadmap" }));

		expect(await screen.findByRole("tooltip")).toHaveTextContent("Roadmap");
	});

	it("paints the label inline for the selected tab", () => {
		renderButton({ isActive: true });

		const button = screen.getByRole("button", { name: "Roadmap" });
		expect(button.textContent).toBe("Roadmap");
	});

	it("keeps the Get Started anchor on the button itself", () => {
		renderButton({});

		expect(screen.getByRole("button", { name: "Roadmap" })).toHaveAttribute(
			"data-onboarding-target",
			"project-tab-stories",
		);
	});

	it("selects the tab on click", async () => {
		const onSelect = vi.fn();
		const user = userEvent.setup();
		renderButton({ onSelect });

		await user.click(screen.getByRole("button", { name: "Roadmap" }));

		expect(onSelect).toHaveBeenCalledTimes(1);
	});
});
