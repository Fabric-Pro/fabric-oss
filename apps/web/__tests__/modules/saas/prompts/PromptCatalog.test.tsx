/**
 * Browsing prompts by the action they serve.
 *
 * The grid of actions is static and derived from what can actually be bound, so
 * these cover the parts that vary: that searching finds an action without first
 * knowing its feature type (FR13), and that each row says which prompt runs and
 * at which tier rather than merely that one exists (FR9).
 */

import { PromptCatalog } from "@saas/prompts/components/PromptCatalog";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { catalogList } = vi.hoisted(() => ({ catalogList: vi.fn() }));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: { catalog: { list: (i: unknown) => catalogList(i) } },
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		basePath: "/app/acme",
	}),
}));

const { searchParams } = vi.hoisted(() => ({
	searchParams: { current: new URLSearchParams() },
}));

vi.mock("next/navigation", () => ({
	useSearchParams: () => searchParams.current,
}));

// jsdom has no layout, so scrollIntoView is not implemented on elements.
beforeAll(() => {
	Element.prototype.scrollIntoView = vi.fn();
});

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

describe("PromptCatalog", () => {
	beforeEach(() => {
		catalogList.mockReset();
		catalogList.mockResolvedValue({ entries: [] });
		searchParams.current = new URLSearchParams();
	});

	it("groups actions under their feature type", async () => {
		wrap(<PromptCatalog />);

		expect(
			await screen.findByText(/project documents/i),
		).toBeInTheDocument();
		expect(screen.getByText(/quality & testing/i)).toBeInTheDocument();
		expect(
			screen.getByText(/security & accessibility/i),
		).toBeInTheDocument();
	});

	it("finds an action by name without picking a feature type first", async () => {
		const user = userEvent.setup();
		wrap(<PromptCatalog />);

		await user.type(
			await screen.findByLabelText(/search prompt actions/i),
			"test case",
		);

		// Matching actions are revealed; unrelated groups disappear entirely.
		expect(
			await screen.findByText(/^Test Case Drafter$/),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/security & accessibility/i),
		).not.toBeInTheDocument();
	});

	it("says so plainly when nothing matches the search", async () => {
		const user = userEvent.setup();
		wrap(<PromptCatalog />);

		await user.type(
			await screen.findByLabelText(/search prompt actions/i),
			"zzzznotathing",
		);

		expect(
			await screen.findByText(/no action matches/i),
		).toBeInTheDocument();
	});

	it("names the prompt in force and the tier it came from", async () => {
		catalogList.mockResolvedValue({
			entries: [
				{
					targetKey: "test_case_drafter",
					documentType: "GENERAL",
					storyKind: null,
					effectiveScope: "ORG",
					prompts: [
						{
							promptId: "p-org",
							promptName: "Our drafter",
							scope: "ORG",
							isDefault: true,
							isEffective: true,
						},
						{
							promptId: "p-sys",
							promptName: "Fabric drafter",
							scope: "SYSTEM",
							isDefault: true,
							isEffective: false,
						},
					],
				},
			],
		});

		const user = userEvent.setup();
		wrap(<PromptCatalog />);
		await user.click(await screen.findByText(/quality & testing/i));

		const row = (await screen.findByText("Our drafter")).closest("div");
		expect(row).not.toBeNull();
		expect(
			await screen.findByText(/default · organization/i),
		).toBeInTheDocument();
	});

	it("counts the other prompts available for the action", async () => {
		catalogList.mockResolvedValue({
			entries: [
				{
					targetKey: "test_case_drafter",
					documentType: "GENERAL",
					storyKind: null,
					effectiveScope: "SYSTEM",
					prompts: [
						{
							promptId: "p-sys",
							promptName: "Fabric drafter",
							scope: "SYSTEM",
							isDefault: true,
							isEffective: true,
						},
						{
							promptId: "p-alt",
							promptName: "Alternative",
							scope: "SYSTEM",
							isDefault: false,
							isEffective: false,
						},
					],
				},
			],
		});

		const user = userEvent.setup();
		wrap(<PromptCatalog />);
		await user.click(await screen.findByText(/quality & testing/i));

		expect(
			await screen.findByText(/1 other available/i),
		).toBeInTheDocument();
	});

	/** One prompt serving two actions, which is what FR20 is about. */
	const sharedPromptEntries = {
		entries: [
			{
				targetKey: "test_case_drafter",
				documentType: "GENERAL",
				storyKind: null,
				effectiveScope: "ORG",
				prompts: [
					{
						promptId: "p-shared",
						promptName: "Shared prompt",
						scope: "ORG",
						isDefault: true,
						isEffective: true,
					},
				],
			},
			{
				targetKey: "test_case_step_reviser",
				documentType: "GENERAL",
				storyKind: null,
				effectiveScope: "ORG",
				prompts: [
					{
						promptId: "p-shared",
						promptName: "Shared prompt",
						scope: "ORG",
						isDefault: true,
						isEffective: true,
					},
				],
			},
		],
	};

	it("says which other actions a shared prompt is also used for", async () => {
		catalogList.mockResolvedValue(sharedPromptEntries);

		const user = userEvent.setup();
		wrap(<PromptCatalog />);
		await user.click(await screen.findByText(/quality & testing/i));

		// Both rows cross-reference the other, and never themselves.
		const references = await screen.findAllByText(/also used for/i);
		expect(references.length).toBe(2);

		const links = screen.getAllByRole("link", {
			name: /test case step reviser/i,
		});
		expect(links.length).toBeGreaterThan(0);
		expect(links[0]).toHaveAttribute(
			"href",
			expect.stringContaining("action=test_case_step_reviser"),
		);
	});

	it("does not cross-reference a prompt bound to only one action", async () => {
		catalogList.mockResolvedValue({
			entries: [sharedPromptEntries.entries[0]],
		});

		const user = userEvent.setup();
		wrap(<PromptCatalog />);
		await user.click(await screen.findByText(/quality & testing/i));

		await screen.findByText("Shared prompt");
		expect(screen.queryByText(/also used for/i)).not.toBeInTheDocument();
	});

	it("opens the group a prompt deep link points into", async () => {
		// FR14: arriving from a selector at a collapsed page would show none of
		// what the link promised.
		catalogList.mockResolvedValue(sharedPromptEntries);
		searchParams.current = new URLSearchParams({ prompt: "p-shared" });

		wrap(<PromptCatalog />);

		// Expanded without anyone clicking the group open.
		expect(await screen.findAllByText("Shared prompt")).toHaveLength(2);
	});

	it("highlights the single action an action deep link names", async () => {
		catalogList.mockResolvedValue(sharedPromptEntries);
		searchParams.current = new URLSearchParams({
			action: "test_case_drafter:GENERAL:ANY",
		});

		const { container } = wrap(<PromptCatalog />);

		await screen.findByText("Test Case Drafter");
		const focused = container.querySelectorAll(".ring-primary");
		expect(focused).toHaveLength(1);
		expect(
			focused[0]
				.closest("[data-action-id]")
				?.getAttribute("data-action-id") ??
				focused[0].parentElement?.getAttribute("data-action-id"),
		).toBe("test_case_drafter:GENERAL:ANY");
	});

	it("does not present an unbound action as broken", async () => {
		// Most actions ship with no binding and fall back to the agent's
		// in-code text. Showing that as an error would be wrong and alarming.
		const user = userEvent.setup();
		wrap(<PromptCatalog />);
		await user.click(await screen.findByText(/quality & testing/i));

		await waitFor(async () =>
			expect(
				(await screen.findAllByText(/uses the built-in default/i))
					.length,
			).toBeGreaterThan(0),
		);
	});
});
