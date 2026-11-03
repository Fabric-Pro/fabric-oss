import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsMenuSection } from "../SettingsMenu";
import { SettingsSidebarLayout } from "../SettingsSidebarLayout";

vi.mock("next/navigation", () => ({
	usePathname: () => "/app/example-org/settings/ai-providers",
}));

const menuItems: SettingsMenuSection[] = [
	{
		title: "Example Org",
		items: [
			{
				title: "AI Providers",
				href: "/app/example-org/settings/ai-providers",
			},
		],
	},
];

describe("SettingsSidebarLayout", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	it("stretches the sidebar column full-height and anchors the edge handle at sticky 50% viewport height", () => {
		const { container } = render(
			<SettingsSidebarLayout menuItems={menuItems}>
				<div>AI Providers Content</div>
			</SettingsSidebarLayout>,
		);

		const handle = screen.getByRole("button", {
			name: "Collapse settings sidebar",
		});
		const stickyAnchor = handle.parentElement;
		expect(stickyAnchor).not.toBeNull();
		expect(stickyAnchor).toHaveClass("sticky", "top-1/2", "h-0", "w-0");

		const railTrack = stickyAnchor?.parentElement;
		expect(railTrack).toHaveClass("absolute", "inset-y-0", "right-0");

		// No fixed `calc(100vh-88px)` cutoff remains on the sidebar column.
		expect(container.innerHTML).not.toContain("100vh-88px");
		expect(container.innerHTML).toContain("lg:self-stretch");
	});

	it("toggles collapsed width and persists the preference", async () => {
		const user = userEvent.setup();
		render(
			<SettingsSidebarLayout menuItems={menuItems}>
				<div>AI Providers Content</div>
			</SettingsSidebarLayout>,
		);

		await user.click(
			screen.getByRole("button", { name: "Collapse settings sidebar" }),
		);

		expect(
			screen.getByRole("button", { name: "Expand settings sidebar" }),
		).toBeInTheDocument();
		expect(
			window.localStorage.getItem("fabric-settings-sidebar-collapsed"),
		).toBe("true");
	});
});
