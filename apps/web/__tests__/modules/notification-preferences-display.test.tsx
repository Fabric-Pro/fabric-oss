/**
 * The Display section of the notification settings form (#2117).
 *
 * It sits apart from the category toggles on purpose: those decide whether a
 * notification is delivered at all, this one only decides how an already
 * delivered notification is drawn. These tests pin that separation at the
 * payload level — toggling the style must never send a delivery flag.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUpdate, mockData } = vi.hoisted(() => ({
	mockUpdate: vi.fn(),
	mockData: { current: {} as Record<string, unknown> },
}));

vi.mock("@saas/notifications/hooks/use-notification-preferences", () => ({
	useNotificationPreferences: () => ({
		data: mockData.current,
		isLoading: false,
		isError: false,
		refetch: vi.fn(),
	}),
	useUpdateNotificationPreferences: () => ({
		mutate: mockUpdate,
		isPending: false,
	}),
}));

import { NotificationPreferencesForm } from "@saas/settings/components/NotificationPreferencesForm";

beforeEach(() => {
	mockUpdate.mockReset();
	mockData.current = {
		mentions: true,
		replies: true,
		assignments: true,
		status: true,
		syncProject: true,
		aiAgent: true,
		reportEmails: true,
		syncIntegrationAvailable: true,
		stackedCardStyle: false,
	};
});

describe("NotificationPreferencesForm — display section", () => {
	it("renders the stacked-cards switch unchecked by default", () => {
		render(<NotificationPreferencesForm />);
		expect(
			screen.getByRole("switch", { name: /stacked cards/i }),
		).toHaveAttribute("aria-checked", "false");
	});

	it("reflects the stored value when the preference is on", () => {
		mockData.current.stackedCardStyle = true;
		render(<NotificationPreferencesForm />);
		expect(
			screen.getByRole("switch", { name: /stacked cards/i }),
		).toHaveAttribute("aria-checked", "true");
	});

	it("sends only stackedCardStyle when toggled, never a delivery flag", () => {
		render(<NotificationPreferencesForm />);
		fireEvent.click(screen.getByRole("switch", { name: /stacked cards/i }));
		expect(mockUpdate).toHaveBeenCalledWith({ stackedCardStyle: true });
	});

	it("turns the preference back off", () => {
		mockData.current.stackedCardStyle = true;
		render(<NotificationPreferencesForm />);
		fireEvent.click(screen.getByRole("switch", { name: /stacked cards/i }));
		expect(mockUpdate).toHaveBeenCalledWith({ stackedCardStyle: false });
	});

	it("keeps the delivery toggles working and payload-clean", () => {
		render(<NotificationPreferencesForm />);
		fireEvent.click(screen.getByRole("switch", { name: /^Mentions$/i }));
		expect(mockUpdate).toHaveBeenCalledWith({ mentions: false });
	});

	it("labels the section so the two concerns read as distinct", () => {
		render(<NotificationPreferencesForm />);
		expect(screen.getByText("Display")).toBeInTheDocument();
	});
});
