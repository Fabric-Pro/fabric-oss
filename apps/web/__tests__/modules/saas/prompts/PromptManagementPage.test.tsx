/**
 * Fizzy #2249: a failed `prompts.list` read used to render "No prompts found"
 * — the same confident, wrong empty state as an organization with nothing in
 * its library, with no way to tell the two apart and no retry.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/PromptManagementPage.test.tsx
 */

import { PromptManagementPage } from "@saas/prompts/components/PromptManagementPage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listPrompts, listCategories } = vi.hoisted(() => ({
	listPrompts: vi.fn(),
	listCategories: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		prompts: {
			list: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["prompts.list", input],
					queryFn: () => listPrompts(input),
				}),
			},
			categories: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["prompts.categories", input],
					queryFn: () => listCategories(input),
				}),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { prompts: { fork: { fork: vi.fn() } } },
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		basePath: "/app/acme",
	}),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

// Needs a FeatureFlagProvider this test does not set up; irrelevant to the
// list-failure behavior under test.
vi.mock("@saas/prompts/components/PromptsHero", () => ({
	PromptsHero: () => null,
}));

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

describe("PromptManagementPage — list failure", () => {
	beforeEach(() => {
		listPrompts.mockReset();
		listCategories.mockReset();
		listCategories.mockResolvedValue({ categories: [] });
	});

	it("shows a retry state, not the empty-library copy", async () => {
		listPrompts.mockRejectedValue(new Error("upstream 500"));

		wrap(<PromptManagementPage organizationSlug="acme" />);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Could not load your prompts.");
		expect(alert).not.toHaveTextContent("upstream 500");
		expect(screen.queryByText("No prompts found")).not.toBeInTheDocument();
	});

	it("retries the read from the alert", async () => {
		listPrompts
			.mockRejectedValueOnce(new Error("upstream 500"))
			.mockResolvedValueOnce({ prompts: [] });
		const user = userEvent.setup();

		wrap(<PromptManagementPage organizationSlug="acme" />);

		const alert = await screen.findByRole("alert");
		await user.click(
			within(alert).getByRole("button", { name: "Try again" }),
		);

		await screen.findByText("No prompts found");
		expect(listPrompts).toHaveBeenCalledTimes(2);
	});
});
