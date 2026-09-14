/**
 * The confirmation page must say WHICH organization it is about to destroy
 * (Fizzy #2462).
 *
 * This is the last screen before a tenant goes dark. It shipped reading "Delete
 * this organization?", which is exactly the question someone who owns more than
 * one needs answered before pressing the button. The name is resolved from the
 * token server-side, so the two assertions worth making are that the page asks
 * for it with the right proof, and that a link it cannot resolve still renders
 * a usable page rather than an error.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn((url: string) => {
	throw new Error(`REDIRECT:${url}`);
});

vi.mock("next/navigation", () => ({
	redirect: redirectMock,
	useRouter: () => ({ replace: vi.fn() }),
}));

// Resolved against the REAL `en.json` through the real ICU translator, not the
// usual `(key) => key` identity mock. An identity mock would assert that the
// component asked for `titleNamed` and prove nothing about what the person
// reading the page sees — which is the entire bug. This way the assertions read
// the delivered sentence, so a missing key or a placeholder that never
// interpolates fails here.
vi.mock("next-intl", async () => {
	const { createTranslator } =
		await vi.importActual<typeof import("next-intl")>("next-intl");
	const messages = (
		await import("../../../../packages/i18n/translations/en.json")
	).default;
	const t = createTranslator({ locale: "en", messages }) as (
		key: string,
		values?: Record<string, unknown>,
	) => string;

	return {
		useTranslations: () => t,
	};
});

vi.mock("@saas/auth/lib/server", () => ({
	getSession: vi.fn(async () => ({ user: { id: "user-example" } })),
}));

const fetchName = vi.fn();
vi.mock(
	"@repo/api/modules/organizations/procedures/deletion/server-fetch",
	() => ({
		fetchOrganizationNameForDeletionToken: (args: unknown) =>
			fetchName(args),
	}),
);

vi.mock("@repo/database", () => ({
	ORGANIZATION_RETENTION_DAYS: 30,
}));

const PAGE = "../../app/organizations/confirm-deletion/page";

// The page renders a client component that opens a mutation on mount.
function renderPage(ui: ReactNode) {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			{ui}
		</QueryClientProvider>,
	);
}

describe("emailed deletion-confirmation page", () => {
	beforeEach(() => {
		redirectMock.mockClear();
		fetchName.mockReset();
	});

	afterEach(() => cleanup());

	it("names the organization in the heading and the body", async () => {
		fetchName.mockResolvedValue("Example Org");
		const { default: Page } = await import(PAGE);

		renderPage(
			await Page({
				searchParams: Promise.resolve({ token: "tok-example" }),
			}),
		);

		expect(
			screen.getByRole("heading", { name: "Delete Example Org?" }),
		).toBeTruthy();
		expect(
			screen.getByText(/You asked to delete Example Org\./),
		).toBeTruthy();
	});

	it("proves who is asking before it resolves the name", async () => {
		fetchName.mockResolvedValue("Example Org");
		const { default: Page } = await import(PAGE);

		await Page({
			searchParams: Promise.resolve({ token: "tok-example" }),
		});

		// The session's own user id, never anything from the URL — otherwise a
		// leaked link would name the organization to whoever opened it.
		expect(fetchName).toHaveBeenCalledWith({
			token: "tok-example",
			userId: "user-example",
		});
	});

	it("still renders a usable page when the token cannot be resolved", async () => {
		// Expired, already spent, or issued to another account. The page keeps
		// its unnamed copy and the button: `confirm` owns the one refusal
		// message for every way a token can be invalid, so failing here would
		// be a second, subtly different verdict on the same link.
		fetchName.mockResolvedValue(null);
		const { default: Page } = await import(PAGE);

		renderPage(
			await Page({
				searchParams: Promise.resolve({ token: "tok-expired" }),
			}),
		);

		expect(
			screen.getByRole("heading", { name: "Delete this organization?" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Delete organization" }),
		).toBeTruthy();
	});
});
