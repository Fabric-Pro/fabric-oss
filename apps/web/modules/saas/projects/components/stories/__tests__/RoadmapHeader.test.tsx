import { orpc } from "@shared/lib/orpc-query-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "@ui/components/button";
import { CompassIcon, InboxIcon } from "lucide-react";
import { beforeEach, expect, it, vi } from "vitest";
import { EMPTY_ROADMAP_FILTERS } from "../../../lib/roadmap-filters";
import { RoadmapActionsMenu } from "../RoadmapActionsMenu";
import { RoadmapFilterToolbar } from "../RoadmapFilterToolbar";
import { RoadmapHeader } from "../RoadmapHeader";
import { RoadmapSortControl } from "../RoadmapSortControl";

const state = vi.hoisted(() => ({ proposals: 1, stages: 2, sync: 113 }));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: null, basePath: "/app" }),
}));
vi.mock("next/navigation", () => ({
	useParams: () => ({ id: "project_1" }),
	useRouter: () => ({ replace: vi.fn() }),
	usePathname: () => "/app/projects/project_1",
	useSearchParams: () => new URLSearchParams("tab=stories"),
}));
vi.mock("@saas/get-started/components/PageTourButton", () => ({
	PageTourButton: () => (
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label="Get started with this page"
		>
			<CompassIcon aria-hidden className="size-4" />
		</Button>
	),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			reviewCenter: {
				count: async () => ({
					total: state.sync,
					conflictsCount: state.sync,
					failuresCount: 0,
					pullDriftCount: 0,
				}),
				items: async () => ({
					conflicts: [],
					failures: [],
					pullDrift: [],
					total: 0,
				}),
			},
			teamsChannelMonitor: {
				pendingProposals: {
					count: async () => ({ count: state.proposals }),
				},
			},
			stories: {
				listStageRequests: async () => ({
					requests: Array.from(
						{ length: state.stages },
						(_, index) => ({ id: `request-${index}` }),
					),
				}),
				pmCapabilities: async () => ({ configured: true }),
				tags: { list: async () => ({ tags: ["Release"] }) },
			},
		},
	},
}));
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
beforeEach(() => {
	state.proposals = 1;
	state.stages = 2;
	state.sync = 113;
	localStorage.clear();
});
function renderRoadmap(grouped = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const onShowHidden = vi.fn();
	const onProposals = vi.fn();
	const onStages = vi.fn();
	render(
		<QueryClientProvider client={client}>
			<RoadmapHeader
				projectId="project_1"
				organizationId={null}
				userRole="owner"
				synced={325}
				unsynced={81}
				priorityEnabled
				section="items"
				onSectionChange={vi.fn()}
				onOpenProposalsInbox={onProposals}
				onOpenStageRequests={onStages}
			>
				<Button size="sm" variant="outline">
					Pull from Example PM
				</Button>
				<Button
					size="sm"
					variant="outline"
					data-onboarding-target="roadmap-ai-update"
				>
					AI Update
				</Button>
				<Button
					size="sm"
					variant="primary"
					data-onboarding-target="roadmap-add"
				>
					Add work item
				</Button>
				<RoadmapActionsMenu
					items={[
						{
							id: "history",
							label: "History",
							icon: InboxIcon,
							onSelect: vi.fn(),
							disabledReason: null,
						},
					]}
				/>
			</RoadmapHeader>
			<RoadmapFilterToolbar
				filters={EMPTY_ROADMAP_FILTERS}
				onFiltersChange={vi.fn()}
				onClearAll={vi.fn()}
				onRemoveFilter={vi.fn()}
				totalCount={406}
				filteredCount={406}
				hasActiveFilters={false}
				projectId="project_1"
				organizationId={null}
				lanesCount={grouped ? 3 : undefined}
				hiddenMatchCount={908}
				onShowHidden={onShowHidden}
				trailing={
					<>
						<RoadmapSortControl
							sort={{ key: "roadmapOrder", direction: "asc" }}
							onSortChange={vi.fn()}
							mode={grouped ? "table" : "plain"}
							groupBy="priority"
						/>
						<Button size="sm">
							View: {grouped ? "Table" : "Plain"}
						</Button>
					</>
				}
			/>
		</QueryClientProvider>,
	);
	return { client, onShowHidden, onProposals, onStages };
}
it("renders the busy configuration once in the header, status and results rows", async () => {
	const user = userEvent.setup();
	const { onShowHidden, onProposals, onStages } = renderRoadmap();
	const header = screen.getByTestId("roadmap-header-actions");
	const status = screen.getByTestId("roadmap-status-row");
	expect(status).toHaveTextContent("325 linked to PM · 81 unlinked");
	for (const name of [
		"Pull from Example PM",
		"AI Update",
		"Add work item",
		"Actions",
	]) {
		expect(
			screen.getAllByRole("button", { name, exact: true }),
		).toHaveLength(1);
		expect(
			within(header).getByRole("button", { name, exact: true }),
		).toHaveClass("h-8");
	}
	for (const name of [
		"Review 1 proposal",
		"2 stage approvals",
		"Sync issues 113",
	]) {
		const control = await screen.findByRole("button", {
			name,
			exact: true,
		});
		expect(
			screen.getAllByRole("button", { name, exact: true }),
		).toHaveLength(1);
		expect(status).toContainElement(control);
		expect(header).not.toContainElement(control);
	}
	const results = screen
		.getByTestId("roadmap-filter-count")
		.closest('[data-testid="roadmap-results-row"]');
	expect(results).toHaveTextContent(
		"406 work items · 3 lanes · Show 908 hidden",
	);
	expect(results).not.toHaveTextContent("linked to PM");
	expect(results).toContainElement(
		screen.getByRole("button", { name: "Sort work items: Roadmap order" }),
	);
	expect(results).toContainElement(
		screen.getByRole("button", { name: "View: Table" }),
	);
	expect(
		screen.getByRole("button", { name: "Review 1 proposal" }),
	).toHaveAttribute("data-onboarding-target", "roadmap-review-proposals");
	await user.click(screen.getByRole("button", { name: "Review 1 proposal" }));
	expect(onProposals).toHaveBeenCalledOnce();
	await user.click(screen.getByRole("button", { name: "2 stage approvals" }));
	expect(onStages).toHaveBeenCalledOnce();
	await user.click(screen.getByRole("button", { name: "Show 908 hidden" }));
	expect(onShowHidden).toHaveBeenCalledOnce();
	await user.click(screen.getByRole("button", { name: /More filters/ }));
	expect(
		await screen.findByRole("button", { name: "Tags: Any" }),
	).toBeInTheDocument();
});
it("keeps the status row without any review controls or empty wrapper at zero counts", async () => {
	state.proposals = 0;
	state.stages = 0;
	state.sync = 0;
	renderRoadmap(false);
	await waitFor(() =>
		expect(
			screen.queryByRole("button", {
				name: /Sync issues|Review .*proposal|stage approvals/,
			}),
		).not.toBeInTheDocument(),
	);
	const row = screen.getByTestId("roadmap-status-row");
	expect(row).toHaveTextContent("325 linked to PM · 81 unlinked");
	expect(row.children).toHaveLength(1);
});
it("preserves the same Sync issues panel across sibling count changes and its own count reaching zero", async () => {
	const user = userEvent.setup();
	const { client } = renderRoadmap();
	await user.click(
		await screen.findByRole("button", { name: "Sync issues 113" }),
	);
	const dialog = await screen.findByRole("dialog", {
		name: /Items to review/,
	});
	for (const count of [0, 4, 0]) {
		await act(async () => {
			client.setQueryData(
				[
					"teams-channel-monitor-pending-proposals-count",
					"project_1",
					null,
				],
				{ count },
			);
		});
		expect(screen.getByRole("dialog", { name: /Items to review/ })).toBe(
			dialog,
		);
	}
	state.sync = 0;
	await act(async () => {
		await client.refetchQueries({
			queryKey: orpc.projects.reviewCenter.count.queryKey({
				input: { projectId: "project_1", organizationId: null },
			}),
			exact: true,
		});
	});
	await waitFor(() =>
		expect(
			screen
				.getByTestId("roadmap-status-row")
				.querySelector('button[aria-label="Sync issues 0"]'),
		).toBeInTheDocument(),
	);
	expect(screen.getByRole("dialog", { name: /Items to review/ })).toBe(
		dialog,
	);
	await user.click(
		within(dialog).getByRole("button", { name: "Close", exact: true }),
	);
	await waitFor(() =>
		expect(
			screen.queryByRole("dialog", { name: /Items to review/ }),
		).not.toBeInTheDocument(),
	);
	expect(
		screen.queryByRole("button", { name: /Sync issues/ }),
	).not.toBeInTheDocument();
});
it.each([true, false])(
	"keeps results separators correct with grouped=%s",
	(grouped) => {
		renderRoadmap(grouped);
		const result = screen.getByTestId("roadmap-filter-count").parentElement;
		expect(result?.textContent).toBe(
			grouped
				? "406 work items · 3 lanes · Show 908 hidden"
				: "406 work items · Show 908 hidden",
		);
	},
);
