import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

// Translation mock: return the key as-is
vi.mock("next-intl", () => ({
	useTranslations: () => {
		return (key: string) => key;
	},
}));

// Mock sonner toast
const mockToastError = vi.fn();
const mockToastSuccess = vi.fn();
vi.mock("sonner", () => ({
	toast: {
		error: (...args: unknown[]) => mockToastError(...args),
		success: (...args: unknown[]) => mockToastSuccess(...args),
	},
}));

// Mock authClient.deleteUser
const mockDeleteUser = vi.fn();
vi.mock("@repo/auth/client", () => ({
	authClient: {
		deleteUser: (...args: unknown[]) => mockDeleteUser(...args),
	},
}));

// Mock useUserAccountsQuery
const mockUseUserAccountsQuery = vi.fn();
vi.mock("@saas/auth/lib/api", () => ({
	useUserAccountsQuery: (...args: unknown[]) =>
		mockUseUserAccountsQuery(...args),
}));

// Track window.location.href assignments
const locationHrefSpy = vi.fn();
const originalLocation = window.location;

import { DeleteAccountForm } from "../DeleteAccountForm";

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});

	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			{children}
		</QueryClientProvider>
	);
}

describe("DeleteAccountForm", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Mock window.location with a proxy to track href assignments
		Object.defineProperty(window, "location", {
			writable: true,
			value: new Proxy(
				{ ...originalLocation, href: "/" },
				{
					set(target, prop, value) {
						if (prop === "href") {
							locationHrefSpy(value);
						}
						target[prop as keyof Location] = value;
						return true;
					},
				},
			),
		});
	});

	afterAll(() => {
		Object.defineProperty(window, "location", {
			writable: true,
			value: originalLocation,
		});
	});

	it("renders password field for credential users", async () => {
		// Arrange
		mockUseUserAccountsQuery.mockReturnValue({
			data: [{ providerId: "credential" }],
			isLoading: false,
		});

		const user = userEvent.setup();

		// Act
		render(<DeleteAccountForm />, { wrapper: createWrapper() });

		// Open the dialog
		await user.click(
			screen.getByRole("button", {
				name: "settings.account.deleteAccount.submit",
			}),
		);

		// Assert
		expect(
			screen.getByLabelText(
				"settings.account.deleteAccount.passwordField.label",
			),
		).toBeInTheDocument();
	});

	it("hides password field for OAuth-only users", async () => {
		// Arrange
		mockUseUserAccountsQuery.mockReturnValue({
			data: [{ providerId: "google" }],
			isLoading: false,
		});

		const user = userEvent.setup();

		// Act
		render(<DeleteAccountForm />, { wrapper: createWrapper() });

		// Open the dialog
		await user.click(
			screen.getByRole("button", {
				name: "settings.account.deleteAccount.submit",
			}),
		);

		// Assert
		expect(
			screen.queryByLabelText(
				"settings.account.deleteAccount.passwordField.label",
			),
		).not.toBeInTheDocument();
	});

	it("disables confirm button when password is empty for credential users", async () => {
		// Arrange
		mockUseUserAccountsQuery.mockReturnValue({
			data: [{ providerId: "credential" }],
			isLoading: false,
		});

		const user = userEvent.setup();

		// Act
		render(<DeleteAccountForm />, { wrapper: createWrapper() });

		await user.click(
			screen.getByRole("button", {
				name: "settings.account.deleteAccount.submit",
			}),
		);

		// Assert - the confirm button inside the dialog should be disabled
		const confirmButtons = screen.getAllByRole("button", {
			name: "settings.account.deleteAccount.submit",
		});
		// The second one is the AlertDialogAction inside the dialog
		const confirmButton = confirmButtons[confirmButtons.length - 1];
		expect(confirmButton).toBeDisabled();
	});

	it("shows field-level error on invalid password", async () => {
		// Arrange
		mockUseUserAccountsQuery.mockReturnValue({
			data: [{ providerId: "credential" }],
			isLoading: false,
		});
		mockDeleteUser.mockResolvedValue({
			error: { code: "INVALID_PASSWORD" },
		});

		const user = userEvent.setup();

		// Act
		render(<DeleteAccountForm />, { wrapper: createWrapper() });

		await user.click(
			screen.getByRole("button", {
				name: "settings.account.deleteAccount.submit",
			}),
		);

		// Type a password to enable the confirm button
		const passwordInput = screen.getByLabelText(
			"settings.account.deleteAccount.passwordField.label",
		);
		await user.type(passwordInput, "wrongpassword");

		// Click the confirm button inside the dialog
		const confirmButtons = screen.getAllByRole("button", {
			name: "settings.account.deleteAccount.submit",
		});
		const confirmButton = confirmButtons[confirmButtons.length - 1];
		await user.click(confirmButton);

		// Assert
		await waitFor(() => {
			expect(
				screen.getByText(
					"settings.account.deleteAccount.passwordField.invalidPassword",
				),
			).toBeInTheDocument();
		});

		// Verify it's a field-level error, not a toast
		expect(mockToastError).not.toHaveBeenCalled();
	});

	it("redirects to /auth/login on successful deletion", async () => {
		// Arrange
		mockUseUserAccountsQuery.mockReturnValue({
			data: [{ providerId: "google" }],
			isLoading: false,
		});
		mockDeleteUser.mockResolvedValue({ error: null });

		const user = userEvent.setup();

		// Act
		render(<DeleteAccountForm />, { wrapper: createWrapper() });

		await user.click(
			screen.getByRole("button", {
				name: "settings.account.deleteAccount.submit",
			}),
		);

		// For OAuth users, confirm button is immediately enabled
		const confirmButtons = screen.getAllByRole("button", {
			name: "settings.account.deleteAccount.submit",
		});
		const confirmButton = confirmButtons[confirmButtons.length - 1];
		await user.click(confirmButton);

		// Assert
		await waitFor(() => {
			expect(locationHrefSpy).toHaveBeenCalledWith("/auth/login");
		});
	});

	it("does not show success toast on successful deletion", async () => {
		// Arrange
		mockUseUserAccountsQuery.mockReturnValue({
			data: [{ providerId: "google" }],
			isLoading: false,
		});
		mockDeleteUser.mockResolvedValue({ error: null });

		const user = userEvent.setup();

		// Act
		render(<DeleteAccountForm />, { wrapper: createWrapper() });

		await user.click(
			screen.getByRole("button", {
				name: "settings.account.deleteAccount.submit",
			}),
		);

		const confirmButtons = screen.getAllByRole("button", {
			name: "settings.account.deleteAccount.submit",
		});
		const confirmButton = confirmButtons[confirmButtons.length - 1];
		await user.click(confirmButton);

		// Wait for the mutation to complete
		await waitFor(() => {
			expect(locationHrefSpy).toHaveBeenCalledWith("/auth/login");
		});

		// Assert
		expect(mockToastSuccess).not.toHaveBeenCalled();
	});

	it("shows error toast on non-password error", async () => {
		// Arrange
		mockUseUserAccountsQuery.mockReturnValue({
			data: [{ providerId: "google" }],
			isLoading: false,
		});
		mockDeleteUser.mockResolvedValue({
			error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
		});

		const user = userEvent.setup();

		// Act
		render(<DeleteAccountForm />, { wrapper: createWrapper() });

		await user.click(
			screen.getByRole("button", {
				name: "settings.account.deleteAccount.submit",
			}),
		);

		const confirmButtons = screen.getAllByRole("button", {
			name: "settings.account.deleteAccount.submit",
		});
		const confirmButton = confirmButtons[confirmButtons.length - 1];
		await user.click(confirmButton);

		// Assert
		await waitFor(() => {
			expect(mockToastError).toHaveBeenCalledWith(
				"settings.account.deleteAccount.notifications.error",
			);
		});
	});

	it("resets password and error when dialog closes and reopens", async () => {
		// Arrange
		mockUseUserAccountsQuery.mockReturnValue({
			data: [{ providerId: "credential" }],
			isLoading: false,
		});
		mockDeleteUser.mockResolvedValue({
			error: { code: "INVALID_PASSWORD" },
		});

		const user = userEvent.setup();

		// Act
		render(<DeleteAccountForm />, { wrapper: createWrapper() });

		// Open dialog
		await user.click(
			screen.getByRole("button", {
				name: "settings.account.deleteAccount.submit",
			}),
		);

		// Type a password
		const passwordInput = screen.getByLabelText(
			"settings.account.deleteAccount.passwordField.label",
		);
		await user.type(passwordInput, "wrongpassword");

		// Trigger the error
		const confirmButtons = screen.getAllByRole("button", {
			name: "settings.account.deleteAccount.submit",
		});
		await user.click(confirmButtons[confirmButtons.length - 1]);

		await waitFor(() => {
			expect(
				screen.getByText(
					"settings.account.deleteAccount.passwordField.invalidPassword",
				),
			).toBeInTheDocument();
		});

		// Close dialog by pressing the cancel button
		await user.click(
			screen.getByRole("button", { name: "common.confirmation.cancel" }),
		);

		// Reopen dialog
		await user.click(
			screen.getByRole("button", {
				name: "settings.account.deleteAccount.submit",
			}),
		);

		// Assert - password should be empty, no error shown
		await waitFor(() => {
			const newPasswordInput = screen.getByLabelText(
				"settings.account.deleteAccount.passwordField.label",
			);
			expect(newPasswordInput).toHaveValue("");
		});
		expect(
			screen.queryByText(
				"settings.account.deleteAccount.passwordField.invalidPassword",
			),
		).not.toBeInTheDocument();
	});
});
