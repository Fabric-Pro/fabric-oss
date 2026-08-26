import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UserStory } from "../../../lib/stories/types";
import { StoryCard } from "../StoryCard";

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

vi.mock("next-intl", () => ({
	useTranslations: () => {
		const t = (key: string) => key;
		// PmSyncCloudToggle (mounted via Task 4.3) calls `t.rich(...)` for the
		// Not-configured and Conflict tooltip bodies. StoryCard tests don't
		// assert on tooltip content, so a stub that returns the key is enough
		// to keep render from crashing.
		(t as unknown as { rich: (key: string) => string }).rich = (
			key: string,
		) => key;
		return t;
	},
}));

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
});
