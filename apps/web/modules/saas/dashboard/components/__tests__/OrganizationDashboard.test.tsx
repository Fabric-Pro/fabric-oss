import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MyWorkResult } from "@repo/database";

const {
	useQueryMock,
	useNotificationsMock,
	useActiveOrganizationMock,
	useOnboardingStateMock,
	dismissOnboardingMutationMock,
	useMutationMock,
	createStoryMock,
	routerPushMock,
} = vi.hoisted(() => ({
	useQueryMock: vi.fn(),
	useNotificationsMock: vi.fn(),
	useActiveOrganizationMock: vi.fn(),
	useOnboardingStateMock: vi.fn(),
	dismissOnboardingMutationMock: vi.fn(),
	useMutationMock: vi.fn(),
	createStoryMock: vi.fn(),
	routerPushMock: vi.fn(),
}));

vi.mock("@repo/config", () => ({
	config: {
		dashboard: { inviteWelcomeWidget: { enabled: false } },
		prompts: { enabled: true },
	},
}));
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: { id: "user-1", name: "Dev Example", role: "member" },
	}),
}));
vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => useActiveOrganizationMock(),
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));
vi.mock("@saas/shared/components/IncidentChip", () => ({
	IncidentChip: () => null,
}));
vi.mock("@saas/shared/components/PendingInvitationsBanner", () => ({
	PendingInvitationsBanner: () => null,
}));
vi.mock("@saas/notifications/hooks/use-notifications", () => ({
	useNotifications: () => useNotificationsMock(),
}));
vi.mock("@saas/get-started/lib/use-onboarding-state", () => ({
	ONBOARDING_STATE_QUERY_KEY: ["users", "onboarding", "state"],
	useOnboardingState: () => useOnboardingStateMock(),
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: unknown) => useQueryMock(options),
	useMutation: (options: unknown) => useMutationMock(options),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: routerPushMock }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		dashboard: {
			myWork: vi.fn(),
			deliveryInsights: vi.fn(),
			curatedFeedback: { list: vi.fn(), record: vi.fn() },
		},
		projects: { stories: { create: createStoryMock } },
	},
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			shortcuts: { queryOptions: () => ({ queryKey: ["shortcuts"] }) },
			get: { queryOptions: () => ({ queryKey: ["project"] }) },
		},
		agents: {
			conversations: {
				list: { queryOptions: () => ({ queryKey: ["conversations"] }) },
			},
		},
		todos: { list: { queryOptions: () => ({ queryKey: ["todos"] }) } },
	},
}));
vi.mock("../DeliveryPulse", () => ({
	DeliveryPulse: () => <div>Delivery pulse</div>,
}));
vi.mock("../../lib/greetings", () => ({
	DASHBOARD_GREETING_COUNT: 6,
	getDashboardGreeting: () => "Welcome back, Dev",
}));

import { OrganizationDashboard } from "../OrganizationDashboard";

const work: MyWorkResult = {
	inProgress: { items: [], total: 0 },
	needsReview: { items: [], total: 0 },
	blocked: {
		total: 1,
		items: [
			{
				id: "run-1",
				kind: "codingRun",
				title: "Billing export",
				identifier: "FAB-131",
				subtitle: "Provider timed out",
				projectId: "project-1",
				projectName: "Example Portal",
				status: "Run failed",
				href: "/app/example-org/projects/project-1/stories/story-1",
				updatedAt: new Date("2026-11-05T09:00:00.000Z"),
			},
		],
	},
	drafts: { items: [], total: 0 },
	assignedFeatures: {
		total: 1,
		items: [
			{
				id: "story-1",
				kind: "feature",
				title: "Billing export",
				identifier: "FAB-131",
				projectId: "project-1",
				projectName: "Example Portal",
				deliveryStage: "readyForDev",
				href: "/app/example-org/projects/project-1/stories/story-1",
				updatedAt: new Date("2026-11-05T09:00:00.000Z"),
			},
		],
	},
	projectCount: 1,
	projectVisits: [],
};

const withoutDeliveryWork: MyWorkResult = {
	...work,
	inProgress: { items: [], total: 0 },
	needsReview: { items: [], total: 0 },
	blocked: { items: [], total: 0 },
	assignedFeatures: { items: [], total: 0 },
};

function queryResult(data: unknown) {
	return {
		data,
		isLoading: false,
		isError: false,
		isRefetching: false,
		refetch: vi.fn(),
	};
}

function clearNotifications() {
	useNotificationsMock.mockReturnValue({
		data: { pages: [{ items: [], nextCursor: null }] },
		isLoading: false,
		isError: false,
		isRefetching: false,
		refetch: vi.fn(),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	useActiveOrganizationMock.mockReturnValue({ isOrganizationAdmin: false });
	useOnboardingStateMock.mockReturnValue({
		data: { state: { status: "not_started" } },
	});
	dismissOnboardingMutationMock.mockReturnValue({
		mutate: vi.fn(),
		isPending: false,
	});
	useMutationMock.mockReturnValue(dismissOnboardingMutationMock());
	createStoryMock.mockResolvedValue({ story: { id: "story-1" } });
	useNotificationsMock.mockReturnValue({
		data: {
			pages: [
				{
					items: [
						{
							id: "health-1",
							type: "REPO_INTEGRATION_TOKEN_EXPIRED",
							title: "Repository token expired",
							snippet: "Reconnect the repository",
							link: "/app/example-org/projects/project-1?tab=settings",
							readAt: null,
							createdAt: "2026-11-05T10:00:00.000Z",
							projectId: "project-1",
							projectName: "Example Portal",
							organizationSlug: "example-org",
						},
					],
					nextCursor: null,
				},
			],
		},
		isLoading: false,
		isError: false,
		isRefetching: false,
		refetch: vi.fn(),
	});
	useQueryMock.mockImplementation((options: { queryKey: string[] }) => {
		switch (options.queryKey[0]) {
			case "dashboard":
				return queryResult(work);
			case "shortcuts":
				return queryResult({
					shortcuts: [
						{
							id: "project-1",
							name: "Example Portal",
							organizationSlug: "example-org",
							isFavorite: true,
							lastVisitedAt: "2026-11-05T00:00:00.000Z",
						},
					],
				});
			case "conversations":
				return queryResult({
					conversations: [
						{
							id: "chat-1",
							title: "Pricing model",
							updatedAt: "2026-11-05T10:00:00.000Z",
						},
					],
				});
			case "project":
				return queryResult({
					project: {
						id: "project-1",
						name: "Example Portal",
						contexts: [
							{
								id: "context-1",
								sourceTitle: "Approval policy v3.pdf",
							},
						],
						repositoryIntegrations: [
							{
								repositoryOwner: "example-org",
								repositoryName: "invoicing-service",
							},
						],
						_count: { documents: 2, contexts: 1 },
						canExecuteAgents: true,
					},
				});
			default:
				return queryResult({ items: [], hasMore: false });
		}
	});
});

function renderDashboard() {
	return render(
		<OrganizationDashboard
			organizationId="org-1"
			organizationName="Example Workspace"
			organizationSlug="example-org"
		/>,
	);
}

function mockExistingProjectWithoutWork() {
	clearNotifications();
	useQueryMock.mockImplementation((options: { queryKey: string[] }) => {
		switch (options.queryKey[0]) {
			case "dashboard":
				return queryResult(withoutDeliveryWork);
			case "shortcuts":
				return queryResult({
					shortcuts: [
						{
							id: "project-1",
							name: "Example Portal",
							organizationSlug: "example-org",
							isFavorite: true,
							lastVisitedAt: "2026-11-05T00:00:00.000Z",
						},
					],
				});
			case "conversations":
				return queryResult({
					conversations: [
						{
							id: "chat-1",
							title: "Pricing model",
							updatedAt: "2026-11-05T10:00:00.000Z",
						},
					],
				});
			case "project":
				return queryResult({
					project: {
						id: "project-1",
						name: "Example Portal",
						contexts: [
							{
								id: "context-1",
								sourceTitle: "Approval policy v3.pdf",
							},
						],
						repositoryIntegrations: [
							{
								repositoryOwner: "example-org",
								repositoryName: "invoicing-service",
							},
						],
						_count: { documents: 2, contexts: 1 },
						canExecuteAgents: true,
					},
				});
			default:
				return queryResult({ items: [], hasMore: false });
		}
	});
}

describe("OrganizationDashboard", () => {
	it("renders actionable work, continuation, features, and health without vanity reporting", () => {
		renderDashboard();

		expect(
			document.getElementById("organization-dashboard-title"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Curated for you" }),
		).toBeInTheDocument();
		expect(screen.getByText("Provider timed out")).toBeInTheDocument();
		expect(
			screen.getByText("Repository token expired"),
		).toBeInTheDocument();
		expect(screen.getByText("Pricing model")).toBeInTheDocument();
		expect(screen.getAllByText("Ready for dev")).toHaveLength(2);
		expect(
			screen.queryByText(/Cumulative Activity/),
		).not.toBeInTheDocument();
		expect(screen.queryByText("Quick Actions")).not.toBeInTheDocument();
	});

	it("shows two Up next actions in a sparse queue without duplicating them below", () => {
		renderDashboard();

		const upNext = screen.getByText("Up next").parentElement;
		expect(upNext).not.toBeNull();
		expect(within(upNext as HTMLElement).getAllByRole("link")).toHaveLength(
			2,
		);

		const curatedSection = screen
			.getByRole("heading", { name: "Curated for you" })
			.closest("section");
		expect(curatedSection).not.toBeNull();
		expect(
			within(curatedSection as HTMLElement).queryByRole("link", {
				name: "Open: Billing export",
			}),
		).not.toBeInTheDocument();
		expect(
			within(curatedSection as HTMLElement).queryByRole("link", {
				name: "Open project: Example Portal",
			}),
		).not.toBeInTheDocument();
	});

	it("hides Up next when real work fills the queue", () => {
		useQueryMock.mockImplementation((options: { queryKey: string[] }) => {
			if (options.queryKey[0] === "dashboard") {
				return queryResult({
					...work,
					blocked: {
						total: 3,
						items: [0, 1, 2].map((index) => ({
							...work.blocked.items[0],
							id: `run-${index}`,
							title: `Blocked run ${index}`,
						})),
					},
				});
			}
			return queryResult({ items: [], hasMore: false });
		});
		renderDashboard();

		expect(screen.queryByText("Up next")).not.toBeInTheDocument();
		expect(screen.getByText("Blocked run 2")).toBeInTheDocument();
	});

	it("shows the first-project experience when no reachable project exists", () => {
		clearNotifications();
		useQueryMock.mockImplementation((options: { queryKey: string[] }) => {
			if (options.queryKey[0] === "dashboard") {
				return queryResult({ ...withoutDeliveryWork, projectCount: 0 });
			}
			return queryResult(
				options.queryKey[0] === "shortcuts"
					? { shortcuts: [] }
					: { items: [] },
			);
		});
		renderDashboard();

		expect(
			screen.getByText("Create your first feature"),
		).toBeInTheDocument();
		expect(
			screen.getByText("You need a project first"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Create project" }),
		).toHaveAttribute("href", "/app/example-org/projects/new");
		expect(screen.getByRole("link", { name: "Ask Genie" })).toHaveAttribute(
			"href",
			expect.stringContaining(
				"/app/example-org/agents/fabric-ai?prompt=",
			),
		);
		expect(
			screen.queryByText("Needs you", { exact: false }),
		).not.toBeInTheDocument();
	});

	it("guides a first-run user with an existing project and keeps continuation visible", async () => {
		mockExistingProjectWithoutWork();
		const dismiss = vi.fn();
		dismissOnboardingMutationMock.mockReturnValue({
			mutate: dismiss,
			isPending: false,
		});
		useMutationMock.mockImplementation((options) => {
			const isCreateFeature = useMutationMock.mock.calls.length > 1;
			return isCreateFeature
				? {
						mutate: async () => {
							const result = await (
								options as {
									mutationFn: () => Promise<unknown>;
								}
							).mutationFn();
							(
								options as {
									onSuccess?: (result: unknown) => void;
								}
							).onSuccess?.(result);
						},
						isPending: false,
					}
				: dismissOnboardingMutationMock();
		});
		const user = userEvent.setup();
		renderDashboard();
		expect(
			screen.getByText("Create your first feature"),
		).toBeInTheDocument();
		expect(screen.getByText("Your project setup")).toBeInTheDocument();
		expect(
			screen.getByText("1 source available to people and agents"),
		).toBeInTheDocument();
		expect(screen.getByText("Repository connected")).toBeInTheDocument();
		expect(screen.getByText("Coding runs available")).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Manage context" }),
		).toHaveAttribute(
			"href",
			"/app/example-org/projects/project-1?tab=context",
		);

		await user.type(
			screen.getByRole("textbox", { name: "What do you want to build?" }),
			"Add approval routing for high-value invoices",
		);
		expect(
			screen.getByRole("textbox", { name: "What do you want to build?" }),
		).toHaveValue("Add approval routing for high-value invoices");
		expect(
			screen.getByRole("button", { name: "Create feature" }),
		).toBeEnabled();
		await user.click(
			screen.getByRole("button", { name: "Create feature" }),
		);
		expect(createStoryMock).toHaveBeenCalledWith({
			projectId: "project-1",
			organizationId: "org-1",
			description: "Add approval routing for high-value invoices",
		});
		expect(routerPushMock).toHaveBeenCalledWith(
			"/app/example-org/projects/project-1/stories/story-1",
		);
		expect(screen.getByText("Pricing model")).toBeInTheDocument();
		expect(screen.queryByText("My features")).not.toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: "Hide", exact: true }),
		);
		expect(dismiss).toHaveBeenCalledOnce();
	});

	it("shows the normal caught-up state after onboarding is complete", () => {
		useOnboardingStateMock.mockReturnValue({
			data: { state: { status: "completed" } },
		});
		mockExistingProjectWithoutWork();
		renderDashboard();

		expect(
			screen.getByText("Nothing needs you right now"),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Create your first feature"),
		).not.toBeInTheDocument();
	});

	it("offers builder actions only to organization admins", async () => {
		useActiveOrganizationMock.mockReturnValue({
			isOrganizationAdmin: true,
		});
		const user = userEvent.setup();
		renderDashboard();
		await user.click(screen.getByRole("button", { name: "New" }));

		expect(
			screen.getByRole("menuitem", { name: "New agent" }),
		).toBeInTheDocument();
	});

	it("does not show visited activity while visit history is loading", () => {
		useQueryMock.mockImplementation((options: { queryKey: string[] }) => {
			if (options.queryKey[0] === "dashboard") {
				return { ...queryResult(undefined), isLoading: true };
			}
			return queryResult({ items: [] });
		});
		useNotificationsMock.mockReturnValue({
			data: {
				pages: [
					{
						items: [
							{
								id: "activity-1",
								type: "DOCUMENT_GENERATION_COMPLETED",
								title: "Proposal generated",
								snippet: null,
								link: "/app/example-org/projects/project-1",
								readAt: "2026-11-05T10:00:00.000Z",
								createdAt: "2026-11-05T10:00:00.000Z",
								projectId: "project-1",
								projectName: "Example Portal",
								organizationSlug: "example-org",
							},
						],
						nextCursor: null,
					},
				],
			},
			isLoading: false,
			isError: false,
			isRefetching: false,
			refetch: vi.fn(),
		});
		renderDashboard();

		expect(
			screen.queryByText("1 document generated"),
		).not.toBeInTheDocument();
	});

	it("keeps a retry path visible when a source fails", () => {
		useQueryMock.mockImplementation((options: { queryKey: string[] }) => ({
			...queryResult(undefined),
			isError: options.queryKey[0] === "dashboard",
		}));
		renderDashboard();

		expect(screen.getByRole("alert")).toHaveTextContent(
			"Some dashboard data could not load",
		);
		expect(
			screen.getByRole("button", { name: "Retry" }),
		).toBeInTheDocument();
	});
});
