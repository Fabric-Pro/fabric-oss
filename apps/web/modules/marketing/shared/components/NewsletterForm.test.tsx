import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const subscribe = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		newsletter: { subscribe: (...a: unknown[]) => subscribe(...a) },
	},
}));

const messages = {
	newsletter: {
		email: "Email",
		submit: "Subscribe",
		privacyNote: "We respect your privacy. Unsubscribe at any time.",
		hints: {
			error: {
				message:
					"Could not subscribe to newsletter. Please try again later.",
			},
			success: {
				title: "Almost there",
				message: "Check your inbox to confirm your subscription.",
			},
		},
	},
};

// Override the global next-intl mock (vitest.setup.ts) so namespaced keys resolve.
vi.mock("next-intl", () => ({
	useTranslations: (namespace?: string) => (key: string) => {
		const path = namespace ? `${namespace}.${key}` : key;
		const resolved = path
			.split(".")
			.reduce<unknown>(
				(acc, part) =>
					acc && typeof acc === "object"
						? (acc as Record<string, unknown>)[part]
						: undefined,
				messages,
			);
		return typeof resolved === "string" ? resolved : path;
	},
}));

import { NewsletterForm } from "./NewsletterForm";

describe("NewsletterForm", () => {
	beforeEach(() => vi.clearAllMocks());

	it("subscribes and shows the success state", async () => {
		subscribe.mockResolvedValue({ success: true });
		render(<NewsletterForm />);
		await userEvent.type(screen.getByPlaceholderText("Email"), "a@b.com");
		await userEvent.click(
			screen.getByRole("button", { name: "Subscribe" }),
		);
		await waitFor(() =>
			expect(screen.getByText("Almost there")).toBeInTheDocument(),
		);
		expect(subscribe).toHaveBeenCalledWith({ email: "a@b.com" });
	});

	it("shows the inline error when subscribe rejects", async () => {
		subscribe.mockRejectedValue(new Error("nope"));
		render(<NewsletterForm />);
		await userEvent.type(screen.getByPlaceholderText("Email"), "a@b.com");
		await userEvent.click(
			screen.getByRole("button", { name: "Subscribe" }),
		);
		await waitFor(() =>
			expect(
				screen.getByText(
					"Could not subscribe to newsletter. Please try again later.",
				),
			).toBeInTheDocument(),
		);
		expect(screen.queryByText("Almost there")).not.toBeInTheDocument();
	});

	it("always renders the privacy note (travels to the embed iframe)", () => {
		render(<NewsletterForm />);
		expect(
			screen.getByText(
				"We respect your privacy. Unsubscribe at any time.",
			),
		).toBeInTheDocument();
	});

	it("exposes an accessible name on the email field (a11y)", () => {
		render(<NewsletterForm />);
		expect(
			screen.getByRole("textbox", { name: "Email" }),
		).toBeInTheDocument();
	});
});
