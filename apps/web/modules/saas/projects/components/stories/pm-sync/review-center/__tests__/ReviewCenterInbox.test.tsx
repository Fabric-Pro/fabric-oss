import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reviewCenterCount = vi.fn();
const reviewCenterItems = vi.fn();

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		basePath: "/app",
	}),
}));

vi.mock("next/navigation", () => ({
	useParams: () => ({ id: "project_1" }),
	// The panel's "View all in Sync History" footer deep-links via the URL.
	useRouter: () => ({ replace: vi.fn() }),
	usePathname: () => "/app/projects/project_1",
	useSearchParams: () => new URLSearchParams("tab=stories"),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			reviewCenter: {
				count: (...args: unknown[]) => reviewCenterCount(...args),
				items: (...args: unknown[]) => reviewCenterItems(...args),
			},
			// The tabbed panel self-fetches PM capabilities for the Sync Drift
			// placeholder; stub it so opening the panel doesn't throw.
			stories: {
				pmCapabilities: vi.fn().mockResolvedValue({ configured: true }),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

// Radix primitive shims under jsdom.
if (!(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
	(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
}
if (!Element.prototype.hasPointerCapture) {
	Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}

import { ReviewCenterInbox } from "../ReviewCenterInbox";

function renderInbox() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<ReviewCenterInbox />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	reviewCenterCount.mockReset();
	reviewCenterItems.mockReset();
	reviewCenterItems.mockResolvedValue({
		conflicts: [],
		failures: [],
		pullDrift: [],
		total: 0,
	});
});

afterEach(() => cleanup());

/** The badge reads `.total`; categories are irrelevant to the badge itself. */
function countResult(total: number) {
	return {
		conflictsCount: total,
		failuresCount: 0,
		pullDriftCount: 0,
		total,
	};
}

describe("ReviewCenterInbox (7.1)", () => {
	it("renders the count badge with an accessible label when there are items", async () => {
		reviewCenterCount.mockResolvedValue(countResult(3));
		renderInbox();

		const button = await screen.findByRole("button", {
			name: "Sync issues 3",
		});
		expect(button).toBeInTheDocument();
		expect(button).toHaveTextContent("Sync issues 3");
		expect(button).toHaveClass("border", "h-8", "text-sm");
		expect(button.querySelector("span")).not.toHaveClass("text-xs");
		expect(button.querySelector("[class*=animate-ping]")).toBeNull();
	});

	it("renders nothing when the actionable count is zero", async () => {
		reviewCenterCount.mockResolvedValue(countResult(0));
		const { container } = renderInbox();

		// Give the query a tick to resolve, then assert no button rendered.
		await waitFor(() => expect(reviewCenterCount).toHaveBeenCalled());
		expect(
			screen.queryByRole("button", { name: /Sync issues/ }),
		).not.toBeInTheDocument();
		expect(container.querySelector("button")).toBeNull();
	});

	it("uses singular wording for a single item", async () => {
		reviewCenterCount.mockResolvedValue(countResult(1));
		renderInbox();

		expect(
			await screen.findByRole("button", {
				name: "Sync issues 1",
			}),
		).toBeInTheDocument();
	});

	it("opens the slide-over panel on click (keyboard-activatable button)", async () => {
		reviewCenterCount.mockResolvedValue(countResult(2));
		const user = userEvent.setup();
		renderInbox();

		const button = await screen.findByRole("button", {
			name: "Sync issues 2",
		});
		await user.click(button);

		expect(
			await screen.findByRole("dialog", { name: /Items to review/ }),
		).toBeInTheDocument();
	});
});

vi.mock("next-intl", async (importOriginal) => {
	const actual = await importOriginal<typeof import("next-intl")>();
	const { default: messages } = await import(
		"@repo/i18n/translations/en.json"
	);
	return {
		...actual,
		useTranslations: (namespace: string) =>
			actual.createTranslator({ locale: "en", messages, namespace }),
	};
});
