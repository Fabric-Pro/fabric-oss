import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailNotVerifiedAlert } from "../EmailNotVerifiedAlert";

// --- Mocks ---

// Translation mock: return the key with interpolated params
vi.mock("next-intl", () => ({
	useTranslations: () => {
		return (key: string, params?: Record<string, unknown>) => {
			if (params) {
				let result = key;
				for (const [k, v] of Object.entries(params)) {
					result = `${result}:${k}=${v}`;
				}
				return result;
			}
			return key;
		};
	},
}));

// oRPC client mock
const mockResendVerificationEmail = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		auth: {
			resendVerificationEmail: (...args: unknown[]) =>
				mockResendVerificationEmail(...args),
		},
	},
}));

describe("EmailNotVerifiedAlert", () => {
	const defaultProps = {
		email: "user@example.com",
	};

	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders initial state with error message and resend button", () => {
		render(<EmailNotVerifiedAlert {...defaultProps} />);

		expect(screen.getByText("emailNotVerified")).toBeInTheDocument();
		expect(screen.getByText("resendLink")).toBeInTheDocument();

		const button = screen.getByRole("button", { name: "resendLink" });
		expect(button).toBeEnabled();
	});

	it("disables button and shows loading state during sending", async () => {
		// Make the API call hang indefinitely
		mockResendVerificationEmail.mockReturnValue(new Promise(() => {}));

		const user = userEvent.setup();
		render(<EmailNotVerifiedAlert {...defaultProps} />);

		await user.click(screen.getByRole("button", { name: "resendLink" }));

		await waitFor(() => {
			expect(screen.getByText("resendSending")).toBeInTheDocument();
		});

		const sendingButton = screen.getByRole("button", {
			name: /resendSending/,
		});
		expect(sendingButton).toBeDisabled();
	});

	it("shows success message after successful send", async () => {
		mockResendVerificationEmail.mockResolvedValue({
			alreadyVerified: false,
			resetInSeconds: 60,
		});

		const user = userEvent.setup();
		render(<EmailNotVerifiedAlert {...defaultProps} />);

		await user.click(screen.getByRole("button", { name: "resendLink" }));

		await waitFor(() => {
			expect(screen.getByText("resendSuccess")).toBeInTheDocument();
		});
	});

	it("shows countdown timer after send and decrements", async () => {
		// `shouldAdvanceTime: true` is required: vitest fake timers also
		// intercept the internal timers used by userEvent.click and
		// waitFor — without auto-advance, they never fire and the test
		// hangs until the per-test timeout.
		vi.useFakeTimers({ shouldAdvanceTime: true });

		mockResendVerificationEmail.mockResolvedValue({
			alreadyVerified: false,
			resetInSeconds: 3,
		});

		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		render(<EmailNotVerifiedAlert {...defaultProps} />);

		await user.click(screen.getByRole("button", { name: "resendLink" }));

		await waitFor(() => {
			expect(
				screen.getByText("resendCountdown:seconds=3"),
			).toBeInTheDocument();
		});

		// `advanceTimersByTimeAsync` fires the setInterval callback and then
		// awaits the microtask queue, which gives React time to commit the
		// resulting setSecondsLeft update before this awaits returns. The
		// previous `act(async () => vi.advanceTimersByTime(...))` form still
		// raced the commit on heavily-loaded CI (#690).
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(
			screen.getByText("resendCountdown:seconds=2"),
		).toBeInTheDocument();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(
			screen.getByText("resendCountdown:seconds=1"),
		).toBeInTheDocument();
	});

	it("resumes timer from localStorage when mounted with a future resendAllowedAt", () => {
		vi.useFakeTimers();
		const now = Date.now();

		// Set localStorage with a timestamp 30 seconds in the future
		const storageKey = "fabric:verify-resend:user@example.com";
		localStorage.setItem(
			storageKey,
			JSON.stringify({ resendAllowedAt: now + 30000 }),
		);

		render(<EmailNotVerifiedAlert {...defaultProps} />);

		// Should show "sent" state with countdown (since isActive is true on mount)
		expect(screen.getByText("resendSuccess")).toBeInTheDocument();
		expect(
			screen.getByText("resendCountdown:seconds=30"),
		).toBeInTheDocument();
	});

	it("clears expired localStorage and shows no timer", () => {
		vi.useFakeTimers();

		// Set localStorage with a timestamp in the past
		const storageKey = "fabric:verify-resend:user@example.com";
		localStorage.setItem(
			storageKey,
			JSON.stringify({ resendAllowedAt: Date.now() - 5000 }),
		);

		render(<EmailNotVerifiedAlert {...defaultProps} />);

		// Should show initial state, not "sent" state
		expect(screen.getByText("emailNotVerified")).toBeInTheDocument();
		expect(screen.queryByText(/resendCountdown/)).not.toBeInTheDocument();

		// localStorage should have been cleared
		expect(localStorage.getItem(storageKey)).toBeNull();
	});

	it("shows rate limit message without countdown for hourly/IP limits", async () => {
		mockResendVerificationEmail.mockRejectedValue({
			code: "TOO_MANY_REQUESTS",
			data: { retryAfter: 900 },
		});

		const user = userEvent.setup();
		render(<EmailNotVerifiedAlert {...defaultProps} />);

		await user.click(screen.getByRole("button", { name: "resendLink" }));

		await waitFor(() => {
			expect(screen.getByText("rateLimited")).toBeInTheDocument();
		});

		// No countdown for hourly/IP limits (no isPerMinuteLimit flag)
		expect(screen.queryByText(/resendCountdown/)).not.toBeInTheDocument();
	});

	it("shows rate limit message with countdown for per-minute limit", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });

		mockResendVerificationEmail.mockRejectedValue({
			code: "TOO_MANY_REQUESTS",
			data: { retryAfter: 45, isPerMinuteLimit: true },
		});

		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		render(<EmailNotVerifiedAlert {...defaultProps} />);

		await user.click(screen.getByRole("button", { name: "resendLink" }));

		await waitFor(() => {
			expect(screen.getByText("rateLimited")).toBeInTheDocument();
		});

		// Should show countdown for per-minute limit
		expect(
			screen.getByText("resendCountdown:seconds=45"),
		).toBeInTheDocument();
	});

	it("shows generic error message on network failure", async () => {
		mockResendVerificationEmail.mockRejectedValue(
			new Error("Network error"),
		);

		const user = userEvent.setup();
		render(<EmailNotVerifiedAlert {...defaultProps} />);

		await user.click(screen.getByRole("button", { name: "resendLink" }));

		await waitFor(() => {
			expect(screen.getByText("genericError")).toBeInTheDocument();
		});

		// Should also show retry button
		expect(
			screen.getByRole("button", { name: "resendLink" }),
		).toBeInTheDocument();
	});

	describe("inline variant", () => {
		it("renders the resend button in the initial state WITHOUT the error-alert title", () => {
			render(
				<EmailNotVerifiedAlert {...defaultProps} variant="inline" />,
			);

			expect(
				screen.queryByText("emailNotVerified"),
			).not.toBeInTheDocument();

			const button = screen.getByRole("button", { name: "resendLink" });
			expect(button).toBeEnabled();
		});

		it("keeps the loading state free of the error title while sending", async () => {
			mockResendVerificationEmail.mockReturnValue(new Promise(() => {}));

			const user = userEvent.setup();
			render(
				<EmailNotVerifiedAlert {...defaultProps} variant="inline" />,
			);

			await user.click(
				screen.getByRole("button", { name: "resendLink" }),
			);

			await waitFor(() => {
				expect(screen.getByText("resendSending")).toBeInTheDocument();
			});
			expect(
				screen.queryByText("emailNotVerified"),
			).not.toBeInTheDocument();
		});

		it("shows the shared success alert after a successful resend", async () => {
			mockResendVerificationEmail.mockResolvedValue({
				alreadyVerified: false,
				resetInSeconds: 60,
			});

			const user = userEvent.setup();
			render(
				<EmailNotVerifiedAlert {...defaultProps} variant="inline" />,
			);

			await user.click(
				screen.getByRole("button", { name: "resendLink" }),
			);

			await waitFor(() => {
				expect(screen.getByText("resendSuccess")).toBeInTheDocument();
			});
			expect(mockResendVerificationEmail).toHaveBeenCalledWith(
				expect.objectContaining({ email: "user@example.com" }),
			);
		});

		it("arms the cooldown on mount with startCooldownOnMount: button disabled + countdown shown", () => {
			vi.useFakeTimers();

			render(
				<EmailNotVerifiedAlert
					{...defaultProps}
					variant="inline"
					startCooldownOnMount
				/>,
			);

			// Compact initial block — neither the post-resend success alert
			// nor the error chrome.
			expect(screen.queryByText("resendSuccess")).not.toBeInTheDocument();
			expect(
				screen.queryByText("emailNotVerified"),
			).not.toBeInTheDocument();

			expect(
				screen.getByText("resendCountdown:seconds=60"),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "resendLink" }),
			).toBeDisabled();

			// Persisted, so a refresh resumes the cooldown instead of
			// allowing an instant resend.
			expect(
				localStorage.getItem("fabric:verify-resend:user@example.com"),
			).not.toBeNull();
		});

		it("resumes (does NOT restart) an already-active cooldown on mount", () => {
			vi.useFakeTimers();

			const storageKey = "fabric:verify-resend:user@example.com";
			localStorage.setItem(
				storageKey,
				JSON.stringify({ resendAllowedAt: Date.now() + 30000 }),
			);

			render(
				<EmailNotVerifiedAlert
					{...defaultProps}
					variant="inline"
					startCooldownOnMount
				/>,
			);

			// 30s remaining — not reset to a fresh 60s
			expect(
				screen.getByText("resendCountdown:seconds=30"),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "resendLink" }),
			).toBeDisabled();
			// Inline variant stays compact even with an active countdown
			expect(screen.queryByText("resendSuccess")).not.toBeInTheDocument();
		});
	});
});
