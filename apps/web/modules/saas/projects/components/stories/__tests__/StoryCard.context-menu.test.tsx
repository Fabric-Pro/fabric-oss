/**
 * Component tests for the `StoryCard` right-click / middle-click "Open in
 * new tab" context menu (spec
 * `2026-05-25-backlog-context-menu-open-in-new-tab` §9.2). Mocks
 * `window.open`, `useRouter`, and `useAnalytics` so each assertion targets
 * a single FR. The "Open in new tab" action opens `about:blank` first and
 * then assigns `w.location.href` to the ticket URL so installed PWAs do
 * not capture the new tab into the standalone window.
 *
 * Keyboard-trigger note: spec FR-17 explicitly allows the keyboard path
 * to be tagged with `trigger: "context-menu"` when Radix does not cleanly
 * expose the trigger reason. The keyboard test below therefore asserts
 * the menu opens via Shift+F10 + the action fires; it is lenient about
 * the analytics `trigger` value.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserStory } from "../../../lib/stories/types";

// jsdom doesn't implement ResizeObserver; Radix relies on it.
class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
	ResizeObserverStub;

// ---- Mocks ----------------------------------------------------------------

const routerPush = vi.fn();
const trackEvent = vi.fn();

vi.mock("@analytics", () => ({
	useAnalytics: () => ({
		trackEvent,
	}),
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
					key: () => ["stories-list"],
				},
				get: {
					queryKey: () => ["stories-get"],
					key: () => ["stories-get"],
				},
				// Fizzy #2048: the card follows the body redraft a type change
				// starts. The read is gated on this item being watched, and
				// nothing here converts anything, so it stays idle.
				regenerationStatus: {
					queryOptions: (o: { input: unknown }) => ({
						queryKey: ["story-regeneration-status", o.input],
						queryFn: async () => ({ status: "idle" }),
					}),
				},
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

vi.mock("../../../lib/implementation-session-runtime", () => ({
	formatPrimaryTaskLabel: () => "",
	getImplementationSessionLinks: () => [],
	summarizeTaskSessionVisibility: () => ({ visible: false, total: 0 }),
}));

vi.mock("../../coding-runs/CodingRunStatusBadge", () => ({
	CodingRunStatusBadge: () => null,
}));

vi.mock("next-intl", () => ({
	useTranslations: () => {
		const t = (k: string) => {
			// Render the leaf `openInNewTab` to the human-readable label so
			// the right-click → menu-item lookup-by-text works in
			// `screen.findByText`.
			if (k === "openInNewTab") {
				return "Open in new tab";
			}
			return k;
		};
		(t as unknown as { rich: (k: string) => string }).rich = (k: string) =>
			k;
		return t;
	},
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: routerPush, refresh: vi.fn() }),
	usePathname: () => "/app/projects/proj-1",
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		success: vi.fn(),
		error: vi.fn(),
		warning: vi.fn(),
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
		kind: "FEATURE",
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
		pmAutoSyncEnabled: false,
		...overrides,
	} as UserStory;
}

function renderCard(
	props: {
		story?: UserStory;
		projectId?: string;
		basePath?: string;
		canReorder?: boolean;
	} = {},
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});

	return render(
		<QueryClientProvider client={client}>
			<StoryCard
				story={props.story ?? makeStory()}
				projectId={props.projectId ?? "proj-1"}
				basePath={props.basePath ?? "/app/acme"}
				organizationId={null}
				canReorder={props.canReorder}
				disableInlineRename
				onSelect={() => undefined}
				onDelete={() => undefined}
			/>
		</QueryClientProvider>,
	);
}

// The row is `<div role="button">` — fetch by the title visible inside it.
function getRow(): HTMLElement {
	const title = screen.getByTestId("story-card-title");
	const row = title.closest('[role="button"]');
	if (!(row instanceof HTMLElement)) {
		throw new Error("Could not locate story row by role=button ancestor");
	}
	return row;
}

// Middle-click navigation listens on `mousedown` (button 1), not `auxclick`,
// because Chromium does not reliably fire `auxclick` on non-anchor elements.
// Dispatch a native event with the correct `button` field instead.
function dispatchAuxClick(target: HTMLElement, button: number): void {
	const ev = new MouseEvent("mousedown", {
		bubbles: true,
		cancelable: true,
		button,
	});
	target.dispatchEvent(ev);
}

// "Open in new tab" uses `window.open('about:blank', '_blank')` then assigns
// `w.location.href = url` so installed PWAs do not capture the new tab into
// the standalone window (modern Chrome routes any in-scope navigation —
// declarative anchor click, programmatic anchor click, and `window.open(url,
// '_blank')` — into the destination PWA when its manifest opts in via
// `capture_links`; only `about:blank` then `location.href` reliably bypasses
// the capture). This helper mocks `window.open` to return a fake window
// whose `location.href` assignments are recorded so tests can assert
// against the navigated URL.
type CapturedAnchor = { url: string; target: string; rel: string };
function captureAnchorOpens(): {
	calls: CapturedAnchor[];
	restore: () => void;
} {
	const calls: CapturedAnchor[] = [];
	const orig = window.open;
	window.open = ((urlArg?: string | URL, target?: string) => {
		const initialUrl =
			typeof urlArg === "string" ? urlArg : (urlArg?.toString() ?? "");
		const fakeWindow = {
			opener: {} as unknown,
			location: {
				_href: initialUrl,
				set href(value: string) {
					this._href = value;
					calls.push({
						url: value,
						target: target ?? "",
						rel: "noopener noreferrer",
					});
				},
				get href() {
					return this._href;
				},
			},
		} as unknown as Window;
		return fakeWindow;
	}) as typeof window.open;
	return {
		calls,
		restore: () => {
			window.open = orig;
		},
	};
}

// ---- Tests ----------------------------------------------------------------

beforeEach(() => {
	routerPush.mockReset();
	trackEvent.mockReset();
});

describe("StoryCard context menu — FR-1/2/6 right-click", () => {
	it("opens the context menu when the row is right-clicked", async () => {
		renderCard();
		fireEvent.contextMenu(getRow());
		expect(await screen.findByText("Open in new tab")).toBeInTheDocument();
	});
});

describe("StoryCard context menu — FR-5 dismissal", () => {
	it("closes the menu when Escape is pressed", async () => {
		const user = userEvent.setup();
		renderCard();

		fireEvent.contextMenu(getRow());
		expect(await screen.findByText("Open in new tab")).toBeInTheDocument();

		await user.keyboard("{Escape}");
		expect(screen.queryByText("Open in new tab")).not.toBeInTheDocument();
	});

	it("closes the menu when the user clicks outside", async () => {
		renderCard();

		fireEvent.contextMenu(getRow());
		expect(await screen.findByText("Open in new tab")).toBeInTheDocument();

		// Use fireEvent.pointerDown directly — Radix listens for pointerdown
		// outside the content to dismiss, and user-event refuses to click on
		// elements with the inherited `pointer-events: none` Radix applies
		// to the body while the menu is open.
		fireEvent.pointerDown(document.body, {
			pointerType: "mouse",
			button: 0,
		});
		fireEvent.pointerUp(document.body, {
			pointerType: "mouse",
			button: 0,
		});
		expect(screen.queryByText("Open in new tab")).not.toBeInTheDocument();
	});
});

describe("StoryCard context menu — FR-3/13/17 action invocation", () => {
	it("opens a new tab with the shared route + emits the context-menu analytics event", async () => {
		const capture = captureAnchorOpens();
		try {
			const user = userEvent.setup();
			renderCard({
				basePath: "/app/acme",
				story: makeStory({ id: "s-42" }),
				projectId: "p-1",
			});

			fireEvent.contextMenu(getRow());
			const item = await screen.findByText("Open in new tab");
			await user.click(item);

			expect(capture.calls).toHaveLength(1);
			expect(capture.calls[0].url).toContain(
				"/app/acme/projects/p-1/stories/s-42",
			);
			expect(capture.calls[0].target).toBe("_blank");
			expect(capture.calls[0].rel).toBe("noopener noreferrer");
			expect(trackEvent).toHaveBeenCalledWith(
				"backlog.story.openInNewTab",
				{ trigger: "context-menu" },
			);
		} finally {
			capture.restore();
		}
	});

	it("silently no-ops when projectId is empty (FR-13)", async () => {
		const capture = captureAnchorOpens();
		try {
			const user = userEvent.setup();
			renderCard({ projectId: "" });

			fireEvent.contextMenu(getRow());
			const item = await screen.findByText("Open in new tab");
			await user.click(item);

			expect(capture.calls).toHaveLength(0);
			expect(trackEvent).not.toHaveBeenCalled();
		} finally {
			capture.restore();
		}
	});
});

describe("StoryCard middle-click — FR-9", () => {
	it("opens a new tab with the same URL and emits trigger: middle-click", () => {
		const capture = captureAnchorOpens();
		try {
			renderCard({
				basePath: "/app/acme",
				story: makeStory({ id: "s-42" }),
				projectId: "p-1",
			});
			dispatchAuxClick(getRow(), 1);

			expect(capture.calls).toHaveLength(1);
			expect(capture.calls[0].url).toContain(
				"/app/acme/projects/p-1/stories/s-42",
			);
			expect(capture.calls[0].target).toBe("_blank");
			expect(capture.calls[0].rel).toBe("noopener noreferrer");
			expect(trackEvent).toHaveBeenCalledWith(
				"backlog.story.openInNewTab",
				{ trigger: "middle-click" },
			);
		} finally {
			capture.restore();
		}
	});

	it("does NOT navigate when middle-click lands on the drag handle (FR-9 grip exception)", () => {
		const capture = captureAnchorOpens();
		try {
			// The active drag handle only renders in manual "Roadmap order"
			// (canReorder); when a non-manual sort is active the grip is a
			// disabled, non-interactive span instead.
			renderCard({ canReorder: true });
			const grip = screen.getByTestId("story-card-drag-handle");
			dispatchAuxClick(grip, 1);
			expect(capture.calls).toHaveLength(0);
		} finally {
			capture.restore();
		}
	});

	it("opens a new tab when middle-click lands on the title (FR-9 — event must bubble from title button)", () => {
		const capture = captureAnchorOpens();
		try {
			renderCard({
				basePath: "/app",
				story: makeStory({ id: "s-77", title: "Inside title middle" }),
				projectId: "p-9",
			});
			const titleButton = screen.getByRole("button", {
				name: /Open details for Inside title middle/i,
			});
			dispatchAuxClick(titleButton, 1);
			expect(capture.calls).toHaveLength(1);
			expect(capture.calls[0].url).toContain(
				"/app/projects/p-9/stories/s-77",
			);
			expect(capture.calls[0].target).toBe("_blank");
			expect(capture.calls[0].rel).toBe("noopener noreferrer");
		} finally {
			capture.restore();
		}
	});
});

describe("StoryCard — nested interactives still work after FR-7 wrap", () => {
	it("opens the kebab dropdown on left-click and does NOT trigger row navigation", async () => {
		const onSelect = vi.fn();
		const user = userEvent.setup();
		render(
			<QueryClientProvider
				client={
					new QueryClient({
						defaultOptions: {
							queries: { retry: false },
							mutations: { retry: false },
						},
					})
				}
			>
				<StoryCard
					story={makeStory()}
					projectId="p-1"
					basePath="/app/acme"
					organizationId={null}
					disableInlineRename
					onSelect={onSelect}
					onDelete={() => undefined}
				/>
			</QueryClientProvider>,
		);

		const kebab = screen.getByRole("button", { name: "Story actions" });
		await user.click(kebab);

		// Kebab menu items render once open.
		expect(await screen.findByText("Open details")).toBeInTheDocument();
		// Left-click on the kebab does NOT call onSelect (FR-7 — nested
		// interactive left-click unaffected).
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("calls onSelect on left-click of the row body (existing behavior preserved)", async () => {
		const onSelect = vi.fn();
		const user = userEvent.setup();
		render(
			<QueryClientProvider
				client={
					new QueryClient({
						defaultOptions: {
							queries: { retry: false },
							mutations: { retry: false },
						},
					})
				}
			>
				<StoryCard
					story={makeStory()}
					projectId="p-1"
					basePath="/app/acme"
					organizationId={null}
					disableInlineRename
					onSelect={onSelect}
					onDelete={() => undefined}
				/>
			</QueryClientProvider>,
		);

		await user.click(getRow());
		expect(onSelect).toHaveBeenCalledWith("story-1");
	});
});
