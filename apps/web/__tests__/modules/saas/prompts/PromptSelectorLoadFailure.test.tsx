/**
 * Fizzy #2249: a failed `agents.available` read left the picker with nothing
 * to show but "No custom prompts available" — the same confident, wrong
 * empty-library claim inside a document/feature creation flow, with no way
 * to tell "nothing here" apart from "couldn't check", and no retry.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/PromptSelectorLoadFailure.test.tsx
 */

import { PromptSelector } from "@saas/prompts/components/PromptSelector";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { available } = vi.hoisted(() => ({ available: vi.fn() }));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		prompts: {
			agents: {
				available: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["prompts-available", input],
						queryFn: () => available(input),
					}),
				},
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { prompts: { bindings: { set: vi.fn() } } },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		isOrgContext: true,
		basePath: "/app/acme",
	}),
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({ isOrganizationAdmin: false }),
}));

vi.mock("@saas/prompts/components/PromptPreviewSheet", () => ({
	PromptPreviewSheet: () => null,
}));

function renderSelector(props: Record<string, unknown> = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<PromptSelector
				agentName="test_case_drafter"
				documentType="GENERAL"
				onValueChange={() => {}}
				{...props}
			/>
		</QueryClientProvider>,
	);
}

describe("PromptSelector — load failure", () => {
	beforeEach(() => {
		available.mockReset();
	});

	it("shows a retry state in the dropdown, not the empty-library copy", async () => {
		available.mockRejectedValue(new Error("upstream 500"));
		const user = userEvent.setup();
		renderSelector();

		await user.click(screen.getByRole("combobox"));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Could not load prompts.");
		expect(alert).not.toHaveTextContent("upstream 500");
		expect(
			screen.queryByText("No custom prompts available"),
		).not.toBeInTheDocument();
	});

	it("retries the read from the dropdown", async () => {
		available
			.mockRejectedValueOnce(new Error("upstream 500"))
			.mockResolvedValueOnce({ prompts: [] });
		const user = userEvent.setup();
		renderSelector();

		await user.click(screen.getByRole("combobox"));
		const alert = await screen.findByRole("alert");
		await user.click(
			within(alert).getByRole("button", { name: "Try again" }),
		);

		await screen.findByText("No custom prompts available");
		expect(available).toHaveBeenCalledTimes(2);
	});

	it("does not fall back to the default-prompt placeholder when a selection exists but failed to resolve", async () => {
		// A selected value (bound elsewhere, passed in as `value`) whose name we
		// can't load must not read as "use default" — something IS selected.
		available.mockRejectedValue(new Error("upstream 500"));
		renderSelector({ value: "bound-prompt-id" });

		expect(
			await screen.findByText("Could not load prompt"),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Use default prompt"),
		).not.toBeInTheDocument();
	});
});
