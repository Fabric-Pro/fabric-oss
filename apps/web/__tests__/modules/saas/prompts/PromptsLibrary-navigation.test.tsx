import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	params: new URLSearchParams(),
	push: vi.fn(),
	total: 51,
	offsets: [] as number[],
}));
vi.mock("next/navigation", () => ({
	useSearchParams: () => m.params,
	useRouter: () => ({ push: m.push }),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ basePath: "/app/example-org" }),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		prompts: {
			list: {
				queryOptions: ({ input }: any) => ({
					queryKey: ["list", input.offset],
					queryFn: async () => {
						m.offsets.push(input.offset);
						return {
							total: m.total,
							prompts:
								m.total === 50 && input.offset === 50
									? []
									: [
											{
												id: "example-prompt",
												name: "Example prompt",
											},
										],
						};
					},
				}),
			},
		},
	},
}));
vi.mock("@saas/prompts/components/PromptCard", () => ({
	PromptCard: ({ onUpdate }: any) => (
		<button
			data-testid="grid-prompt"
			type="button"
			onClick={() => {
				m.total = 50;
				onUpdate();
			}}
		>
			Delete last page item
		</button>
	),
}));
vi.mock("@saas/prompts/components/PromptsListView", () => ({
	PromptsListView: ({ onUpdate }: any) => (
		<button
			type="button"
			data-testid="list-prompt"
			onClick={() => {
				m.total = 50;
				onUpdate();
			}}
		>
			Delete last page item
		</button>
	),
}));
vi.mock("@saas/prompts/components/PromptsHero", () => ({
	PromptsHero: () => null,
}));
vi.mock("@saas/prompts/components/PromptCatalog", () => ({
	PromptCatalog: () => <p>Actions catalog</p>,
}));

import { PromptsList } from "@saas/prompts/components/PromptsList";

const mount = () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<PromptsList organizationId="example-org" />
		</QueryClientProvider>,
	);
};
beforeEach(() => {
	m.params = new URLSearchParams();
	m.push.mockReset();
	m.total = 51;
	m.offsets = [];
	window.history.replaceState({}, "", "/app/example-org/prompts");
});
it("activates action and prompt deep links received after the library has mounted", async () => {
	const v = mount();
	await screen.findByRole("button", { name: "Delete last page item" });
	m.params = new URLSearchParams("action=example-action");
	v.rerender(
		<QueryClientProvider client={new QueryClient()}>
			<PromptsList organizationId="example-org" />
		</QueryClientProvider>,
	);
	await screen.findByText("Actions catalog");
	expect(
		screen.getByRole("tab", { name: "Actions", exact: true }),
	).toHaveAttribute("aria-selected", "true");
	fireEvent.click(screen.getByRole("tab", { name: "Prompts", exact: true }));
	m.params = new URLSearchParams("prompt=example-prompt");
	v.rerender(
		<QueryClientProvider client={new QueryClient()}>
			<PromptsList organizationId="example-org" />
		</QueryClientProvider>,
	);
	await waitFor(() =>
		expect(
			screen.getByRole("tab", { name: "Actions", exact: true }),
		).toHaveAttribute("aria-selected", "true"),
	);
});
it("retains Previous after deletion reduces page two to an empty result", async () => {
	m.params = new URLSearchParams("page=1");
	window.history.replaceState({}, "", "/app/example-org/prompts?page=1");
	mount();
	await waitFor(() => expect(m.offsets).toContain(50));
	fireEvent.click(
		await screen.findByRole("button", { name: "Delete last page item" }),
	);
	await screen.findByText(
		"No prompts on this page. Go back to the previous page.",
	);
	expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
	fireEvent.click(screen.getByRole("button", { name: "Previous" }));
	await waitFor(() => expect(m.offsets.at(-1)).toBe(0));
});

it("defaults to a scannable list and persists an explicit grid preference", async () => {
	mount();
	await screen.findByTestId("list-prompt");
	expect(screen.queryByTestId("grid-prompt")).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
	await screen.findByTestId("grid-prompt");
	await waitFor(() =>
		expect(new URLSearchParams(window.location.search).get("view")).toBe(
			"grid",
		),
	);
	fireEvent.click(screen.getByRole("button", { name: "List view" }));
	await screen.findByTestId("list-prompt");
	await waitFor(() =>
		expect(new URLSearchParams(window.location.search).has("view")).toBe(
			false,
		),
	);
});
it("restores shared grid links", async () => {
	m.params = new URLSearchParams("view=grid");
	mount();
	await screen.findByTestId("grid-prompt");
	expect(screen.queryByTestId("list-prompt")).not.toBeInTheDocument();
});

it.each([
	["My Overrides", "my-overrides"],
	["Org Overrides", "governance"],
	["Proposed defaults", "nominations"],
])("keeps %s reachable through the Defaults menu", async (label, path) => {
	mount();
	await screen.findByTestId("list-prompt");
	expect(
		screen.queryByRole("menuitem", { name: label }),
	).not.toBeInTheDocument();
	const user = userEvent.setup();
	await user.click(
		screen.getByRole("button", { name: "Defaults", exact: true }),
	);
	await user.click(
		screen.getByRole("menuitem", { name: label, exact: true }),
	);
	expect(m.push).toHaveBeenCalledWith(`/app/example-org/prompts/${path}`);
});
