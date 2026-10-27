import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserStory } from "../../../lib/stories/types";
import { SourceChip } from "../SourceChip";
import { StoryCard } from "../StoryCard";
import { StoryList } from "../StoryList";
import { selectSecondaryMetadata } from "../secondary-overflow";

const fixtureLocale = vi.hoisted(() => ({ value: "en" }));
afterEach(() => {
	fixtureLocale.value = "en";
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

vi.mock("@dnd-kit/sortable", () => ({
	useSortable: () => ({
		attributes: {},
		listeners: {},
		setNodeRef: vi.fn(),
		transform: null,
		transition: undefined,
		isDragging: false,
	}),
}));

vi.mock("next-intl", async (importOriginal) => {
	const actual = await importOriginal<typeof import("next-intl")>();
	const { default: en } = await import("@repo/i18n/translations/en.json");
	const { default: de } = await import("@repo/i18n/translations/de.json");
	return {
		useLocale: () => fixtureLocale.value,
		useTranslations: (namespace: string) => {
			if (namespace === "projects.stories.listRow") {
				return actual.createTranslator({
					locale: fixtureLocale.value,
					messages: fixtureLocale.value === "de" ? de : en,
					namespace,
				});
			}
			const t = (key: string) => key;
			t.rich = (key: string) => key;
			return t;
		},
	};
});

// PmSyncCloudToggle (mounted on StoryCard via Task 4.3) calls
// orpcClient.projects.stories.update from its toggle mutation. Stub the
// shape so the component imports resolve.
vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				updateDraftingStage: vi.fn(),
				update: vi.fn(),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			stories: {
				// Fizzy #2048: the card follows the body redraft a type change
				// starts. The read is gated on this item being watched, and
				// nothing here converts anything, so it stays idle.
				regenerationStatus: {
					queryOptions: (o: { input: unknown }) => ({
						queryKey: ["story-regeneration-status", o.input],
						queryFn: async () => ({ status: "idle" }),
					}),
				},
				// useAiReassessEligibility (AI menu entries) reads the status
				// list at render; empty = nothing is final, all eligible.
				statuses: {
					list: {
						queryOptions: (o: { input: unknown }) => ({
							queryKey: ["statuses", o.input],
							queryFn: async () => ({ statuses: [] }),
						}),
					},
				},
				list: { queryKey: () => ["stories-list"] },
				get: { queryKey: () => ["stories-get"] },
				queueForKanban: {
					mutationOptions: () => ({ mutationFn: async () => ({}) }),
				},
			},
		},
	},
}));

// PmSyncCloudToggle reads the user id from the session for telemetry
// payloads (Wave 4A, spec §7).
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: { id: "test-user-id", name: "Test User" },
		session: { id: "test-session" },
		loaded: true,
		reloadSession: vi.fn(),
	}),
}));

// PmSyncCloudToggle reads the basePath from the org context.
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationSlug: null,
		organizationName: null,
		basePath: "/app",
		isOrgContext: false,
		isPersonalContext: true,
		isOrganizationAdmin: false,
		userRole: null,
		loaded: true,
		organization: null,
	}),
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		success: vi.fn(),
		error: vi.fn(),
		warning: vi.fn(),
	}),
}));

function renderWithQueryClient(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

function buildStory(overrides: Partial<UserStory> = {}): UserStory {
	return {
		id: "story_1",
		identifier: "F-001",
		title: "Improve task implementation UX",
		description: null,
		acceptanceCriteria: null,
		statusId: "status_1",
		priority: "P1_HIGH",
		size: "M",
		storyPoints: 5,
		order: 1,
		roadmapOrder: 1,
		labels: [],
		assigneeId: null,
		createdById: "user_1",
		createdAt: new Date("2026-03-27T00:00:00.000Z"),
		updatedAt: new Date("2026-03-27T00:00:00.000Z"),
		externalId: null,
		externalUrl: null,
		source: "manual",
		version: 1,
		draftingStage: "DRAFT",
		draftingStageUpdatedAt: null,
		latestCodingRun: {
			id: "story_run_1",
			executionChannel: "WORKSPACE_AGENTS",
			provider: "VIBE_WORKSPACE",
			status: "RUNNING",
			providerSessionId: "story_session_1",
			pullRequestUrl: null,
			pullRequestNumber: null,
			externalUrl:
				"http://127.0.0.1:4242/projects/proj_1/issues/issue_1/workspaces/ws_1",
			externalStatus: "workspace_linked_to_vibe_issue",
			providerMetadata: {
				remoteProjectId: "proj_1",
				remoteIssueId: "issue_1",
				issueLinkingStatus: "linked_remote_issue",
			},
			storyTask: {
				id: "task_1",
				identifier: "TASK-001",
				title: "Wire Vibe summary links",
			},
			createdAt: new Date("2026-03-27T04:50:00.000Z"),
		},
		tasks: [
			{
				id: "task_1",
				identifier: "TASK-001",
				title: "Wire Vibe summary links",
				description: null,
				isCompleted: false,
				order: 1,
				estimatedHours: null,
				agentStatus: null,
				agentTaskId: null,
				agentStartedAt: null,
				repositoryUrl: null,
				repositoryOwner: null,
				repositoryName: null,
				targetBranch: null,
				latestCodingRun: {
					id: "run_1",
					executionChannel: "WORKSPACE_AGENTS",
					provider: "VIBE_WORKSPACE",
					status: "RUNNING",
					providerSessionId: "session_1",
					pullRequestUrl: null,
					pullRequestNumber: null,
					externalUrl:
						"http://127.0.0.1:4242/projects/proj_1/issues/issue_1/workspaces/ws_1",
					externalStatus: "workspace_linked_to_vibe_issue",
					providerMetadata: {
						remoteProjectId: "proj_1",
						remoteIssueId: "issue_1",
						hasPendingApproval: true,
						issueLinkingStatus: "linked_remote_issue",
					},
					createdAt: new Date("2026-03-27T04:45:00.000Z"),
				},
			},
			{
				id: "task_2",
				identifier: "TASK-002",
				title: "Polish task modal",
				description: null,
				isCompleted: false,
				order: 2,
				estimatedHours: null,
				agentStatus: null,
				agentTaskId: null,
				agentStartedAt: null,
				repositoryUrl: null,
				repositoryOwner: null,
				repositoryName: null,
				targetBranch: null,
				latestCodingRun: {
					id: "run_2",
					executionChannel: "LOCAL_AGENTS",
					provider: "KANBAN_LOCAL",
					status: "COMPLETED",
					providerSessionId: "session_2",
					pullRequestUrl: null,
					pullRequestNumber: null,
					externalUrl: "http://127.0.0.1:3333/tasks/2",
					externalStatus: null,
					providerMetadata: null,
					createdAt: new Date("2026-03-27T04:15:00.000Z"),
				},
			},
		],
		...overrides,
	};
}

describe("StoryCard", () => {
	it("shows broader task-scoped visibility badges on the summary surface", () => {
		renderWithQueryClient(
			<StoryCard
				story={buildStory()}
				projectId="project_1"
				onSelect={vi.fn()}
				onDelete={vi.fn()}
			/>,
		);

		expect(screen.getByText("1 task session")).toBeInTheDocument();
		expect(screen.getByText("1 need review")).toBeInTheDocument();
		expect(screen.getByText("Primary task: TASK-001")).toBeInTheDocument();
	});

	it("renders Vibe project and issue deep links on expanded task rows", async () => {
		const user = userEvent.setup();
		renderWithQueryClient(
			<StoryCard
				story={buildStory()}
				projectId="project_1"
				onSelect={vi.fn()}
				onDelete={vi.fn()}
			/>,
		);

		await user.click(screen.getByText("0/2"));

		const projectLinks = screen.getAllByRole("link", {
			name: /open linked vibe project/i,
		});
		const issueLinks = screen.getAllByRole("link", {
			name: /open linked vibe issue/i,
		});

		expect(projectLinks.length).toBeGreaterThanOrEqual(2);
		expect(issueLinks.length).toBeGreaterThanOrEqual(2);
		expect(projectLinks[0]).toHaveAttribute(
			"href",
			"http://127.0.0.1:4242/projects/proj_1",
		);
		expect(issueLinks[0]).toHaveAttribute(
			"href",
			"http://127.0.0.1:4242/projects/proj_1/issues/issue_1",
		);
	});

	// Regression: clicking a task in the expanded preview must not open any
	// modal/dialog or trigger navigation. The team disabled click-to-detail on
	// task rows after a bug took users to a blank/error page.
	it("does not open a modal when a task title is clicked", async () => {
		const user = userEvent.setup();
		renderWithQueryClient(
			<StoryCard
				story={buildStory()}
				projectId="project_1"
				onSelect={vi.fn()}
				onDelete={vi.fn()}
			/>,
		);

		await user.click(screen.getByText("0/2"));

		const titleEl = screen.getByText("Wire Vibe summary links");

		// Title is a non-interactive span — not a button or link.
		expect(titleEl.tagName).toBe("SPAN");
		expect(titleEl.closest("button")).toBeNull();
		expect(titleEl.closest("a")).toBeNull();

		await user.click(titleEl);

		// Nothing modal-like should mount as a result of the click.
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("toggles a task via the checkbox without invoking onSelect", async () => {
		const user = userEvent.setup();
		const onTaskToggle = vi.fn();
		const onSelect = vi.fn();
		renderWithQueryClient(
			<StoryCard
				story={buildStory()}
				projectId="project_1"
				onSelect={onSelect}
				onDelete={vi.fn()}
				onTaskToggle={onTaskToggle}
			/>,
		);

		await user.click(screen.getByText("0/2"));

		// First task checkbox (task_1).
		const checkboxes = screen.getAllByRole("checkbox");
		const taskCheckbox = checkboxes.find(
			(cb) =>
				cb.getAttribute("aria-label")?.toLowerCase().includes("task") ||
				cb.closest("[class*='group/task']") !== null,
		);
		expect(taskCheckbox).toBeDefined();

		await user.click(taskCheckbox as HTMLElement);

		expect(onTaskToggle).toHaveBeenCalledWith("story_1", "task_1");
		expect(onSelect).not.toHaveBeenCalled();
	});

	// Identifier display surface (spec 2026-05-21 §8): the card renders
	// `story.identifier` verbatim — no client-side prefix construction. New
	// bug-kind stories store plain decimal identifiers, and legacy prefixed
	// identifiers continue to render exactly as stored.
	it("renders a plain numeric identifier for a BUG story without prepending `B-`", () => {
		renderWithQueryClient(
			<StoryCard
				story={buildStory({
					id: "story_bug_1",
					identifier: "12",
					kind: "BUG",
				})}
				projectId="project_1"
				onSelect={vi.fn()}
				onDelete={vi.fn()}
			/>,
		);

		// The identifier cell renders the raw stored value.
		expect(screen.getByText("12")).toBeInTheDocument();
		// No client-side prefix construction (`B-12`) appears anywhere.
		expect(screen.queryByText("B-12")).toBeNull();
		// And no F-prefixed variant either, even though the icon flags it as a bug.
		expect(screen.queryByText("F-12")).toBeNull();
	});

	it("renders a legacy `B-011` identifier verbatim", () => {
		renderWithQueryClient(
			<StoryCard
				story={buildStory({
					id: "story_bug_legacy",
					identifier: "B-011",
					kind: "BUG",
				})}
				projectId="project_1"
				onSelect={vi.fn()}
				onDelete={vi.fn()}
			/>,
		);

		// Legacy prefixed identifier is preserved exactly.
		expect(screen.getByText("B-011")).toBeInTheDocument();
		// And we don't accidentally double-prefix it.
		expect(screen.queryByText("B-B-011")).toBeNull();
	});

	// The list now aligns primary columns with a shared grid; optional tags
	// live under the title. The shared grid keeps empty metadata from moving primary cells.
	it("renders the same column cells for a row without tags as for a tagged row", () => {
		const columnSkeleton = (container: HTMLElement) => {
			const cells = Array.from(
				container.querySelectorAll<HTMLElement>("[data-column]"),
			);
			expect(cells.map((cell) => cell.dataset.column)).toEqual([
				"selection",
				"item",
				"title",
				"priority",
				"stage",
				"pm",
				"actions",
			]);
			return cells.map((cell) => ({
				column: cell.dataset.column,
				geometry: cell.className,
			}));
		};

		const tagged = renderWithQueryClient(
			<StoryCard
				story={buildStory({
					id: "story_tagged",
					tags: [
						{
							id: "tag_1",
							value: "example-tag",
							createdById: null,
						},
					],
				})}
				projectId="project_1"
				onSelect={vi.fn()}
				onDelete={vi.fn()}
			/>,
		);
		const untagged = renderWithQueryClient(
			<StoryCard
				story={buildStory({ id: "story_untagged", tags: [] })}
				projectId="project_1"
				onSelect={vi.fn()}
				onDelete={vi.fn()}
			/>,
		);

		expect(columnSkeleton(untagged.container)).toEqual(
			columnSkeleton(tagged.container),
		);
	});
});

// These exercise real row content and event boundaries. Browser geometry and
// computed focus opacity are covered by the local Chromium fixture as well.
describe("Roadmap list row contract", () => {
	const row = (
		overrides: Partial<UserStory> = {},
		props: Partial<React.ComponentProps<typeof StoryCard>> = {},
	) =>
		renderWithQueryClient(
			<StoryCard
				story={buildStory({
					tasks: [],
					latestCodingRun: null,
					...overrides,
				})}
				projectId="example-project"
				onSelect={vi.fn()}
				onDelete={vi.fn()}
				showProvenance
				disableInlineRename
				maturationV2
				{...props}
			/>,
		);

	it.each(["F-042", "B-002", "F-1234", "F-001-dup4", "1201", "45"])(
		"keeps the complete %s item number outside truncation styles",
		(identifier) => {
			const view = row({ identifier });
			const item = view.container.querySelector(
				'[data-column="item"]',
			) as HTMLElement;
			const number = within(item).getByText(identifier);
			for (
				let element: HTMLElement | null = number;
				element && element !== item.parentElement;
				element = element.parentElement
			) {
				expect(element.className).not.toMatch(
					/(?:^|\s)(?:truncate|overflow-hidden|text-ellipsis)(?:\s|$)/,
				);
			}
			expect(within(item).getByText("Feature")).toHaveClass("sr-only");
		},
	);

	it.each(["FAILED", "CONFLICT", "PENDING", null] as const)(
		"keeps resolved PM status %s visible without hovering the row",
		(lastPmSyncStatus) => {
			const view = row(
				{ lastPmSyncStatus, pmAutoSyncEnabled: true },
				{ hasPMIntegration: true },
			);
			const pm = view.container.querySelector(
				'[data-column="pm"]',
			) as HTMLElement;
			expect(pm.querySelector("svg")).not.toBeNull();
			for (const element of [
				pm,
				...pm.querySelectorAll<HTMLElement>("*"),
			]) {
				expect(element.getAttribute("class") ?? "").not.toMatch(
					/(?:^|\s)(?:opacity-(?:0|50)|invisible|hidden)(?:\s|$)/,
				);
			}
			for (
				let element: HTMLElement | null = pm;
				element && element !== view.container;
				element = element.parentElement
			) {
				expect(element.className).not.toMatch(
					/(?:^|\s)(?:opacity-(?:0|50)|invisible|hidden)(?:\s|$)/,
				);
			}
		},
	);

	it("shows the linked ticket's native PM status read-only in the PM column (Fizzy #3088)", () => {
		const view = row(
			{ externalId: "42", pmTicketStatus: "QA" },
			{ hasPMIntegration: true, pmToolName: "Azure DevOps" },
		);
		const pm = view.container.querySelector(
			'[data-column="pm"]',
		) as HTMLElement;
		const status = within(pm).getByTestId("pm-ticket-status");
		expect(status).toHaveTextContent("QA");
		expect(status).toHaveTextContent("Status in Azure DevOps: QA");
		expect(within(status).queryByRole("button")).toBeNull();
		// Keyboard users can focus it to open the tooltip.
		expect(status).toHaveAttribute("tabindex", "0");
	});

	it("shows no PM status when the story has none (Fizzy #3088)", () => {
		const view = row({ pmTicketStatus: null }, { hasPMIntegration: true });
		expect(view.queryByTestId("pm-ticket-status")).toBeNull();
	});

	it("keeps PM pending single-line with its full provider text accessible", () => {
		const view = row(
			{ lastPmSyncStatus: "PENDING" },
			{ hasPMIntegration: true, pmToolName: "Azure DevOps" },
		);
		const pending = within(view.container).getByRole("status", {
			name: "Syncing to Azure DevOps…",
		});
		expect(pending).toHaveTextContent("Sync…");
		expect(pending).toHaveAccessibleName("Syncing to Azure DevOps…");
		expect(pending).not.toHaveAttribute("title");
		expect(pending).toHaveClass("whitespace-nowrap");
		expect(pending).not.toHaveClass("whitespace-normal");
	});

	it.each(["FAILED", "CONFLICT"] as const)(
		"keeps %s badges on one line",
		(lastPmSyncStatus) => {
			const view = row({ lastPmSyncStatus });
			const pm = view.container.querySelector(
				'[data-column="pm"]',
			) as HTMLElement;
			const badge = within(pm).getByRole("button");
			expect(badge).toHaveClass("whitespace-nowrap");
			expect(badge).not.toHaveClass("whitespace-normal");
		},
	);

	it("shows two sans tags and summarizes every tag in the overflow tooltip and name", () => {
		const values = [
			"area:integrations",
			"area:google-drive",
			"automated bug flow",
		];
		const view = row({
			tags: values.map((value, i) => ({
				id: `example-tag-${i}`,
				value,
				createdById: null,
			})),
		});
		const secondary = view.container.querySelector(
			"[data-row-secondary]",
		) as HTMLElement;
		const summary = within(secondary).getByRole("button", {
			name: values.join(", "),
		});
		expect(summary).toHaveTextContent("+1");
		expect(summary).toHaveAccessibleName(values.join(", "));
		for (const value of values.slice(0, 2)) {
			expect(within(secondary).getByText(value)).toHaveClass("font-sans");
		}
		expect(within(secondary).queryByText(values[2])).toBeNull();
	});

	it("uses only the Radix tag-summary tooltip while naming every tag", async () => {
		const values = ["area:example", "team:example", "example tag"];
		const view = row({
			tags: values.map((value, index) => ({
				id: `example-tag-${index}`,
				value,
				createdById: null,
			})),
		});
		const summary = within(view.container).getByRole("button", {
			name: values.join(", "),
		});
		expect(summary).not.toHaveAttribute("title");
		expect(summary).toHaveAccessibleName(values.join(", "));
		await userEvent.hover(summary);
		expect(await screen.findByRole("tooltip")).toHaveTextContent(
			values.join(", "),
		);
	});

	it("keeps Defer struck through and muted on the secondary line", () => {
		const view = row({ deliveryTrack: "DEFER" });
		const track = within(view.container).getByTestId("delivery-track-chip");
		expect(track).toHaveTextContent("Track: Defer");
		expect(track).toHaveClass("line-through", "opacity-60");
		expect(track.closest("[data-row-secondary]")).not.toBeNull();
	});

	it("clips secondary metadata inside Title without wrapping or horizontal scrolling", () => {
		const view = row({
			needsMoreInfo: true,
			kind: "BUG",
			estimateConfidence: "LOW",
		});
		const secondary = view.container.querySelector("[data-row-secondary]");
		expect(secondary).toHaveClass(
			"col-end-4",
			"overflow-hidden",
			"whitespace-nowrap",
			"[&>*]:shrink-0",
		);
		expect(secondary).not.toHaveClass("overflow-x-auto");
		expect(view.container.querySelector("[data-row-layout]")).toHaveClass(
			"h-16",
			"grid-rows-[1.5rem_1.5rem]",
		);
		expect(
			within(secondary as HTMLElement).getByTestId(
				"estimate-confidence-chip",
			),
		).toBeInTheDocument();
	});

	function withWidthBudget(
		budget: number,
		overrides: Partial<UserStory> = {},
	) {
		let resize = () => {};
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(callback: () => void) {
					resize = callback;
				}
				observe() {}
				disconnect() {}
			},
		);
		const view = row(
			{
				kind: "BUG",
				needsMoreInfo: true,
				deliveryTrack: "SPIKE",
				estimateConfidence: "LOW",
				source: "ai_update",
				tags: [
					{
						id: "example-tag",
						value: "area:example",
						createdById: null,
					},
				],
				...overrides,
			},
			{
				columns: { size: true },
				columnOrder: [
					"source",
					"size",
					"tags",
					"title",
					"flags",
					"stage",
					"sync",
				],
			},
		);
		const line = view.container.querySelector(
			"[data-row-secondary]",
		) as HTMLElement;
		Object.defineProperty(line, "clientWidth", {
			configurable: true,
			get: () => budget,
		});
		line.getBoundingClientRect = () => ({
			x: 0,
			left: 0,
			right: budget,
			width: budget,
			height: 24,
			top: 0,
			bottom: 24,
			y: 0,
			toJSON() {},
		});
		const widths: Record<string, number> = {
			activity: 70,
			source: 60,
			size: 40,
			points: 20,
			tags: 120,
			estimate: 70,
			track: 90,
			flags: 100,
		};
		let position = 0;
		for (const child of Array.from(line.children) as HTMLElement[]) {
			if (child.hasAttribute("data-overflow-summary")) {
				continue;
			}
			const text = child.textContent ?? "";
			const kind =
				child.dataset.secondaryKind ??
				(text.includes("Track:")
					? "track"
					: text.includes("Needs More Info")
						? "flags"
						: text.includes("area:example")
							? "tags"
							: text.includes("Size:")
								? "size"
								: text.includes("AI Update")
									? "source"
									: "activity");
			child.dataset.secondaryKind = kind;
			const width =
				kind === "tags" && overrides.tags?.length === 0
					? 0
					: widths[kind];
			const left = position;
			position += width + 8;
			Object.defineProperty(child, "offsetWidth", {
				configurable: true,
				get: () => (child.style.display === "none" ? 0 : width),
			});
			child.getBoundingClientRect = () => ({
				left,
				right: left + width,
				width,
				x: left,
				y: 0,
				top: 0,
				bottom: 24,
				height: 24,
				toJSON() {},
			});
			const compact = child.querySelector<HTMLElement>(
				"[data-tags-compact]",
			);
			if (compact) {
				compact.getBoundingClientRect = () => ({
					left: 0,
					right: 40,
					width: 40,
					x: 0,
					y: 0,
					top: 0,
					bottom: 24,
					height: 24,
					toJSON() {},
				});
			}
		}
		act(() => resize());
		const visible = () =>
			Array.from(
				line.querySelectorAll<HTMLElement>("[data-secondary-kind]"),
			)
				.filter(
					(element) =>
						element.style.visibility !== "hidden" &&
						element.style.display !== "none",
				)
				.map((element) => element.dataset.secondaryKind);
		return { ...view, line, visible };
	}

	it.each([
		[550, ["size", "points", "tags", "track", "estimate", "flags"]],
		[430, ["tags", "track", "estimate", "flags"]],
		[320, ["track", "estimate", "flags"]],
		[230, ["track", "flags"]],
		[150, ["flags"]],
	] as const)(
		"removes metadata by importance at a %ipx budget while retaining View order",
		(budget, expected) => {
			const view = withWidthBudget(budget);
			expect(view.visible()).toEqual(expected);
		},
	);

	it("omits empty tag groups so they consume no flex gap", () => {
		const view = withWidthBudget(550, { tags: [] });
		expect(
			view.line.querySelector('[data-secondary-kind="tags"]'),
		).toBeNull();
	});

	it("recovers a later smaller group when an oversized high-priority group cannot fit", () => {
		const { hidden } = selectSecondaryMetadata(
			[
				{ kind: "track", width: 300 },
				{ kind: "size", width: 40 },
				{ kind: "source", width: 30 },
			],
			100,
		);
		expect(hidden.has("track")).toBe(true);
		expect(hidden.has("size")).toBe(false);
		expect(hidden.has("source")).toBe(true);
	});

	it("keeps flags selected even when their width exceeds the budget", () => {
		expect(withWidthBudget(20).visible()).toContain("flags");
	});

	it("keeps a nonempty discovery affordance when metadata cannot fit", () => {
		const view = withWidthBudget(20);
		expect(
			within(view.line).getByRole("button", { name: /Hidden:/ }),
		).toHaveTextContent(/\+\d/);
	});

	it("lists hidden metadata in the final overflow accessible name", () => {
		const view = withWidthBudget(550);
		const more = within(view.line).getByRole("button", { name: /Hidden:/ });
		expect(more).not.toHaveAttribute("title");
		expect(more).toHaveAccessibleName(/AI Update/);
		expect(more).toHaveAccessibleName(/created .+ ago/);
		expect(more).not.toHaveAccessibleName(/Needs More Info/);
	});

	function mockSecondaryGeometry(
		budget: number,
		measure: (element: HTMLElement) => { width: number; left?: number },
	) {
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
			budget,
		);
		vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
			function (this: HTMLElement) {
				const { width, left = 0 } = measure(this);
				return {
					x: left,
					y: 0,
					left,
					right: left + width,
					top: 0,
					bottom: 24,
					width,
					height: 24,
					toJSON() {},
				};
			},
		);
	}

	it("shows duplicate flags arriving after mount with the same story object", () => {
		mockSecondaryGeometry(1000, (element) => ({
			width:
				element.dataset.secondaryKind === "flags" && element.textContent
					? 100
					: 0,
		}));
		const story = buildStory({ tasks: [], latestCodingRun: null });
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const card = (
			duplicateInfo?: React.ComponentProps<
				typeof StoryCard
			>["duplicateInfo"],
		) => (
			<QueryClientProvider client={client}>
				<StoryCard
					story={story}
					projectId="example-project"
					onSelect={vi.fn()}
					onDelete={vi.fn()}
					duplicateInfo={duplicateInfo}
				/>
			</QueryClientProvider>
		);
		const view = render(card());
		view.rerender(
			card({
				count: 1,
				overlapOnly: false,
				partnerTitles: ["Example item"],
				onResolve: vi.fn(),
			}),
		);
		const flags = view.container.querySelector(
			'[data-secondary-kind="flags"]',
		) as HTMLElement;
		expect(flags.style.display).not.toBe("none");
		expect(within(flags).getByText("chipSingle")).toBeVisible();
	});

	it("retains story points when the Size field is disabled", () => {
		row({ storyPoints: 5 }, { columns: { size: false } });
		expect(screen.getByText("5pt")).toBeVisible();
		expect(screen.queryByText(/^Size:/)).toBeNull();
	});

	it.each([false, true])(
		"keeps the PM toggle present with sync=%s and gates only badges",
		(sync) => {
			const view = row(
				{ lastPmSyncStatus: "FAILED" },
				{ hasPMIntegration: true, columns: { sync } },
			);
			const pm = view.container.querySelector(
				'[data-column="pm"]',
			) as HTMLElement;
			expect(pm.querySelector('[data-state="off"]')).not.toBeNull();
			expect(
				within(pm).queryByRole("button", { name: /PM sync failed/ }) !==
					null,
			).toBe(sync);
		},
	);

	it.each([
		["en", "1 tag", "2 tags", "+1 more", "+2 more", "1pt", "2pt"],
		[
			"de",
			"1 Tag",
			"2 Tags",
			"+1 weiterer",
			"+2 weitere",
			"1 Pkt.",
			"2 Pkt.",
		],
	])(
		"pluralizes all numeric listRow labels in %s",
		async (locale, oneTag, tags, oneMore, more, onePoint, points) => {
			const { createTranslator } =
				await vi.importActual<typeof import("next-intl")>("next-intl");
			const en = (await import("@repo/i18n/translations/en.json"))
				.default;
			const de = (await import("@repo/i18n/translations/de.json"))
				.default;
			const t = createTranslator({
				locale,
				messages: locale === "de" ? de : en,
				namespace: "projects.stories.listRow",
			});
			expect(t("tagCount", { count: 1 })).toBe(oneTag);
			expect(t("tagCount", { count: 2 })).toBe(tags);
			expect(t("moreTags", { count: 1 })).toBe(oneMore);
			expect(t("moreTags", { count: 2 })).toBe(more);
			expect(t("points", { count: 1 })).toBe(onePoint);
			expect(t("points", { count: 2 })).toBe(points);
		},
	);

	it("reserves the overflow affordance when flags alone clip", () => {
		mockSecondaryGeometry(150, (element) => {
			if (element.dataset.secondaryKind === "flags") {
				return {
					width: Math.min(
						200,
						Number.parseFloat(element.style.maxWidth) || 200,
					),
				};
			}
			if (element.parentElement?.dataset.secondaryKind === "flags") {
				return element === element.parentElement.firstElementChild
					? { left: 0, width: 80 }
					: { left: 80, width: 120 };
			}
			return { width: 0 };
		});
		const view = row(
			{ storyPoints: null, mergedIntoStoryId: "example-survivor" },
			{
				showProvenance: false,
				columns: { size: false, source: false, tags: false },
				duplicateInfo: {
					count: 1,
					overlapOnly: false,
					partnerTitles: [],
					onResolve: vi.fn(),
				},
			},
		);
		const flags = view.container.querySelector(
			'[data-secondary-kind="flags"]',
		) as HTMLElement;
		expect(flags.style.maxWidth).toBe("118px");
		expect(
			within(view.container).getByRole("button", {
				name: /Hidden:.*declinedChip/,
			}),
		).toBeVisible();
	});

	it("does not count compact tags as hidden metadata", () => {
		mockSecondaryGeometry(100, (element) => ({
			width: element.hasAttribute("data-tags-compact")
				? 40
				: element.dataset.secondaryKind === "tags"
					? 300
					: 0,
		}));
		const view = row(
			{
				storyPoints: null,
				tags: [
					{
						id: "example-tag",
						value: "area:long-example-tag",
						createdById: null,
					},
				],
			},
			{ showProvenance: false, columns: { source: false, size: false } },
		);
		const compact = view.container.querySelector(
			"[data-tags-compact]",
		) as HTMLElement;
		expect(compact.style.display).toBe("inline-flex");
		expect(compact).toHaveAccessibleName("area:long-example-tag");
		expect(
			view.container.querySelector("[data-overflow-summary]"),
		).toHaveStyle({ display: "none" });
	});

	it("keeps title and item in fixed columns regardless of delivery track", () => {
		const a = row({ id: "example-a", deliveryTrack: "SPIKE" });
		const b = row({ id: "example-b", deliveryTrack: "UNCLASSIFIED" });
		for (const view of [a, b]) {
			const title = within(view.container).getByTestId(
				"story-card-title",
			);
			expect(title.closest('[data-column="title"]')).not.toBeNull();
			expect(
				view.container.querySelector('[data-column="item"]'),
			).not.toContainElement(
				view.container.querySelector(
					'[data-testid="delivery-track-chip"]',
				),
			);
		}
		expect(
			a.container.querySelector("[data-row-layout]")?.className,
		).toEqual(b.container.querySelector("[data-row-layout]")?.className);
	});

	it("labels secondary signals and applies saved field order and visibility", () => {
		const view = row(
			{
				deliveryTrack: "SPIKE",
				estimateConfidence: "LOW",
				source: "ai_update",
				tags: [
					{
						id: "example-tag",
						value: "Example tag",
						createdById: null,
					},
				],
			},
			{
				columnOrder: [
					"tags",
					"source",
					"title",
					"flags",
					"size",
					"stage",
					"sync",
				],
				columns: {
					source: true,
					tags: true,
					size: false,
					flags: false,
					stage: false,
					sync: false,
				},
			},
		);
		const secondary = view.container.querySelector(
			"[data-row-secondary]",
		) as HTMLElement;
		expect(secondary).toHaveTextContent("Track: Spike");
		expect(secondary).toHaveTextContent("Estimate: Low confidence");
		expect(secondary).toHaveTextContent(/created .+ ago/);
		expect(secondary.textContent?.indexOf("Example tag")).toBeLessThan(
			secondary.textContent?.indexOf("AI Update") ?? 0,
		);
		expect(secondary.textContent?.indexOf("AI Update")).toBeLessThan(
			secondary.textContent?.indexOf("Track:") ?? 0,
		);
		expect(
			view.container.querySelector('[data-column="stage"]'),
		).toBeEmptyDOMElement();
		expect(
			view.container.querySelector('[data-column="pm"] [data-state]'),
		).not.toBeNull();
		expect(screen.getByText("5pt")).toBeVisible();
		view.unmount();
		const hidden = row(
			{
				source: "ai_update",
				tags: [
					{
						id: "example-tag",
						value: "Example tag",
						createdById: null,
					},
				],
			},
			{ columns: { source: false, tags: false } },
		);
		expect(within(hidden.container).queryByText("AI Update")).toBeNull();
		expect(within(hidden.container).queryByText("Example tag")).toBeNull();
	});

	it("renders real priority and keeps a PM failure visible in its column", () => {
		const view = row({
			kind: "BUG",
			priority: "P2_MEDIUM",
			lastPmSyncStatus: "FAILED",
		});
		expect(screen.getByText("P2 · Medium")).toBeInTheDocument();
		const pm = view.container.querySelector(
			'[data-column="pm"]',
		) as HTMLElement;
		expect(
			within(pm).getByRole("button", { name: /PM sync failed/ }),
		).toHaveTextContent("Failed");
	});

	it.each(["Enter", " "])(
		"does not open the row for child %s key events",
		(key) => {
			const onOpenDetails = vi.fn();
			row({}, { onOpenDetails, canReorder: true });
			for (const control of [
				screen.getByRole("checkbox"),
				screen.getByRole("button", { name: "Story actions" }),
				screen.getByTestId("story-card-drag-handle"),
			]) {
				fireEvent.keyDown(control, { key });
			}
			expect(onOpenDetails).not.toHaveBeenCalled();
			fireEvent.click(screen.getByTestId("story-card-title"));
			expect(onOpenDetails).toHaveBeenCalledOnce();
		},
	);

	it("exposes row controls at rest and on keyboard focus", () => {
		row({}, { canReorder: true });
		for (const control of [
			screen.getByRole("checkbox"),
			screen.getByRole("button", { name: "Story actions" }),
			screen.getByTestId("story-card-drag-handle"),
		]) {
			expect(control.className).toContain(
				"group-focus-within:opacity-100",
			);
			expect(control.className).toContain("focus-visible:opacity-100");
			expect(control.className.split(/\s+/)).not.toContain("opacity-0");
		}
	});
});

// SourceChip's variant branch preserves the Board's default chip styles.
it("keeps Board source chips and gives lists quiet readable provenance", () => {
	const view = render(
		<>
			<SourceChip source="ai_update" />
			<SourceChip source="ai_update" variant="list" />
		</>,
	);
	const [board, list] = within(view.container)
		.getAllByText("AI Update")
		.map((label) => label.parentElement);
	expect(board?.className).toContain("rounded-full");
	expect(list?.className).not.toContain("rounded-full");
	expect(list?.className).toContain("text-xs");
	expect(list?.className).not.toContain("text-muted-foreground/80");
});

it("shares a bounded column budget between the header and rows", () => {
	const view = renderWithQueryClient(
		<StoryList>
			<StoryCard
				story={buildStory()}
				projectId="example-project"
				onSelect={vi.fn()}
				onDelete={vi.fn()}
			/>
		</StoryList>,
	);
	const header = screen.getByText("Item").parentElement as HTMLElement;
	const row = view.container.querySelector(
		"[data-row-layout]",
	) as HTMLElement;
	const template = (element: HTMLElement) =>
		element.className.match(/grid-cols-\[([^\]]+)\]/)?.[1];
	expect(template(row)).toBe(template(header));
	const tracks = template(row)?.split("_") ?? [];
	expect(tracks).toHaveLength(7);
	// 5.625rem fits the icon and #F-001-dup4; the remaining fixed tracks leave
	// at least 16.625rem for Title inside the 52rem list (including gaps/padding).
	expect(Number.parseFloat(tracks[1])).toBeGreaterThanOrEqual(5.625);
	expect(Number.parseFloat(tracks[4])).toBeGreaterThanOrEqual(9.125);
	expect(Number.parseFloat(tracks[5])).toBeLessThanOrEqual(5.375);
	expect(
		tracks
			.filter((track) => track.endsWith("rem"))
			.reduce((sum, track) => sum + Number.parseFloat(track), 0),
	).toBeLessThanOrEqual(31.125);
});

it("names fixed list columns and respects header visibility", () => {
	const view = render(
		<StoryList columns={{ stage: false, sync: false }}>
			<span>Example row</span>
		</StoryList>,
	);
	const region = screen.getByRole("region", { name: "Work items" });
	for (const name of ["Item", "Title", "Priority"]) {
		expect(within(region).getByText(name)).toBeVisible();
	}
	expect(within(region).queryByText("Stage")).toBeNull();
	expect(within(region).getByText("PM sync")).toBeVisible();
	view.rerender(
		<StoryList>
			<span>Example row</span>
		</StoryList>,
	);
	expect(within(region).getByText("Stage")).toBeVisible();
	expect(within(region).getByText("PM sync")).toBeVisible();
});

it("localizes the complete German last-activity phrase", () => {
	fixtureLocale.value = "de";
	renderWithQueryClient(
		<StoryCard
			story={buildStory({ tasks: [], latestCodingRun: null })}
			projectId="example-project"
			onSelect={vi.fn()}
			onDelete={vi.fn()}
			showProvenance
		/>,
	);
	expect(screen.getByText(/^erstellt vor /)).toBeInTheDocument();
});
