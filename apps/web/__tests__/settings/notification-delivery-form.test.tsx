/**
 * Tests for `NotificationDeliveryForm` — the delivery-channel settings
 * (in-app / email / webhook).
 *
 * The form reads three hooks from
 * `@saas/notifications/hooks/use-notification-delivery-preferences`, mocked
 * wholesale so the view is driven in isolation (no react-query, no oRPC).
 *
 * Coverage:
 *   (AC-8) In-app is rendered as a checked, disabled switch with no way off.
 *   (AC-7) Toggling email calls update.mutate with only `{ emailEnabled }`.
 *   (AC-4) Saving the webhook with a malformed URL shows an inline error and
 *          does NOT persist (mutate never called).
 *   (AC-3) Saving a valid webhook URL calls update.mutate with the URL.
 */

import type {
	NotificationDeliveryPreferences,
	UpdateDeliveryPreferencesInput,
} from "@saas/notifications/hooks/use-notification-delivery-preferences";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUpdate, mockRotate } = vi.hoisted(() => ({
	mockUpdate: vi.fn(),
	mockRotate: vi.fn(),
}));

const hookState: {
	data: NotificationDeliveryPreferences | undefined;
	isLoading: boolean;
	isError: boolean;
} = { data: undefined, isLoading: false, isError: false };

vi.mock(
	"@saas/notifications/hooks/use-notification-delivery-preferences",
	() => ({
		useNotificationDeliveryPreferences: () => ({
			data: hookState.data,
			isLoading: hookState.isLoading,
			isError: hookState.isError,
			refetch: vi.fn(),
		}),
		useUpdateNotificationDeliveryPreferences: () => ({
			mutate: mockUpdate,
			isPending: false,
		}),
		useRotateWebhookSecret: () => ({
			mutate: mockRotate,
			isPending: false,
		}),
	}),
);

import { NotificationDeliveryForm } from "../../modules/saas/settings/components/NotificationDeliveryForm";

function prefs(
	overrides: Partial<NotificationDeliveryPreferences> = {},
): NotificationDeliveryPreferences {
	return {
		emailEnabled: false,
		webhookEnabled: false,
		webhookUrl: null,
		hasWebhookSecret: false,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	hookState.data = prefs();
	hookState.isLoading = false;
	hookState.isError = false;
});

describe("NotificationDeliveryForm", () => {
	it("renders in-app as a checked, disabled switch with no way to turn it off (AC-8)", () => {
		render(<NotificationDeliveryForm />);
		const inApp = screen.getByRole("switch", {
			name: /In-app delivery/i,
		});
		expect(inApp).toBeChecked();
		expect(inApp).toBeDisabled();
	});

	it("toggling email calls update.mutate with only emailEnabled (AC-7)", () => {
		hookState.data = prefs({ emailEnabled: true });
		render(<NotificationDeliveryForm />);
		fireEvent.click(screen.getByRole("switch", { name: "Email delivery" }));
		expect(mockUpdate).toHaveBeenCalledTimes(1);
		expect(mockUpdate.mock.calls[0][0]).toEqual({ emailEnabled: false });
	});

	it("shows an inline error and blocks save on a malformed webhook URL (AC-4)", async () => {
		render(<NotificationDeliveryForm />);

		// Enable webhook (RHF field) then enter a malformed URL.
		fireEvent.click(
			screen.getByRole("switch", { name: "Webhook delivery" }),
		);
		fireEvent.change(screen.getByLabelText("Webhook URL"), {
			target: { value: "not-a-url" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByText(/valid http/i)).toBeInTheDocument();
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it("saves a valid webhook URL via update.mutate (AC-3)", async () => {
		render(<NotificationDeliveryForm />);

		fireEvent.click(
			screen.getByRole("switch", { name: "Webhook delivery" }),
		);
		fireEvent.change(screen.getByLabelText("Webhook URL"), {
			target: { value: "https://hooks.example.com/fabric" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		// handleSubmit is async — wait a tick for validation to pass.
		await vi.waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
		const input = mockUpdate.mock
			.calls[0][0] as UpdateDeliveryPreferencesInput;
		expect(input.webhookEnabled).toBe(true);
		expect(input.webhookUrl).toBe("https://hooks.example.com/fabric");
	});

	it("offers secret rotation when a signing secret is configured", () => {
		hookState.data = prefs({
			webhookEnabled: true,
			webhookUrl: "https://hooks.example.com/fabric",
			hasWebhookSecret: true,
		});
		render(<NotificationDeliveryForm />);
		expect(
			screen.getByRole("button", { name: /Rotate secret/i }),
		).toBeInTheDocument();
	});
});
