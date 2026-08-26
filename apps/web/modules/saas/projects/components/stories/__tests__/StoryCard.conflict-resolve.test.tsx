/**
 * StoryCard ↔ ConflictResolveDialog wiring: a successful conflict resolve from
 * the roadmap pill must fire the shared PM-sync invalidation helper (the
 * dialog itself never invalidates queries — the caller owns it), and a
 * `cleared: false` outcome (PM push couldn't be enqueued) must NOT fire it:
 * the conflict flag intentionally stays, so the pill must keep rendering.
 *
 * Drives the REAL ConflictResolveDialog (preview self-fetched via
 * `checkPmSyncConflicts`) the same way ConflictResolveDialog.test.tsx does;
 * only the invalidation hook is mocked with a spy.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserStory } from "../../../lib/stories/types";

const checkPmSyncConflicts = vi.fn();
const resolveConflict = vi.fn();
const invalidatePmSyncState = vi.fn();
const useInvalidatePmSyncStateMock = vi.fn(() => invalidatePmSyncState);
const toastError = vi.fn();

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
				checkPmSyncConflicts: (...args: unknown[]) =>
					checkPmSyncConflicts(...args),
				resolveConflict: (...args: unknown[]) =>
					resolveConflict(...args),
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
		error: (...args: unknown[]) => toastError(...args),
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

function buildConflictStory(overrides: Partial<UserStory> = {}): UserStory {
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
		externalId: "ext-1",
		externalUrl: "https://example.com/ticket/1",
		pmAutoSyncEnabled: true,
		lastPmSyncStatus: "CONFLICT",
		latestCodingRun: null,
		draftingStage: "DRAFT",
		draftingStageUpdatedAt: null,
		...overrides,
	};
}

function renderConflictCard() {
	return renderWithQueryClient(
		<StoryCard
			story={buildConflictStory()}
			projectId="project_1"
			onSelect={vi.fn()}
			onDelete={vi.fn()}
		/>,
	);
}

async function resolveViaUseFabric(user: ReturnType<typeof userEvent.setup>) {
	// The pill opens the dialog with no pre-fetched preview, so the dialog
	// fetches its own single-item preview via checkPmSyncConflicts.
	await user.click(screen.getByRole("button", { name: /PM sync conflict/i }));
	const useFabric = await screen.findByRole("button", {
		name: "Use Fabric",
	});
	await waitFor(() => expect(useFabric).toBeEnabled());
	await user.click(useFabric);
	await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
	checkPmSyncConflicts.mockReset();
	resolveConflict.mockReset();
	invalidatePmSyncState.mockReset();
	useInvalidatePmSyncStateMock.mockClear();
	toastError.mockClear();
	checkPmSyncConflicts.mockResolvedValue({
		results: [
			{
				id: "story_1",
				itemType: "story",
				hasConflict: true,
				pmCurrent: {
					title: "PM-side edited title",
					description: "PM-side edited description.",
					lastChangedBy: "Jamie Rivera",
					lastChangedAt: "2026-05-20T10:30:00Z",
				},
				pmUrl: "https://example.com/ticket/1",
				pmTool: "azure-devops",
			},
		],
	});
});

describe("StoryCard — conflict resolve invalidation wiring", () => {
	it("instantiates the shared helper with the card's projectId", () => {
		renderConflictCard();
		expect(useInvalidatePmSyncStateMock).toHaveBeenCalledWith("project_1");
	});

	it("fires the shared invalidation after a successful resolve (cleared: true)", async () => {
		resolveConflict.mockResolvedValue({ cleared: true });
		const user = userEvent.setup();
		renderConflictCard();

		await resolveViaUseFabric(user);

		await waitFor(() =>
			expect(invalidatePmSyncState).toHaveBeenCalledTimes(1),
		);
	});

	it("does NOT fire the invalidation when the resolution couldn't sync (cleared: false)", async () => {
		// The flag (and the pill) intentionally stay; the dialog surfaces the
		// typed pmError instead of a false success.
		resolveConflict.mockResolvedValue({
			cleared: false,
			pmError: { kind: "EXPIRED" },
		});
		const user = userEvent.setup();
		renderConflictCard();

		await resolveViaUseFabric(user);

		await waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(invalidatePmSyncState).not.toHaveBeenCalled();
	});
});
