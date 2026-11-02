/**
 * Radix Select renders nothing in its trigger when `value` matches no option.
 * `excludeRoles` removes options a viewer may not pick, so filtering out a
 * row's own role left that member with a blank role on the Members page
 * (Fizzy #2968): an admin looking at an owner saw an empty, disabled select.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

const translations: Record<string, string> = {
	"organizations.roles.admin": "Admin",
	"organizations.roles.member": "Member",
	"organizations.roles.none": "No role",
	"organizations.roles.owner": "Owner",
};

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => translations[key] ?? key,
}));

import { OrganizationRoleSelect } from "../OrganizationRoleSelect";

beforeAll(() => {
	// Radix Select calls these when the listbox opens; jsdom has neither.
	Element.prototype.scrollIntoView = vi.fn();
	Element.prototype.hasPointerCapture = vi.fn(() => false);
});

describe("OrganizationRoleSelect", () => {
	it("shows an owner's role to a viewer who cannot assign that role", () => {
		render(
			<OrganizationRoleSelect
				value="owner"
				onSelect={vi.fn()}
				disabled
				excludeRoles={["owner"]}
			/>,
		);

		expect(screen.getByRole("combobox").textContent).toContain("Owner");
	});

	it("still withholds an excluded role that is not the current value", () => {
		render(
			<OrganizationRoleSelect
				value="member"
				onSelect={vi.fn()}
				excludeRoles={["owner"]}
			/>,
		);

		fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });

		expect(screen.getByRole("option", { name: "Admin" })).toBeTruthy();
		expect(screen.queryByRole("option", { name: "Owner" })).toBeNull();
	});

	it.each([
		["a role with no label", "viewer"],
		["an empty role", ""],
	])(
		"names the missing state for %s instead of rendering blank",
		(_, role) => {
			render(
				<OrganizationRoleSelect
					value={role as "member"}
					onSelect={vi.fn()}
					disabled
				/>,
			);

			expect(screen.getByRole("combobox").textContent).toContain(
				"No role",
			);
		},
	);
});
