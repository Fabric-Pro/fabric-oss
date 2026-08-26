import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

const confirm = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		newsletter: { confirmSubscription: (...a: unknown[]) => confirm(...a) },
	},
}));

const messages = {
	newsletter: {
		confirm: {
			title: "Confirm your subscription",
			prompt: "Click below to confirm.",
			confirmCta: "Confirm subscription",
			success: {
				title: "You're subscribed",
				message: "Thanks for confirming.",
			},
			invalid: {
				title: "Link invalid or expired",
				message: "Already used.",
			},
			error: "Something went wrong. Please try again.",
		},
	},
};

// The global next-intl mock (vitest.setup.ts) makes useTranslations echo the key
// and turns NextIntlClientProvider into a passthrough — so it cannot resolve the
// `newsletter.confirm.*` strings these assertions check. Override it locally
// (the documented escape hatch) with a namespace-aware resolver reading from the
// same `messages` object, mirroring AuditLogTable.correlation-copy.test.tsx.
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
	useLocale: () => "en",
	NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
		children,
}));

import { ConfirmSubscription } from "./ConfirmSubscription";

function setup(token = "tok-1234567890") {
	return render(
		<NextIntlClientProvider locale="en" messages={messages}>
			<ConfirmSubscription token={token} />
		</NextIntlClientProvider>,
	);
}

describe("ConfirmSubscription", () => {
	beforeEach(() => vi.clearAllMocks());

	it("does NOT confirm on render (anti-prefetch) — only on click", () => {
		setup();
		expect(confirm).not.toHaveBeenCalled();
		expect(
			screen.getByText("Confirm your subscription"),
		).toBeInTheDocument();
	});

	it("shows success when confirm returns confirmed:true", async () => {
		confirm.mockResolvedValue({ confirmed: true });
		setup();
		await userEvent.click(
			screen.getByRole("button", { name: "Confirm subscription" }),
		);
		await waitFor(() =>
			expect(screen.getByText("You're subscribed")).toBeInTheDocument(),
		);
		expect(confirm).toHaveBeenCalledWith({ token: "tok-1234567890" });
	});

	it("shows invalid when confirm returns confirmed:false", async () => {
		confirm.mockResolvedValue({ confirmed: false });
		setup();
		await userEvent.click(
			screen.getByRole("button", { name: "Confirm subscription" }),
		);
		await waitFor(() =>
			expect(
				screen.getByText("Link invalid or expired"),
			).toBeInTheDocument(),
		);
	});
});
