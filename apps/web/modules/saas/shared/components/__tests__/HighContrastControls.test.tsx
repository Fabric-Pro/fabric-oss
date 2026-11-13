/**
 * Every control that turns high contrast on or off (Fizzy #1444): the sidebar
 * toggle beside the colour-mode control, the user-menu item, and the switch on
 * the Appearance settings page.
 *
 * Each is pinned on what a keyboard and a screen reader get (AC-9): a stable
 * accessible name, the state as `aria-pressed` / `aria-checked`, and Enter or
 * Space to change it. None of them renders outside the authenticated app's
 * provider.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { contrastState, setThemeMock, themeState } = vi.hoisted(() => ({
	contrastState: {
		value: null as null | {
			preference: "standard" | "high";
			highContrast: boolean;
			setPreference: ReturnType<typeof vi.fn>;
			setHighContrast: ReturnType<typeof vi.fn>;
			isSaving: boolean;
		},
	},
	setThemeMock: vi.fn(),
	themeState: { theme: "system" as string },
}));

vi.mock("@saas/shared/components/ContrastPreferenceProvider", () => ({
	useContrastPreference: () => contrastState.value,
}));

vi.mock("next-themes", () => ({
	useTheme: () => ({ theme: themeState.theme, setTheme: setThemeMock }),
}));

const COPY: Record<string, string> = {
	"app.userMenu.highContrast": "High contrast",
	"app.userMenu.accountSettings": "Account settings",
	"app.userMenu.colorMode": "Color mode",
	"app.userMenu.home": "Home",
	"app.userMenu.logout": "Logout",
	"settings.account.appearance.colorMode.title": "Color mode",
	"settings.account.appearance.colorMode.description":
		"Saved in this browser.",
	"settings.account.appearance.colorMode.system": "System",
	"settings.account.appearance.colorMode.light": "Light",
	"settings.account.appearance.colorMode.dark": "Dark",
	"settings.account.appearance.highContrast.title": "High contrast",
	"settings.account.appearance.highContrast.description":
		"Stronger text, border and focus colors.",
	"settings.account.appearance.highContrast.label": "Use high contrast",
};

vi.mock("next-intl", () => ({
	useTranslations: (namespace?: string) => (key: string) => {
		const full = namespace ? `${namespace}.${key}` : key;
		return COPY[full] ?? full;
	},
}));

vi.mock("@repo/config", () => ({
	config: {
		auth: { redirectAfterLogout: "/" },
		organizations: { hideOrganization: false },
		storage: { bucketNames: { avatars: "avatars" } },
		ui: { enabledThemes: ["light", "dark"] },
	},
}));

vi.mock("@repo/auth/client", () => ({ authClient: { signOut: vi.fn() } }));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: {
			id: "user-1",
			name: "Example Member",
			email: "dev@example.com",
			image: null,
			role: "user",
		},
	}),
}));

vi.mock("@saas/organizations/hooks", () => ({
	useContextPath: (path: string) => `/app/example-org/${path}`,
	useOrganizationContext: () => ({ isOrgContext: true }),
}));

vi.mock("@saas/meeting-digest/lib/personal-insights-cache", () => ({
	purgeUser: vi.fn(),
}));

vi.mock("@saas/shared/components/ColorModeToggle", () => ({
	ColorModeToggle: () => null,
}));

vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		...rest
	}: {
		children: ReactNode;
		href: string;
	}) => (
		<a href={href} {...rest}>
			{children}
		</a>
	),
}));

import { AppearanceSettings } from "@saas/settings/components/AppearanceSettings";
import { HighContrastToggle } from "@saas/shared/components/HighContrastToggle";
import { UserMenu } from "@saas/shared/components/UserMenu";

function provide(highContrast: boolean) {
	contrastState.value = {
		preference: highContrast ? "high" : "standard",
		highContrast,
		setPreference: vi.fn(),
		setHighContrast: vi.fn(),
		isSaving: false,
	};
	return contrastState.value;
}

beforeEach(() => {
	contrastState.value = null;
	setThemeMock.mockReset();
	themeState.theme = "system";
});

describe("HighContrastToggle (sidebar)", () => {
	it.each(["pill", "rail"] as const)(
		"%s: a toggle button whose name stays put and whose state is aria-pressed",
		async (variant) => {
			const api = provide(false);
			const { rerender } = render(
				<HighContrastToggle variant={variant} />,
			);

			const button = screen.getByRole("button", {
				name: "High contrast",
			});
			expect(button).toHaveAttribute("aria-pressed", "false");

			await userEvent.click(button);
			expect(api.setHighContrast).toHaveBeenCalledWith(true);

			const on = provide(true);
			rerender(<HighContrastToggle variant={variant} />);
			const pressed = screen.getByRole("button", {
				name: "High contrast",
			});
			expect(pressed).toHaveAttribute("aria-pressed", "true");
			await userEvent.click(pressed);
			expect(on.setHighContrast).toHaveBeenCalledWith(false);
		},
	);

	it("works from the keyboard with Enter and Space", async () => {
		const api = provide(false);
		render(<HighContrastToggle />);

		await userEvent.tab();
		expect(
			screen.getByRole("button", { name: "High contrast" }),
		).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		await userEvent.keyboard(" ");
		expect(api.setHighContrast).toHaveBeenCalledTimes(2);
	});

	it("renders nothing outside the authenticated app", () => {
		const { container } = render(<HighContrastToggle />);
		expect(container).toBeEmptyDOMElement();
	});
});

describe("UserMenu high contrast item", () => {
	async function openMenu() {
		render(<UserMenu />);
		await userEvent.click(
			screen.getByRole("button", { name: "User menu" }),
		);
	}

	it("is a checkbox item that reports its state", async () => {
		provide(true);
		await openMenu();
		const item = screen.getByRole("menuitemcheckbox", {
			name: "High contrast",
		});
		expect(item).toHaveAttribute("aria-checked", "true");
	});

	it("toggles on select and keeps the menu open to show the result", async () => {
		const api = provide(false);
		await openMenu();
		const item = screen.getByRole("menuitemcheckbox", {
			name: "High contrast",
		});
		expect(item).toHaveAttribute("aria-checked", "false");

		await userEvent.click(item);

		expect(api.setHighContrast).toHaveBeenCalledWith(true);
		expect(
			screen.getByRole("menuitemcheckbox", { name: "High contrast" }),
		).toBeInTheDocument();
	});

	it("toggles from the keyboard", async () => {
		const api = provide(false);
		await openMenu();
		const item = screen.getByRole("menuitemcheckbox", {
			name: "High contrast",
		});
		item.focus();
		await userEvent.keyboard("{Enter}");
		expect(api.setHighContrast).toHaveBeenCalledWith(true);
	});

	it("is not offered without the provider", async () => {
		await openMenu();
		expect(
			screen.queryByRole("menuitemcheckbox", { name: "High contrast" }),
		).not.toBeInTheDocument();
	});
});

describe("Appearance settings page (AC-1)", () => {
	it("shows the saved state as a labelled, described switch", () => {
		provide(true);
		render(<AppearanceSettings />);

		const toggle = screen.getByRole("switch", {
			name: "Use high contrast",
		});
		expect(toggle).toHaveAttribute("aria-checked", "true");
		expect(toggle).toHaveAccessibleDescription(
			"Stronger text, border and focus colors.",
		);
	});

	it("turns high contrast on with Space and off with a click", async () => {
		const api = provide(false);
		const { rerender } = render(<AppearanceSettings />);

		const toggle = screen.getByRole("switch", {
			name: "Use high contrast",
		});
		expect(toggle).toHaveAttribute("aria-checked", "false");
		toggle.focus();
		await userEvent.keyboard(" ");
		expect(api.setHighContrast).toHaveBeenCalledWith(true);

		const on = provide(true);
		rerender(<AppearanceSettings />);
		await userEvent.click(
			screen.getByRole("switch", { name: "Use high contrast" }),
		);
		expect(on.setHighContrast).toHaveBeenCalledWith(false);
	});

	it("clicking the label toggles it too", async () => {
		const api = provide(false);
		render(<AppearanceSettings />);
		await userEvent.click(screen.getByText("Use high contrast"));
		expect(api.setHighContrast).toHaveBeenCalledWith(true);
	});

	it("offers the colour mode beside it, saved through next-themes", async () => {
		provide(false);
		themeState.theme = "dark";
		render(<AppearanceSettings />);

		const group = screen.getByRole("radiogroup", { name: "Color mode" });
		expect(group).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();

		await userEvent.click(screen.getByRole("radio", { name: "Light" }));
		expect(setThemeMock).toHaveBeenCalledWith("light");
	});
});
