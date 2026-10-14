/**
 * StoryCard ↔ failure panel wiring for "Link to existing item": the roadmap
 * card wires the panel's action only while the story has no PM link, sends
 * the named item to `projects.stories.linkPmItem`, and refreshes the shared
 * PM-sync state whether the link lands or is refused. The panel and its
 * dialog are real; only the oRPC client and the invalidation hook are mocked.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserStory } from "../../../lib/stories/types";

const retryPmSync = vi.fn();
const linkPmItem = vi.fn();
const invalidatePmSyncState = vi.fn();
const useInvalidatePmSyncStateMock = vi.fn(() => invalidatePmSyncState);

const UNCONFIRMED =
	"The create request to Jira got no definite answer (timed out), so a Jira item may already exist for this item. Check Jira; if there is none, use Unlink & re-create.";

vi.mock("../pm-sync/use-invalidate-pm-sync-state", () => ({
	useInvalidatePmSyncState: (...args: unknown[]) =>
		useInvalidatePmSyncStateMock(...args),
}));

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
		// PmSyncCloudToggle calls `t.rich(...)` for tooltip bodies; tests here
		// don't assert tooltip content, so returning the key keeps render alive.
		(t as unknown as { rich: (key: string) => string }).rich = (
			key: string,
		) => key;
		return t;
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				updateDraftingStage: vi.fn(),
				update: vi.fn(),
				checkPmSyncConflicts: vi.fn(),
				resolveConflict: vi.fn(),
				retryPmSync: (...args: unknown[]) => retryPmSync(...args),
				linkPmItem: (...args: unknown[]) => linkPmItem(...args),
				proposeAiMerge: vi.fn(),
				dismissPmSyncConflict: vi.fn().mockResolvedValue({}),
			},
			pmStateChanges: {
				resolveContentDrift: vi.fn(),
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
		info: vi.fn(),
		warning: vi.fn(),
	}),
}));

import { StoryCard } from "../StoryCard";

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
		title: "Checkout refactor",
		description: "Fabric-side description with extra local detail.",
		acceptanceCriteria: null,
		statusId: "status_1",
		kind: "FEATURE",
		priority: "P1_HIGH",
		size: "M",
		storyPoints: 5,
		order: 1,
		roadmapOrder: 1,
		labels: [],
		tasks: [],
		assigneeId: null,
		createdById: "user_1",
		createdAt: new Date("2026-05-27T00:00:00.000Z"),
		updatedAt: new Date("2026-05-28T00:00:00.000Z"),
		externalId: null,
		externalUrl: null,
		pmAutoSyncEnabled: true,
		lastPmSyncStatus: "FAILED",
		lastPmSyncError: UNCONFIRMED,
		latestCodingRun: null,
		draftingStage: "DRAFT",
		draftingStageUpdatedAt: null,
		...overrides,
	};
}

function renderCard(overrides: Partial<UserStory> = {}) {
	return renderWithQueryClient(
		<StoryCard
			story={buildStory(overrides)}
			projectId="project_1"
			pmToolName="Jira"
			onSelect={vi.fn()}
			onDelete={vi.fn()}
		/>,
	);
}

async function openLinkDialog(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("button", { name: /PM sync failed/i }));
	await user.click(
		await screen.findByRole("button", { name: /Link to existing item/i }),
	);
	return screen.findByLabelText("Jira item ID or key");
}

beforeEach(() => {
	retryPmSync.mockReset();
	linkPmItem.mockReset();
	invalidatePmSyncState.mockReset();
	useInvalidatePmSyncStateMock.mockClear();
});

describe("StoryCard — Link to existing item", () => {
	it("links an unlinked story to the named item and refreshes PM-sync state", async () => {
		linkPmItem.mockResolvedValue({
			linked: true,
			externalId: "PROJ-12",
			externalUrl: null,
		});
		const user = userEvent.setup();
		renderCard();

		await user.type(await openLinkDialog(user), "PROJ-12");
		await user.click(screen.getByRole("button", { name: "Link item" }));

		await waitFor(() =>
			expect(linkPmItem).toHaveBeenCalledWith({
				projectId: "project_1",
				storyId: "story_1",
				externalId: "PROJ-12",
				organizationId: null,
			}),
		);
		await waitFor(() => expect(invalidatePmSyncState).toHaveBeenCalled());
		expect(retryPmSync).not.toHaveBeenCalled();
	});

	it("shows the refusal in the dialog and refreshes PM-sync state", async () => {
		linkPmItem.mockRejectedValue(
			new Error('Item "PROJ-12" was not found in the PM tool.'),
		);
		const user = userEvent.setup();
		renderCard();

		await user.type(await openLinkDialog(user), "PROJ-12");
		await user.click(screen.getByRole("button", { name: "Link item" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			'Item "PROJ-12" was not found in the PM tool.',
		);
		await waitFor(() => expect(invalidatePmSyncState).toHaveBeenCalled());
	});

	it("is not offered on a linked story", async () => {
		const user = userEvent.setup();
		renderCard({
			externalId: "ext-1",
			externalUrl: "https://example.com/ticket/1",
		});

		await user.click(
			screen.getByRole("button", { name: /PM sync failed/i }),
		);

		expect(
			await screen.findByRole("button", { name: /Unlink & re-create/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Link to existing item/i }),
		).not.toBeInTheDocument();
	});
});
