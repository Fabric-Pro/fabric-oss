/**
 * Fizzy #3082: AI Providers is one page with two tabs, chosen by `?tab=`.
 * The notices in the app chrome link to `?tab=personal`, so the URL — not a
 * value seeded on mount — has to decide which tab is open.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () =>
	(await import("../../../projects/__tests__/en-copy")).nextIntlMock(),
);

const nav = vi.hoisted(() => ({
	search: new URLSearchParams(),
	replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: nav.replace }),
	usePathname: () => "/app/acme/settings/ai-providers",
	useSearchParams: () => nav.search,
}));

import { AiProvidersTabs } from "../AiProvidersTabs";

function renderTabs() {
	return render(
		<AiProvidersTabs
			organization={<p>Organization keys</p>}
			personal={<p>My own keys</p>}
		/>,
	);
}

beforeEach(() => {
	nav.replace.mockClear();
	nav.search = new URLSearchParams();
});

describe("AiProvidersTabs", () => {
	it("opens on the Organization tab by default", () => {
		renderTabs();

		expect(
			screen.getByRole("tab", { name: "Organization" }),
		).toHaveAttribute("aria-selected", "true");
		expect(screen.getByText("Organization keys")).toBeDefined();
		expect(screen.queryByText("My own keys")).toBeNull();
	});

	it("opens on the Personal tab for ?tab=personal", () => {
		nav.search = new URLSearchParams("tab=personal");

		renderTabs();

		expect(screen.getByRole("tab", { name: "Personal" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.getByText("My own keys")).toBeDefined();
		expect(screen.queryByText("Organization keys")).toBeNull();
	});

	it("reads an unknown tab value as the Organization tab", () => {
		nav.search = new URLSearchParams("tab=billing");

		renderTabs();

		expect(screen.getByText("Organization keys")).toBeDefined();
	});

	it("follows the URL when it changes without a remount", () => {
		const { rerender } = renderTabs();
		expect(screen.getByText("Organization keys")).toBeDefined();

		// A chrome notice's link to ?tab=personal, followed on this page.
		nav.search = new URLSearchParams("tab=personal");
		rerender(
			<AiProvidersTabs
				organization={<p>Organization keys</p>}
				personal={<p>My own keys</p>}
			/>,
		);

		expect(screen.getByText("My own keys")).toBeDefined();
	});

	it("writes the chosen tab to the URL, keeping the rest of the query", async () => {
		nav.search = new URLSearchParams("returnTo=%2Fapp%2Fprojects");
		renderTabs();

		await userEvent.click(screen.getByRole("tab", { name: "Personal" }));

		expect(nav.replace).toHaveBeenCalledWith(
			"/app/acme/settings/ai-providers?returnTo=%2Fapp%2Fprojects&tab=personal",
			{ scroll: false },
		);
	});

	it("drops ?tab when going back to the Organization tab", async () => {
		nav.search = new URLSearchParams("tab=personal");
		renderTabs();

		await userEvent.click(
			screen.getByRole("tab", { name: "Organization" }),
		);

		expect(nav.replace).toHaveBeenCalledWith(
			"/app/acme/settings/ai-providers",
			{ scroll: false },
		);
	});
});
