/**
 * Fizzy #2807: one prompt bound at two tiers arrives from `agents.available`
 * twice — once per binding, ranked by tier. A non-default ORG binding ranks
 * above the SYSTEM default of the same prompt, and keeping the first row lost
 * the default: no auto-selection, no badge, and the picker showed "Use default
 * prompt" for the prompt that is in fact the default. Every row now carries the
 * prompt's newest version (see `available-prompts-latest-version.test.ts` in
 * @repo/database); which row is kept decides only the default marking.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/PromptSelectorDuplicateBindings.test.tsx
 */

import { PromptSelector } from "@saas/prompts/components/PromptSelector";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { available, bindingsSet } = vi.hoisted(() => ({
	available: vi.fn(),
	bindingsSet: vi.fn(),
}));

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
	orpcClient: { prompts: { bindings: { set: bindingsSet } } },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		isOrgContext: true,
		basePath: "/app/example-org",
	}),
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({ isOrganizationAdmin: false }),
}));

vi.mock("@saas/prompts/components/PromptPreviewSheet", () => ({
	PromptPreviewSheet: () => null,
}));

/** One row per binding. `scope` is the prompt's own, so it is the same on
 *  both; the binding tier only decides the order. */
function row(isDefault: boolean) {
	return {
		id: "prompt_proposal",
		key: "proposal_template",
		name: "Project Proposal Document",
		description: null,
		scope: "SYSTEM",
		category: null,
		tags: [],
		forkedFrom: null,
		isBound: true,
		isDefault,
		contentSnippet: "Write the proposal.",
		// The prompt's newest version, the same on every row.
		latestVersion: { id: "pv_9", version: 9 },
	};
}

// Tier order, as the server ranks it: the ORG binding, not the default, before
// the SYSTEM binding that is.
const RANKED_ROWS = [row(false), row(true)];

function renderSelector(props: Record<string, unknown> = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<PromptSelector
				agentName="project_document_generator"
				documentType="PROPOSAL"
				onValueChange={() => {}}
				{...props}
			/>
		</QueryClientProvider>,
	);
}

describe("PromptSelector — one prompt bound at several tiers", () => {
	beforeEach(() => {
		available.mockReset();
		bindingsSet.mockReset();
		available.mockResolvedValue({ prompts: RANKED_ROWS });
		bindingsSet.mockResolvedValue({});
	});

	it("still selects the prompt as the default", async () => {
		const onValueChange = vi.fn();
		const onPromptVersionChange = vi.fn();
		renderSelector({ onValueChange, onPromptVersionChange });

		await waitFor(() =>
			expect(onValueChange).toHaveBeenCalledWith("prompt_proposal"),
		);
		expect(onPromptVersionChange).toHaveBeenCalledWith("pv_9");
	});

	it("binds the prompt's newest version", async () => {
		const user = userEvent.setup();
		renderSelector({ value: "prompt_proposal", showBindAction: true });

		await user.click(
			await screen.findByRole("button", { name: "Update Binding" }),
		);
		await user.click(
			await screen.findByRole("button", { name: "Bind as Default" }),
		);

		await waitFor(() => expect(bindingsSet).toHaveBeenCalledTimes(1));
		expect(bindingsSet).toHaveBeenCalledWith(
			expect.objectContaining({ promptVersionId: "pv_9" }),
		);
	});
});
