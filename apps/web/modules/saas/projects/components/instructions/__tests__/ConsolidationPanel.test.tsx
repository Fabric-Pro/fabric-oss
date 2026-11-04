import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConsolidationPanel } from "../ConsolidationPanel";

const started = vi.fn();

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../RepositoryChoice", () => ({
	RepositoryChoice: () => <p>example-org/example-product</p>,
}));

const files = [
	{
		path: ".claude/rules/git.md",
		to: "rules/git.md",
		target: "RULE",
		tool: "claude",
		defaultIncluded: true,
		group: "development",
		selected: true,
	},
	{
		path: "CLAUDE.md",
		to: "CLAUDE.md",
		target: "INSTRUCTIONS",
		tool: "shared",
		defaultIncluded: true,
		group: "development",
		selected: true,
	},
	{
		path: ".claude/skills/example-product-setup/SKILL.md",
		to: "skills/example-product-setup/SKILL.md",
		target: "SKILL",
		tool: "claude",
		defaultIncluded: true,
		group: "product",
		reason: "used by .claude-plugin/plugin.json (skills)",
		selected: false,
	},
	{
		path: "AGENTS.md",
		to: "AGENTS.md",
		target: "INSTRUCTIONS",
		tool: "shared",
		defaultIncluded: true,
		group: "product",
		reason: "the repository is itself a plugin (.claude-plugin/plugin.json at its root), and the plugin ships AGENTS.md to its users",
		selected: false,
	},
];

vi.mock("@shared/lib/orpc-query-utils", () => {
	const key = () => ["repositorySync"];
	return {
		orpc: {
			projects: {
				instructions: {
					key: () => ["instructions"],
					repositorySync: {
						key,
						getConsolidation: {
							queryOptions: () => ({
								queryKey: ["consolidation"],
								queryFn: async () => ({ run: null }),
							}),
						},
						get: {
							queryOptions: () => ({
								queryKey: ["sync"],
								queryFn: async () => ({
									configured: null,
									availableIntegrations: [
										{
											id: "int-code",
											repositoryOwner: "example-org",
											repositoryName: "example-product",
										},
									],
								}),
							}),
						},
						retryConsolidation: {
							mutationOptions: () => ({
								mutationFn: async () => ({}),
							}),
						},
						previewConsolidation: {
							mutationOptions: () => ({
								mutationFn: async () => ({
									repository: {
										owner: "example-org",
										name: "example-product",
										defaultBranch: "main",
									},
									files,
									skipped: [],
									truncated: false,
									suggested: {
										owner: "example-org",
										name: "example-product-ai-instructions",
									},
									storedTokenAvailable: true,
								}),
							}),
						},
						startConsolidation: {
							mutationOptions: () => ({
								mutationFn: async (input: unknown) => {
									started(input);
									return { run: null };
								},
							}),
						},
					},
				},
			},
		},
	};
});

function renderPanel() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<ConsolidationPanel projectId="proj-1" canEdit />
		</QueryClientProvider>,
	);
}

async function openReview() {
	renderPanel();
	const open = await screen.findByRole("button", {
		name: "Move AI files out",
	});
	await waitFor(() => expect(open).toBeEnabled());
	fireEvent.click(open);
	return screen.findByRole("group", {
		name: /Shipped with your product \(stay\)/,
	});
}

describe("ConsolidationPanel review", () => {
	beforeEach(() => started.mockClear());

	it("groups development files (checked) and product files (unchecked, with a reason)", async () => {
		const product = await openReview();
		const development = screen.getByRole("group", {
			name: /Development instructions \(move\)/,
		});
		expect(
			within(development).getByRole("checkbox", {
				name: /\.claude\/rules\/git\.md/,
			}),
		).toBeChecked();
		const skill = within(product).getByRole("checkbox", {
			name: /example-product-setup\/SKILL\.md/,
		});
		expect(skill).not.toBeChecked();
		expect(skill).toHaveAccessibleDescription(
			"used by .claude-plugin/plugin.json (skills)",
		);
		expect(
			within(product).getByText(/plugin ships AGENTS\.md/),
		).toBeInTheDocument();
		expect(screen.getByText("2 of 4 files selected")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Move 2 files" }),
		).toBeEnabled();
	});

	it("updates the counts and sends only the checked paths", async () => {
		const product = await openReview();
		fireEvent.click(
			within(product).getByRole("checkbox", { name: /AGENTS\.md/ }),
		);
		fireEvent.click(screen.getByRole("checkbox", { name: /^CLAUDE\.md/ }));
		expect(screen.getByText("2 of 4 files selected")).toBeInTheDocument();
		expect(
			screen.getByRole("group", {
				name: /Shipped with your product \(stay\) · 1 selected/,
			}),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Move 2 files" }));
		await waitFor(() => expect(started).toHaveBeenCalledTimes(1));
		expect(started.mock.calls[0]?.[0]).toMatchObject({
			projectId: "proj-1",
			repositoryIntegrationId: "int-code",
			include: [".claude/rules/git.md", "AGENTS.md"],
		});
	});

	it("never sends a product file the person left unchecked", async () => {
		await openReview();
		fireEvent.click(screen.getByRole("button", { name: "Move 2 files" }));
		await waitFor(() => expect(started).toHaveBeenCalledTimes(1));
		const include = (started.mock.calls[0]?.[0] as { include: string[] })
			.include;
		expect(include).toEqual([".claude/rules/git.md", "CLAUDE.md"]);
	});
});
