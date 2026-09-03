/**
 * The Icon / Title toggles in the Customize tabs dialog (Fizzy card #1837).
 *
 * Two toggles per tab replaced the old hide (eye) button, so "hidden" stopped
 * being its own control and became the state where a viewer turned both off.
 * These tests pin that both directions of that equivalence hold, and that a
 * protected tab cannot be walked into it.
 */

import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileTextIcon, LayoutDashboardIcon, MapIcon } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { CustomizeProjectTabsDialog } from "../CustomizeProjectTabsDialog";

const TABS = [
	{ id: "overview", label: "Overview", icon: LayoutDashboardIcon },
	{ id: "stories", label: "Roadmap", icon: MapIcon },
	{ id: "documents", label: "Documents", icon: FileTextIcon },
];

const renderDialog = (
	props: Partial<Parameters<typeof CustomizeProjectTabsDialog>[0]> = {},
) => {
	const onSave = vi.fn();
	render(
		<FeatureFlagProvider value={{ PUBLISHING_SUITE: false }}>
			<CustomizeProjectTabsDialog
				open
				onOpenChange={() => {}}
				tabs={TABS}
				config={null}
				prefs={null}
				onSave={onSave}
				saving={false}
				{...props}
			/>
		</FeatureFlagProvider>,
	);
	return { onSave };
};

/** The row for one tab, found by its label inside the dialog. */
const rowFor = (label: string) => {
	const cell = screen.getByText(label);
	const row = cell.closest("li");
	if (!row) {
		throw new Error(`no row for ${label}`);
	}
	return row as HTMLElement;
};

const toggleIn = (label: string, name: RegExp) =>
	within(rowFor(label)).getByRole("button", { name });

const sectionCount = (heading: RegExp) =>
	screen.queryByText(heading)?.textContent ?? "";

describe("what the toggles do", () => {
	it("starts every tab with both halves on", () => {
		renderDialog();

		expect(toggleIn("Roadmap", /Hide the Roadmap icon/)).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(toggleIn("Roadmap", /Hide the Roadmap title/)).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});

	it("saves a tab the viewer set to icon only", async () => {
		const user = userEvent.setup();
		const { onSave } = renderDialog();

		await user.click(toggleIn("Roadmap", /Hide the Roadmap title/));
		await user.click(screen.getByRole("button", { name: "Done" }));

		expect(onSave).toHaveBeenCalledTimes(1);
		const saved = onSave.mock.calls[0][0];
		expect(saved.display).toEqual({ stories: "icon" });
		expect(saved.hidden).toEqual([]);
	});

	it("saves a tab the viewer set to title only", async () => {
		const user = userEvent.setup();
		const { onSave } = renderDialog();

		await user.click(toggleIn("Roadmap", /Hide the Roadmap icon/));
		await user.click(screen.getByRole("button", { name: "Done" }));

		expect(onSave.mock.calls[0][0].display).toEqual({ stories: "title" });
	});

	it("turning both off hides the tab and moves its row", async () => {
		const user = userEvent.setup();
		const { onSave } = renderDialog();

		expect(sectionCount(/^Shown \(/)).toBe("Shown (3)");

		await user.click(toggleIn("Roadmap", /Hide the Roadmap title/));
		await user.click(toggleIn("Roadmap", /Hide the Roadmap icon/));

		expect(sectionCount(/^Shown \(/)).toBe("Shown (2)");
		expect(screen.getByText("Hidden by you")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Done" }));

		const saved = onSave.mock.calls[0][0];
		expect(saved.hidden).toEqual(["stories"]);
		// A hidden tab carries no paint entry: `hidden` is the single place
		// every other surface reads, so storing both would invite them to
		// disagree.
		expect(saved.display).toEqual({});
	});

	it("brings a hidden tab back when either half goes on again", async () => {
		const user = userEvent.setup();
		renderDialog({ prefs: { hidden: ["stories"], order: [] } });

		expect(sectionCount(/^Shown \(/)).toBe("Shown (2)");

		await user.click(toggleIn("Roadmap", /Show the Roadmap icon/));

		expect(sectionCount(/^Shown \(/)).toBe("Shown (3)");
	});
});

describe("tabs that cannot be hidden", () => {
	it("disables the last remaining toggle on a protected tab", async () => {
		const user = userEvent.setup();
		renderDialog();

		// Overview is protected. Dropping its title is allowed; dropping the
		// icon afterwards would leave nothing, so that toggle locks.
		await user.click(toggleIn("Overview", /Hide the Overview title/));

		expect(toggleIn("Overview", /Hide the Overview icon/)).toBeDisabled();
		expect(sectionCount(/^Shown \(/)).toBe("Shown (3)");
	});

	it("lets an ordinary tab reach the both-off state", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.click(toggleIn("Documents", /Hide the Documents title/));

		expect(
			toggleIn("Documents", /Hide the Documents icon/),
		).not.toBeDisabled();
	});
});

describe("what replaced the eye", () => {
	it("offers no separate hide control", () => {
		renderDialog();

		expect(
			screen.queryByRole("button", { name: /^Hide Roadmap$/ }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: /^Show Roadmap$/ }),
		).toBeNull();
	});
});

describe("keyboard footing", () => {
	it("keeps focus on the toggle that moved the row", async () => {
		// Hiding a tab remounts its row under a different <ul>, so React cannot
		// carry the pressed button's DOM node across. Without a deliberate
		// refocus, the viewer is dumped back on the dialog and has to hunt for
		// their place again.
		const user = userEvent.setup();
		renderDialog();

		await user.click(toggleIn("Roadmap", /Hide the Roadmap title/));
		await user.click(toggleIn("Roadmap", /Hide the Roadmap icon/));

		expect(document.activeElement).toBe(
			toggleIn("Roadmap", /Show the Roadmap icon/),
		);
	});

	it("explains a toggle it will not let you press", () => {
		renderDialog({ prefs: { display: { overview: "icon" } } });

		expect(toggleIn("Overview", /Hide the Overview icon/)).toHaveAttribute(
			"title",
			"Overview is always shown, so it needs its icon or its title",
		);
	});

	it("keeps the always-shown reason readable, not icon-only", () => {
		renderDialog();

		expect(
			within(rowFor("Overview")).getByText("Always shown"),
		).toBeInTheDocument();
	});
});
