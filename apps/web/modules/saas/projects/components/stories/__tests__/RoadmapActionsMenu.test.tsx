import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SparklesIcon, TrashIcon } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { PendingProposalsButton } from "../PendingProposalsButton";
import { RoadmapActionsMenu } from "../RoadmapActionsMenu";
import type { RoadmapActionItem } from "../roadmap-entry/roadmap-action-items";

function item(overrides: Partial<RoadmapActionItem> = {}): RoadmapActionItem {
	return {
		id: "recommend",
		label: "Recommend Features from Context",
		icon: SparklesIcon,
		onSelect: vi.fn(),
		disabledReason: null,
		...overrides,
	};
}

describe("RoadmapActionsMenu", () => {
	it("renders nothing without items", () => {
		const { container } = render(<RoadmapActionsMenu items={[]} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders a labelled Actions button carrying the get-started anchor", () => {
		render(<RoadmapActionsMenu items={[item()]} />);
		const trigger = screen.getByRole("button", { name: "Actions" });
		expect(trigger).toHaveTextContent("Actions");
		expect(trigger).toHaveAttribute(
			"data-onboarding-target",
			"roadmap-actions",
		);
	});

	it("lists the items and runs the selected one", async () => {
		const user = userEvent.setup();
		const recommend = item();
		render(
			<RoadmapActionsMenu
				items={[
					recommend,
					item({ id: "remove", label: "Remove", icon: TrashIcon }),
				]}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Actions" }));
		await user.click(
			await screen.findByRole("menuitem", {
				name: /Recommend Features from Context/,
			}),
		);
		expect(recommend.onSelect).toHaveBeenCalledTimes(1);
	});

	it("shows a disabled item's reason and does not run it", async () => {
		const user = userEvent.setup();
		const blocked = item({ disabledReason: "Add more project context" });
		render(<RoadmapActionsMenu items={[blocked]} />);
		await user.click(screen.getByRole("button", { name: "Actions" }));
		const menuItem = await screen.findByRole("menuitem", {
			name: /Recommend Features from Context/,
		});
		expect(menuItem).toHaveAttribute("aria-disabled", "true");
		expect(menuItem).toHaveTextContent("Add more project context");
	});

	it("keeps a disabled item keyboard-reachable and inert (AC-14, AC-20)", async () => {
		const user = userEvent.setup();
		const blocked = item({
			disabledReason: "Not enough project context yet",
			disabledDetail: "FR37 body",
		});
		render(<RoadmapActionsMenu items={[blocked]} />);
		await user.click(screen.getByRole("button", { name: "Actions" }));
		const menuItem = await screen.findByRole("menuitem", {
			name: /Recommend Features from Context/,
		});
		// Not Radix `disabled`: that drops the item from arrow-key focus.
		expect(menuItem).not.toHaveAttribute("data-disabled");
		await user.keyboard("{ArrowDown}");
		expect(menuItem).toHaveFocus();
		expect(menuItem).toHaveTextContent("FR37 body");
		await user.keyboard("{Enter}");
		expect(blocked.onSelect).not.toHaveBeenCalled();
		// The menu stays open so the reason can still be read.
		expect(screen.getByRole("menu")).toBeInTheDocument();
	});

	it("renders the description, a warning, and the remedy as its own item", async () => {
		const user = userEvent.setup();
		render(
			<RoadmapActionsMenu
				items={[
					item({
						description: "FR10 description",
						warning: "Thin context",
					}),
					item({
						id: "blocked",
						label: "Blocked",
						disabledReason: "Why",
						remedy: { label: "Add context", href: "/context" },
					}),
				]}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Actions" }));
		const recommend = await screen.findByRole("menuitem", {
			name: /Recommend Features from Context/,
		});
		expect(recommend).toHaveTextContent("FR10 description");
		expect(recommend).toHaveTextContent("Thin context");
		expect(recommend).not.toHaveAttribute("aria-disabled");
		expect(
			screen.getByRole("menuitem", { name: "Add context" }),
		).toHaveAttribute("href", "/context");
	});

	it("hides the kebab icon from assistive tech", () => {
		render(<RoadmapActionsMenu items={[item()]} />);
		expect(
			screen
				.getByRole("button", { name: "Actions" })
				.querySelector("svg"),
		).toHaveAttribute("aria-hidden", "true");
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

it("offers page actions and invokes their handlers, including rejected proposals without pending proposals", async () => {
	const user = userEvent.setup();
	const actions = {
		onClassify: vi.fn(),
		classifyDisabledReason: null,
		onScan: vi.fn(),
		scanning: false,
		onExport: vi.fn(),
		exporting: false,
		onRefresh: vi.fn(),
		onHistory: vi.fn(),
		onRejected: vi.fn(),
	};
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<PendingProposalsButton
				projectId="example-project"
				organizationId="example-org"
				onOpenInbox={vi.fn()}
			/>
			<RoadmapActionsMenu items={[]} actions={actions} />
		</QueryClientProvider>,
	);
	await waitFor(() =>
		expect(
			client.getQueryData([
				"teams-channel-monitor-pending-proposals-count",
				"example-project",
				"example-org",
			]),
		).toEqual({ count: 0 }),
	);
	expect(
		screen.queryByRole("button", { name: /Review .*proposal/ }),
	).not.toBeInTheDocument();
	for (const [label, handler] of [
		["Classify delivery tracks", actions.onClassify],
		["Scan for duplicates", actions.onScan],
		["Refresh", actions.onRefresh],
		["History", actions.onHistory],
		["Rejected proposals", actions.onRejected],
	] as const) {
		await user.click(screen.getByRole("button", { name: "Actions" }));
		await user.click(
			screen.getByRole("menuitem", { name: new RegExp(`^${label}`) }),
		);
		expect(handler).toHaveBeenCalledTimes(1);
	}
	for (const [label, format] of [
		["Markdown (.md)", "markdown"],
		["CSV (.csv)", "csv"],
	] as const) {
		await user.click(screen.getByRole("button", { name: "Actions" }));
		const submenu = screen.getByRole("menuitem", {
			name: /^Export estimate/,
		});
		expect(submenu).toHaveClass("[&>svg:last-child]:shrink-0");
		expect(submenu.lastElementChild).toHaveClass("lucide-chevron-right");
		submenu.focus();
		await user.keyboard("{ArrowRight}");
		const option = await screen.findByRole("menuitem", {
			name: label,
			exact: true,
		});
		if (format === "csv") {
			await user.keyboard("{ArrowDown}");
		}
		expect(option).toHaveFocus();
		await user.keyboard("{Enter}");
		expect(actions.onExport).toHaveBeenLastCalledWith(format);
	}
});

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			teamsChannelMonitor: {
				pendingProposals: {
					count: vi.fn().mockResolvedValue({ count: 0 }),
				},
			},
		},
	},
}));

it("keeps exporting keyboard-reachable with a reason, without opening or invoking exports", async () => {
	const actions = {
		onClassify: vi.fn(),
		classifyDisabledReason: null,
		onScan: vi.fn(),
		scanning: false,
		onExport: vi.fn(),
		exporting: true,
		onRefresh: vi.fn(),
		onHistory: vi.fn(),
		onRejected: vi.fn(),
	};
	const user = userEvent.setup();
	render(<RoadmapActionsMenu items={[]} actions={actions} />);
	await user.click(screen.getByRole("button", { name: "Actions" }));
	const item = screen.getByRole("menuitem", { name: /^Export estimate/ });
	expect(item).toHaveAttribute("aria-disabled", "true");
	expect(item).not.toHaveAttribute("data-disabled");
	expect(item).toHaveTextContent("Export in progress");
	await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
	expect(item).toHaveFocus();
	await user.keyboard("{Enter}{ArrowRight}");
	expect(item).toHaveFocus();
	expect(
		screen.queryByRole("menuitem", { name: "Markdown (.md)" }),
	).not.toBeInTheDocument();
	await user.click(item);
	expect(actions.onExport).not.toHaveBeenCalled();
	expect(screen.getByRole("menu")).toBeInTheDocument();
});

it("preserves explanatory descriptions for moved actions", async () => {
	const actions = {
		onClassify: vi.fn(),
		classifyDisabledReason: null,
		onScan: vi.fn(),
		scanning: false,
		onExport: vi.fn(),
		exporting: false,
		onRefresh: vi.fn(),
		onHistory: vi.fn(),
		onRejected: vi.fn(),
	};
	const user = userEvent.setup();
	render(<RoadmapActionsMenu items={[]} actions={actions} />);
	await user.click(screen.getByRole("button", { name: "Actions" }));
	for (const [name, description] of [
		[/^Classify delivery tracks/, "Assign delivery tracks"],
		[
			/^Classify delivery tracks/,
			"A delivery track says what a feature must show before Published",
		],
		[/^History/, "Every change to these tickets, and the PM sync log."],
		[
			/^Rejected proposals/,
			"Recover or permanently delete dismissed proposals.",
		],
		[
			/^Scan for duplicates/,
			"Find potential duplicate features and bugs with AI.",
		],
		[
			/^Export estimate/,
			"Downloads the scope estimate grouped by phase and by track",
		],
		[
			/^Refresh/,
			"Refresh the roadmap from the server and clear the current work item selection.",
		],
	] as const) {
		expect(screen.getByRole("menuitem", { name })).toHaveTextContent(
			description,
		);
		expect(screen.getByRole("menuitem", { name })).not.toHaveTextContent(
			/History —|Rejected proposals —/,
		);
	}
});
