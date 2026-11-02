import { findBrandColor } from "@repo/utils/brand-colors";
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { OrganizationThemeProvider } from "../modules/saas/organizations/components/OrganizationThemeProvider";

it("applies the selected red organization palette", () => {
	render(<OrganizationThemeProvider brandColor="red" />);
	expect(document.documentElement.style.getPropertyValue("--ring")).toBe(
		findBrandColor("red")?.hex,
	);
});
