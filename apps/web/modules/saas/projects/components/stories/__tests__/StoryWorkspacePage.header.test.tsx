/**
 * The feature header's navigational row.
 *
 * Two things this guards, both found by measuring the running app rather than
 * by reading the code:
 *
 *  - The identifier cluster carried `aria-label` on a bare `<div>`. A div has no
 *    implicit role, so that label was dropped by screen readers and the priority
 *    — which the icon encodes only as a colour — reached sighted users alone.
 *  - At 375px the five-item breadcrumb sat beside a ~170px status chip in a
 *    360px row, shrank, and broke its text across three lines under the chip.
 *    jsdom has no layout, so the geometry is not assertable here; the class
 *    contract that produces it is, and that is what a future edit would drop.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { stories: { listAttachments: vi.fn() } } },
}));
vi.mock("../editor/ProvenanceSection", () => ({
	ProvenanceSection: () => <div data-testid="provenance">prov</div>,
}));
vi.mock("../../../hooks/useFeatureMaturationV2Enabled", () => ({
	useFeatureMaturationV2Enabled: () => false,
}));
vi.mock("../StoryWorkspace", () => ({
	StoryWorkspace: () => <div data-testid="workspace">workspace</div>,
}));
// `<CopilotChatSessionProvider>` (mounted by the page inside `<CopilotKit>`)
// calls `useCopilotChatInternal()` once for the whole surface, so the mock has
// to expose it. The session object is built inside the factory and returned by
// reference — a fresh literal per call would hand every consumer a new value on
// every render.
vi.mock("@copilotkit/react-core", () => {
	const session = {
		messages: [],
		visibleMessages: [],
		isLoading: false,
		appendMessage: async () => {},
		setMessages: () => {},
		interrupt: null,
		agent: undefined,
	};
	return {
		CopilotKit: ({ children }: { children: ReactNode }) => children,
		useCopilotChatInternal: () => session,
	};
});
vi.mock("@copilotkit/react-ui/styles.css", () => ({}));
vi.mock("@saas/agents/components/AgentErrorBoundary", () => ({
	AgentErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../pm-sync/PmSyncChip", () => ({ PmSyncChip: () => null }));
vi.mock("../StartWorkButton", () => ({ StartWorkButton: () => null }));
vi.mock("../StoryDownloadDropdown", () => ({
	StoryDownloadDropdown: () => null,
}));
vi.mock("../NeedsMoreInfoBadge", () => ({ NeedsMoreInfoBadge: () => null }));
// Mocked to null deliberately: the accessible name must come from the wrapper's
// own label, not from anything the icon happens to render.
vi.mock("../StoryKindIcon", () => ({ StoryKindIcon: () => null }));
vi.mock("../StoryCommentsButton", () => ({ StoryCommentsButton: () => null }));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		basePath: "/app/acme",
	}),
}));
vi.mock("@saas/shared/contexts/FullscreenContext", () => ({
	useFullscreen: () => ({ setIsFullscreen: vi.fn() }),
}));
vi.mock("@saas/shared/components/copilot/use-copilot-error-handler", () => ({
	useCopilotErrorHandler: () => vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock("../../../lib/stories/types", async (importActual) => {
	const actual = await importActual<Record<string, unknown>>();
	return {
		...actual,
		transformStory: (s: { id: string }) => ({
			id: s.id,
			title: "Header test feature",
			kind: "STORY",
			priority: "MEDIUM",
			identifier: "F-1",
			createdById: "u1",
		}),
		getPriorityLabel: () => "Medium",
	};
});

vi.mock("@shared/lib/orpc-query-utils", () => {
	const stub = (data: unknown) => ({
		queryOptions: (opts: { input: unknown }) => ({
			queryKey: ["stub", opts.input],
			queryFn: async () => data,
		}),
	});
	return {
		orpc: {
			projects: {
				get: stub({
					project: {
						id: "p1",
						// Long on purpose: this is the crumb that wrapped.
						name: "Foundry Test Bench",
						organizationId: "org-1",
					},
				}),
				members: { list: stub({ members: [] }) },
				stories: {
					get: stub({
						story: { id: "s1" },
						canEdit: true,
						canAddTags: true,
						canManageAllTags: true,
					}),
					pmCapabilities: stub({ configured: false }),
					statuses: { list: stub({ statuses: [] }) },
					priorityHistory: stub({
						items: [],
						nextCursor: null,
						initialPriority: null,
						totalCount: 0,
					}),
				},
			},
		},
	};
});

import { StoryWorkspacePage } from "../StoryWorkspacePage";

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		globalThis.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
	}
});

function renderPage() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<StoryWorkspacePage
				projectId="p1"
				storyId="s1"
				organizationSlug="acme"
			/>
		</QueryClientProvider>,
	);
}

describe("StoryWorkspacePage header — accessibility", () => {
	it("exposes the identifier and priority as an accessible name", async () => {
		renderPage();

		// Queried BY ROLE: on a bare div this resolves to nothing, because a div
		// has no implicit role for `aria-label` to attach to.
		expect(
			await screen.findByRole("img", {
				name: "Feature F-1, priority Medium",
			}),
		).toBeTruthy();
	});
});

describe("StoryWorkspacePage header — narrow-viewport layout", () => {
	it("drops the ancestor and Roadmap crumbs below the sm breakpoint", async () => {
		// Measured on a phone: with Roadmap present the project name — the only
		// flexible crumb — got 12px of the 114px it needs and rendered as "F..".
		// The action bar carries a labelled "Back to roadmap" control regardless.
		renderPage();

		for (const label of ["Organization", "Projects", "Roadmap"]) {
			const crumb = await screen.findByRole("link", { name: label });
			const item = crumb.closest("li");
			expect(item?.className).toContain("hidden");
			expect(item?.className).toContain("sm:");
		}
	});

	it("keeps the project crumb at every width", async () => {
		renderPage();

		const crumb = await screen.findByRole("link", {
			name: "Foundry Test Bench",
		});
		expect(crumb.closest("li")?.className ?? "").not.toContain("hidden");
	});

	it("keeps the full project name reachable when it is clipped", async () => {
		// `truncate` hides characters from sighted users only; the title puts
		// them back without changing what a screen reader already read.
		renderPage();

		const crumb = await screen.findByRole("link", {
			name: "Foundry Test Bench",
		});
		expect(crumb.getAttribute("title")).toBe("Foundry Test Bench");
	});

	it("still offers a way back to the roadmap at every width", async () => {
		// The mobile breadcrumb drops the Roadmap crumb, so this control is the
		// only remaining path back — hiding it too would strand the user.
		renderPage();

		expect(
			await screen.findByRole("button", { name: /back to roadmap/i }),
		).toBeTruthy();
	});

	it("holds the breadcrumb to one line and scrolls it inside itself", async () => {
		// On the ROW, the overflow would carry the PM chip off-screen with it.
		renderPage();

		const list = (
			await screen.findByRole("link", { name: "Roadmap" })
		).closest("ol");
		expect(list?.className).toContain("whitespace-nowrap");
		expect(list?.className).toContain("flex-nowrap");
		expect(list?.closest("nav")?.className).toContain("overflow-x-auto");
	});

	it("truncates the project name rather than letting it wrap", async () => {
		renderPage();

		const crumb = await screen.findByRole("link", {
			name: "Foundry Test Bench",
		});
		expect(crumb.className).toContain("truncate");
		expect(crumb.closest("li")?.className).toContain("min-w-0");
	});
});
