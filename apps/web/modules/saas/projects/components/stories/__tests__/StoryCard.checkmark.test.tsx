import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
		(t as unknown as { rich: (key: string) => string }).rich = (
			key: string,
		) => key;
		return t;
	},
}));

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

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: { id: "test-user-id", name: "Test User" },
		session: { id: "test-session" },
		loaded: true,
		reloadSession: vi.fn(),
	}),
}));

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

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
	return {
		id: "story_1",
		identifier: "F-001",
		title: "Test story",
		description: null,
		acceptanceCriteria: null,
		statusId: "status_1",
		kind: "FEATURE",
		priority: "P2_MEDIUM",
		size: null,
		storyPoints: null,
		order: 1,
		roadmapOrder: 1,
		labels: [],
		tasks: [],
		assigneeId: null,
		createdById: "user_1",
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		externalId: null,
		externalUrl: "https://dev.azure.com/org/proj/_workitems/edit/1",
		externalMcpServerId: null,
		pmAutoSyncEnabled: false,
		source: "manual",
		version: 1,
		draftingStage: "PUBLISHED",
		draftingStageUpdatedAt: null,
		latestCodingRun: null,
		latestKanbanQueue: null,
		...overrides,
	};
}

describe("StoryCard terminal checkmark", () => {
	it("renders the checkmark when pmTicketTerminal is true", () => {
		renderWithQueryClient(
			<StoryCard
				story={makeStory({
					pmTicketTerminal: true,
					pmTicketTerminalStatus: "Done",
				})}
				projectId="project_1"
				onSelect={vi.fn()}
				onDelete={vi.fn()}
			/>,
		);
		expect(screen.getByLabelText(/Marked Done in/i)).toBeInTheDocument();
	});

	it("does not render the checkmark when pmTicketTerminal is false", () => {
		renderWithQueryClient(
			<StoryCard
				story={makeStory({ pmTicketTerminal: false })}
				projectId="project_1"
				onSelect={vi.fn()}
				onDelete={vi.fn()}
			/>,
		);
		expect(
			screen.queryByLabelText(/Marked|terminal status in/i),
		).not.toBeInTheDocument();
	});
});
