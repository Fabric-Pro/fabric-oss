/**
 * Unit tests for the `StoryCard` kebab menu hide/unhide item.
 *
 * Verifies that the menu item:
 *   - Reads "Hide feature" when `story.draftingStage !== "CLOSED"`.
 *   - Reads "Unhide feature" when `story.draftingStage === "CLOSED"`.
 *   - On click, calls `orpcClient.projects.stories.updateDraftingStage`
 *     with `targetStage: "CLOSED"` (or `"DRAFT"` when unhiding).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserStory } from "../../../lib/stories/types";

// jsdom doesn't implement ResizeObserver; Radix UI relies on it.
class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
	ResizeObserverStub;

// ---- Mocks ----------------------------------------------------------------

const updateDraftingStage = vi.fn();
const updateStory = vi.fn();
const reprioritizeStory = vi.fn();
const listQueryKey = vi.fn(() => ["stories-list"]);

vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				updateDraftingStage: (...args: unknown[]) =>
					updateDraftingStage(...args),
				// PmSyncCloudToggle (mounted on StoryCard via Task 4.3) calls
				// stories.update from its toggle mutation. These tests don't
				// exercise the toggle, but the import path must resolve.
				update: (...args: unknown[]) => updateStory(...args),
				reprioritizeStory: (...args: unknown[]) =>
					reprioritizeStory(...args),
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
				list: {
					queryKey: (...args: unknown[]) => listQueryKey(...args),
				},
				// PmSyncCloudToggle invalidates `stories.get` after a
				// successful toggle PATCH; stub the query-key shape so the
				// component can mount.
				get: {
					queryKey: () => ["stories-get"],
				},
				// useAiReprioritizeStory refreshes the priority-history caches
				// after a pass; stub the key shape so the hook can settle.
				priorityHistory: {
					key: () => ["priority-history"],
				},
				// useAiReassessEligibility reads the project's status list to
				// hide the AI entries on completed items; "status-done" is the
				// one final status the fixtures can opt into.
				statuses: {
					list: {
						queryOptions: (o: { input: unknown }) => ({
							queryKey: ["statuses", o.input],
							queryFn: async () => ({
								statuses: [
									{ id: "status-1", isFinal: false },
									{ id: "status-done", isFinal: true },
								],
							}),
						}),
					},
				},
				queueForKanban: {
					mutationOptions: () => ({
						mutationFn: async () => ({}),
					}),
				},
			},
		},
	},
}));

// PmSyncCloudToggle reads the user id from the session for telemetry
// payloads (Wave 4A, spec §7). Provide a deterministic test session.
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: { id: "test-user-id", name: "Test User" },
		session: { id: "test-session" },
		loaded: true,
		reloadSession: vi.fn(),
	}),
}));

// PmSyncCloudToggle reads the basePath from the org context to build the
// roadmap deep-link URL.
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

// Avoid pulling marketing/Weave and session runtime dependencies.
vi.mock("../../../lib/implementation-session-runtime", () => ({
	formatPrimaryTaskLabel: () => "",
	getImplementationSessionLinks: () => [],
	summarizeTaskSessionVisibility: () => ({ visible: false, total: 0 }),
}));

vi.mock("../../coding-runs/CodingRunStatusBadge", () => ({
	CodingRunStatusBadge: () => null,
}));

vi.mock("@saas/shared/components/FabricLogo", () => ({
	FabricLogo: () => null,
}));

// next-intl translations — return the key itself.
vi.mock("next-intl", () => ({
	useTranslations: () => {
		const t = (k: string) => k;
		// PmSyncCloudToggle (mounted via Task 4.3) calls `t.rich(...)` for the
		// Not-configured and Conflict tooltip bodies. Stub returns the key.
		(t as unknown as { rich: (k: string) => string }).rich = (k: string) =>
			k;
		return t;
	},
}));

// next/navigation is typically provided elsewhere; stub minimal API.
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/app/project/proj-1",
}));

// Sonner toasts — silence them.
vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		loading: vi.fn(),
	}),
}));

// Import AFTER mocks.
import { StoryCard } from "../StoryCard";

// ---- Fixtures -------------------------------------------------------------

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
	return {
		id: "story-1",
		identifier: "F-1",
		title: "Feature One",
		description: null,
		acceptanceCriteria: null,
		statusId: "status-1",
		priority: "P2_MEDIUM",
		size: null,
		storyPoints: null,
		order: 1,
		roadmapOrder: 1,
		labels: [],
		tasks: [],
		assigneeId: null,
		createdById: "user-1",
		createdAt: new Date(),
		updatedAt: new Date(),
		externalId: null,
		externalUrl: null,
		source: "manual",
		version: 1,
		draftingStage: "DRAFT",
		draftingStageUpdatedAt: null,
		...overrides,
	} as UserStory;
}

function renderCard(story: UserStory) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});

	return render(
		<QueryClientProvider client={client}>
			<StoryCard
				story={story}
				projectId="proj-1"
				organizationId={null}
				onSelect={() => undefined}
				onDelete={() => undefined}
			/>
		</QueryClientProvider>,
	);
}

// ---- Tests ----------------------------------------------------------------

beforeEach(() => {
	updateDraftingStage.mockReset();
	updateDraftingStage.mockResolvedValue({
		story: { id: "story-1", draftingStage: "CLOSED" },
	});
	updateStory.mockReset();
});

describe("StoryCard kebab — Hide / Unhide feature", () => {
	it("shows 'Hide feature' when draftingStage is not CLOSED", async () => {
		const user = userEvent.setup();
		renderCard(makeStory({ draftingStage: "DRAFT" }));

		// Open the kebab menu. The trigger is a More-horizontal button.
		const triggers = screen.getAllByRole("button");
		const kebab = triggers.find((btn) =>
			btn.querySelector(
				"svg.lucide-more-horizontal, svg.lucide-ellipsis",
			),
		);
		expect(kebab).toBeDefined();
		await user.click(kebab as HTMLElement);

		const item = await screen.findByRole("menuitem", {
			name: /hide feature/i,
		});
		expect(item).toBeInTheDocument();
		expect(
			screen.queryByRole("menuitem", { name: /unhide feature/i }),
		).toBeNull();
	});

	it("shows 'Unhide feature' when draftingStage === CLOSED", async () => {
		const user = userEvent.setup();
		renderCard(makeStory({ draftingStage: "CLOSED" }));

		const triggers = screen.getAllByRole("button");
		const kebab = triggers.find((btn) =>
			btn.querySelector(
				"svg.lucide-more-horizontal, svg.lucide-ellipsis",
			),
		);
		await user.click(kebab as HTMLElement);

		const item = await screen.findByRole("menuitem", {
			name: /unhide feature/i,
		});
		expect(item).toBeInTheDocument();
		expect(
			screen.queryByRole("menuitem", { name: /^hide feature$/i }),
		).toBeNull();
	});

	it("clicking 'Hide feature' calls updateDraftingStage with targetStage=CLOSED", async () => {
		const user = userEvent.setup();
		renderCard(makeStory({ draftingStage: "DRAFT" }));

		const triggers = screen.getAllByRole("button");
		const kebab = triggers.find((btn) =>
			btn.querySelector(
				"svg.lucide-more-horizontal, svg.lucide-ellipsis",
			),
		);
		await user.click(kebab as HTMLElement);

		const item = await screen.findByRole("menuitem", {
			name: /hide feature/i,
		});
		await user.click(item);

		expect(updateDraftingStage).toHaveBeenCalledTimes(1);
		expect(updateDraftingStage).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				storyId: "story-1",
				organizationId: null,
				targetStage: "CLOSED",
			}),
		);
	});

	it("clicking 'Unhide feature' calls updateDraftingStage with targetStage=DRAFT", async () => {
		const user = userEvent.setup();
		renderCard(makeStory({ draftingStage: "CLOSED" }));

		const triggers = screen.getAllByRole("button");
		const kebab = triggers.find((btn) =>
			btn.querySelector(
				"svg.lucide-more-horizontal, svg.lucide-ellipsis",
			),
		);
		await user.click(kebab as HTMLElement);

		const item = await screen.findByRole("menuitem", {
			name: /unhide feature/i,
		});
		await user.click(item);

		expect(updateDraftingStage).toHaveBeenCalledTimes(1);
		expect(updateDraftingStage).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				storyId: "story-1",
				organizationId: null,
				targetStage: "DRAFT",
			}),
		);
	});
});

describe("StoryCard kebab — Change priority submenu", () => {
	beforeEach(() => {
		updateStory.mockResolvedValue({ story: {} });
	});

	it("renders submenu with all four priorities", async () => {
		const user = userEvent.setup();
		renderCard(makeStory({ priority: "P2_MEDIUM" }));
		await user.click(
			screen.getByRole("button", { name: /story actions/i }),
		);
		await user.hover(screen.getByText("Change priority"));
		const submenu = await screen.findByRole("menu", {
			name: /change priority/i,
		});
		expect(within(submenu).getByText(/P0 - Critical/i)).toBeInTheDocument();
		expect(within(submenu).getByText(/P1 - High/i)).toBeInTheDocument();
		expect(within(submenu).getByText(/P2 - Medium/i)).toBeInTheDocument();
		expect(within(submenu).getByText(/P3 - Low/i)).toBeInTheDocument();
	});

	it("disables the current priority item and shows a checkmark", async () => {
		const user = userEvent.setup();
		renderCard(makeStory({ priority: "P2_MEDIUM" }));
		await user.click(
			screen.getByRole("button", { name: /story actions/i }),
		);
		await user.hover(screen.getByText("Change priority"));
		const current = await screen.findByRole("menuitem", {
			name: /P2 - Medium/i,
		});
		expect(current).toHaveAttribute("aria-disabled", "true");
		expect(
			within(current).getByTestId("priority-check"),
		).toBeInTheDocument();
	});

	it("calls stories.update with new priority on click of non-current item", async () => {
		const user = userEvent.setup();
		renderCard(makeStory({ id: "s-1", priority: "P2_MEDIUM" }));
		await user.click(
			screen.getByRole("button", { name: /story actions/i }),
		);
		await user.hover(screen.getByText("Change priority"));
		const target = await screen.findByRole("menuitem", {
			name: /P0 - Critical/i,
		});
		// Radix submenu MenuItems handle pointerdown/pointerup to gate the
		// synthetic click; in jsdom that gating swallows userEvent's click.
		// Dispatching the click directly mirrors the real-browser behavior
		// (the menuitem's composed onClick fires both the user-supplied
		// handler and Radix's onSelect). Mutation is async so we await
		// the spy via waitFor.
		fireEvent.click(target);
		await waitFor(() => {
			expect(updateStory).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: expect.any(String),
					storyId: "s-1",
					priority: "P0_CRITICAL",
				}),
			);
		});
	});
});

describe("StoryCard kebab — per-item AI re-prioritization", () => {
	it("offers the two AI entries below the bands for a visible item", async () => {
		const user = userEvent.setup();
		renderCard(makeStory({ priority: "P2_MEDIUM" }));
		await user.click(
			screen.getByRole("button", { name: /story actions/i }),
		);
		await user.hover(screen.getByText("Change priority"));
		const submenu = await screen.findByRole("menu", {
			name: /change priority/i,
		});
		expect(
			within(submenu).getByText("Re-assess priority with AI"),
		).toBeInTheDocument();
		// No whole-list mode here — that lives on the Re-prioritize button.
		expect(
			within(submenu).queryByText("Weigh against the list"),
		).not.toBeInTheDocument();
	});

	it("hides the AI entry on a hidden (CLOSED) item — the server refuses it", async () => {
		const user = userEvent.setup();
		renderCard(makeStory({ draftingStage: "CLOSED" }));
		await user.click(
			screen.getByRole("button", { name: /story actions/i }),
		);
		await user.hover(screen.getByText("Change priority"));
		const submenu = await screen.findByRole("menu", {
			name: /change priority/i,
		});
		expect(within(submenu).getByText(/P0 - Critical/i)).toBeInTheDocument();
		expect(
			within(submenu).queryByText("Re-assess priority with AI"),
		).not.toBeInTheDocument();
	});

	it("clicking the AI entry runs the isolated single-item pass", async () => {
		reprioritizeStory.mockResolvedValue({
			changed: false,
			fromPriority: null,
			toPriority: null,
			rationale: null,
			considered: 1,
		});
		const user = userEvent.setup();
		renderCard(makeStory({ priority: "P2_MEDIUM" }));
		await user.click(
			screen.getByRole("button", { name: /story actions/i }),
		);
		await user.hover(screen.getByText("Change priority"));
		const target = await screen.findByRole("menuitem", {
			name: /Re-assess priority with AI/,
		});
		// Same jsdom workaround as the band-click test above: Radix submenu
		// items gate userEvent's synthetic click, so dispatch it directly.
		fireEvent.click(target);
		await waitFor(() =>
			expect(reprioritizeStory).toHaveBeenCalledWith(
				expect.objectContaining({
					storyId: "story-1",
					withListContext: false,
				}),
			),
		);
	});
});

describe("StoryCard kebab — AI entries and completion", () => {
	it("hides the AI entries on a completed (final-status) item", async () => {
		const user = userEvent.setup();
		renderCard(makeStory({ statusId: "status-done" }));
		await user.click(
			screen.getByRole("button", { name: /story actions/i }),
		);
		await user.hover(screen.getByText("Change priority"));
		const submenu = await screen.findByRole("menu", {
			name: /change priority/i,
		});
		// The manual bands stay; only the AI pass is withheld — the server
		// refuses completed targets.
		expect(within(submenu).getByText(/P0 - Critical/i)).toBeInTheDocument();
		await waitFor(() =>
			expect(
				within(submenu).queryByText("Re-assess priority with AI"),
			).not.toBeInTheDocument(),
		);
	});
});
