/**
 * Unit tests for the `StoryCard` kebab Download submenu (Group 6 / spec §5.1).
 *
 * Verifies:
 *   - The submenu renders three format items (Markdown, PDF, Word).
 *   - Clicking a format invokes the matching `useStoryDownloadActions`
 *     branch (which proxies to the precomputed downloader functions).
 *   - A stub feature shows the warning toast and does NOT trigger any
 *     renderer.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// Real-renderer doubles. The kebab submenu is wired through the same
// `useStoryDownloadActions` hook the workspace uses; mocking the renderer
// module catches both the dynamic-import path and the toast assertions.
const triggerBlobDownloadMock = vi.fn();
const renderMarkdownToPdfMock = vi.fn(async () => new Blob(["pdf-bytes"]));
const renderMarkdownToDocxMock = vi.fn(async () => new Blob(["docx-bytes"]));

vi.mock("../../../lib/markdown-to-document", () => ({
	triggerBlobDownload: triggerBlobDownloadMock,
	renderMarkdownToPdf: renderMarkdownToPdfMock,
	renderMarkdownToDocx: renderMarkdownToDocxMock,
}));

const toastWarningMock = vi.fn();
const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();
vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		warning: (...args: unknown[]) => toastWarningMock(...args),
		error: (...args: unknown[]) => toastErrorMock(...args),
		success: (...args: unknown[]) => toastSuccessMock(...args),
	}),
}));

vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				updateDraftingStage: vi.fn(),
				// PmSyncCloudToggle (mounted on StoryCard via Task 4.3) needs
				// stories.update to resolve; this test never exercises the
				// toggle itself.
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
				list: {
					queryKey: () => ["stories-list"],
				},
				get: {
					queryKey: () => ["stories-get"],
				},
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

// PmSyncCloudToggle reads the basePath from the org context for the
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

// next-intl translations — return the key itself so the menu items are
// queryable by `format.markdown`, `format.pdf`, `format.docx`, `action`.
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

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/app/project/proj-1",
}));

// Import AFTER mocks.
import { StoryCard } from "../StoryCard";

// ---- Fixtures -------------------------------------------------------------

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
	return {
		id: "story-1",
		identifier: "F-1",
		title: "Feature One",
		description: "Has content.",
		acceptanceCriteria: "- ok",
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
				projectName="Acme Web"
				organizationId={null}
				onSelect={() => undefined}
				onDelete={() => undefined}
			/>
		</QueryClientProvider>,
	);
}

async function openKebabAndDownloadSubmenu() {
	// `pointerEventsCheck: 0` — Radix DropdownMenu sets `pointer-events: none`
	// on `<body>` while it manages focus; jsdom doesn't model the pointer-events
	// resolution and userEvent's default check rejects every click. Disabling
	// the check is the recommended workaround for Radix-driven popovers in
	// component tests.
	const user = userEvent.setup({ pointerEventsCheck: 0 });
	const triggers = screen.getAllByRole("button");
	const kebab = triggers.find((btn) =>
		btn.querySelector("svg.lucide-more-horizontal, svg.lucide-ellipsis"),
	);
	expect(kebab).toBeDefined();
	await user.click(kebab as HTMLElement);

	const subTrigger = await screen.findByRole("menuitem", {
		name: /^action$/i,
	});
	await user.click(subTrigger);
	return user;
}

// ---- Tests ----------------------------------------------------------------

beforeEach(() => {
	triggerBlobDownloadMock.mockReset();
	renderMarkdownToPdfMock.mockClear();
	renderMarkdownToDocxMock.mockClear();
	toastWarningMock.mockReset();
	toastErrorMock.mockReset();
});

describe("StoryCard kebab — Download submenu", () => {
	it("renders three format items (Markdown / PDF / Word) under the Download submenu", async () => {
		renderCard(makeStory());
		await openKebabAndDownloadSubmenu();

		expect(
			await screen.findByRole("menuitem", { name: /format\.markdown/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("menuitem", { name: /format\.pdf/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("menuitem", { name: /format\.docx/i }),
		).toBeInTheDocument();
	});

	it("Markdown click triggers triggerBlobDownload with a .md filename", async () => {
		renderCard(makeStory());
		await openKebabAndDownloadSubmenu();

		// Use `fireEvent.click` here — Radix's submenu items in jsdom do
		// not always receive the synthesized pointer sequence userEvent emits,
		// while the bare React click event reliably fires the handler.
		fireEvent.click(
			await screen.findByRole("menuitem", { name: /format\.markdown/i }),
		);

		await waitFor(() => {
			expect(triggerBlobDownloadMock).toHaveBeenCalledTimes(1);
		});
		const [, filename] = triggerBlobDownloadMock.mock.calls[0];
		expect(filename).toMatch(/\.md$/);
	});

	it("PDF click invokes the renderMarkdownToPdf renderer", async () => {
		renderCard(makeStory());
		await openKebabAndDownloadSubmenu();

		fireEvent.click(
			await screen.findByRole("menuitem", { name: /format\.pdf/i }),
		);

		await waitFor(() => {
			expect(renderMarkdownToPdfMock).toHaveBeenCalledTimes(1);
		});
	});

	it("stub feature shows the warning toast and skips every renderer", async () => {
		renderCard(
			makeStory({
				draftingStage: "PLACEHOLDER",
				description: null,
				acceptanceCriteria: null,
				tasks: [],
			}),
		);
		await openKebabAndDownloadSubmenu();

		fireEvent.click(
			await screen.findByRole("menuitem", { name: /format\.markdown/i }),
		);

		await waitFor(() => {
			expect(toastWarningMock).toHaveBeenCalledWith("stubBlocked");
		});
		expect(triggerBlobDownloadMock).not.toHaveBeenCalled();
		expect(renderMarkdownToPdfMock).not.toHaveBeenCalled();
		expect(renderMarkdownToDocxMock).not.toHaveBeenCalled();
	});
});
