/**
 * Contract for the shared notification-settings entry point rendered on both
 * the bell-dropdown modal and the View All Notifications page:
 *  1. Renders an accessible "Notification settings" link.
 *  2. Points at the personal, org-independent deep-link route
 *     `/app/settings/notifications` (never a context-scoped path).
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => {
		const map: Record<string, string> = {
			settings: "Notification settings",
			settingsHint: "Opens your personal account settings",
		};
		return map[key] ?? key;
	},
}));

vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		className,
		"aria-label": ariaLabel,
	}: {
		children: ReactNode;
		href: string;
		className?: string;
		"aria-label"?: string;
	}) => (
		<a href={href} className={className} aria-label={ariaLabel}>
			{children}
		</a>
	),
}));

import { NotificationSettingsLink } from "../NotificationSettingsLink";

describe("NotificationSettingsLink", () => {
	it("renders an accessible link to the personal notification settings route", () => {
		render(<NotificationSettingsLink />);

		const link = screen.getByRole("link", {
			name: "Notification settings",
		});
		expect(link).toHaveAttribute("href", "/app/settings/notifications");
	});
});
