/**
 * FR14: reach the action's catalog entry from where the prompt is chosen.
 *
 * This selector is the control people actually meet during document generation.
 * It had "View Prompt" and "Manage prompts" but no route to the catalog, and the
 * link that closed that gap was asserted by nothing — in any of the three
 * components that render one.
 *
 * The part worth pinning is the destination. "Manage prompts" already went to
 * the library filtered by document type, which is a different and much vaguer
 * place; a link that quietly pointed there would look correct in a screenshot
 * and defeat the requirement.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/PromptSelectorCatalogLink.test.tsx
 */

import { promptActionId } from "@repo/utils/prompt-action-catalog";
import { PromptSelector } from "@saas/prompts/components/PromptSelector";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		prompts: {
			agents: {
				available: {
					queryOptions: () => ({
						queryKey: ["prompts-available"],
						queryFn: async () => ({ prompts: [] }),
					}),
				},
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { prompts: { bind: { set: vi.fn() } } },
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

beforeEach(() => {
	vi.clearAllMocks();
});

describe("FR14 — the catalog link on the prompt selector", () => {
	it("offers a way into the catalog", async () => {
		renderSelector();

		expect(
			await screen.findByRole("link", { name: /view in catalog/i }),
		).toBeInTheDocument();
	});

	it("points at this action's entry, not the whole library", async () => {
		// The distinction the requirement turns on: "Manage prompts" already
		// went to the library filtered by document type. Landing there again
		// would look right and miss the point.
		renderSelector();

		const link = await screen.findByRole("link", {
			name: /view in catalog/i,
		});
		const href = link.getAttribute("href") ?? "";

		expect(href).toContain("/prompts/catalog?action=");
		expect(href).toContain(
			encodeURIComponent(
				promptActionId("test_case_drafter", "GENERAL", null),
			),
		);
	});

	it("carries the story kind so a bug stage does not link to the feature one", async () => {
		renderSelector({
			agentName: "project_document_generator",
			documentType: "DRAFT",
			storyKind: "BUG",
		});

		const link = await screen.findByRole("link", {
			name: /view in catalog/i,
		});

		expect(link.getAttribute("href")).toContain(
			encodeURIComponent(
				promptActionId("project_document_generator", "DRAFT", "BUG"),
			),
		);
	});

	it("offers nothing when there is no action to point at", async () => {
		// Without a document type there is no action id to build, and a link to
		// a guessed one would land the reader somewhere arbitrary.
		renderSelector({ documentType: undefined });

		expect(
			screen.queryByRole("link", { name: /view in catalog/i }),
		).not.toBeInTheDocument();
	});
});
