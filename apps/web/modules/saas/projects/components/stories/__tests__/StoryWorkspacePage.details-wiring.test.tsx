/**
 * Seam test: proves StoryDetailsButton is reachable from the LIVE full-page
 * editor (StoryWorkspacePage) and that its members query reads the PROJECT's
 * org id, not the ambient org context. ProvenanceSection is stubbed — the page
 * wiring + org id are what this test guards (provenance rendering is covered by
 * ProvenanceSection.test.tsx and StoryDetailsButton.test.tsx).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const { membersFn, listAttachments } = vi.hoisted(() => ({
	membersFn: vi.fn(),
	listAttachments: vi.fn(),
}));

// The now-always-rendered StoryAttachmentsButton eagerly queries the
// attachment list on mount (#1778) — stub it so this file stays focused on
// details/provenance wiring (mirrors StoryWorkspacePage.attachments-wiring.test.tsx).
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { stories: { listAttachments } } },
}));
// Stub ProvenanceSection — wiring + org id are the subject, not its rendering.
vi.mock("../editor/ProvenanceSection", () => ({
	ProvenanceSection: () => <div data-testid="provenance">prov</div>,
}));

vi.mock("../../../hooks/useFeatureMaturationV2Enabled", () => ({
	useFeatureMaturationV2Enabled: () => false,
}));
vi.mock("../StoryWorkspace", () => ({
	StoryWorkspace: () => <div data-testid="workspace">workspace</div>,
}));
vi.mock("@copilotkit/react-core", () => ({
	CopilotKit: ({ children }: { children: ReactNode }) => children,
}));
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
vi.mock("../StoryKindIcon", () => ({ StoryKindIcon: () => null }));
vi.mock("../StoryCommentsButton", () => ({ StoryCommentsButton: () => null }));
// Ambient org is DELIBERATELY null while the project's org is "org-1". A buggy
// impl that passed ambient `organizationId ?? null` would send null and fail
// the assertion; only reading `project.organizationId` passes.
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
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
			title: "Wiring test feature",
			kind: "STORY",
			priority: "MEDIUM",
			identifier: "F-1",
			createdById: "u1",
		}),
		getPriorityLabel: () => "Medium",
	};
});

// orpc stub: project carries organizationId "org-1"; members.list queryFn spies
// on its input so we can assert the org id the button passes through.
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
						name: "Proj",
						organizationId: "org-1",
					},
				}),
				members: {
					list: {
						queryOptions: (opts: { input: unknown }) => ({
							queryKey: ["members", opts.input],
							queryFn: async () => membersFn(opts.input),
						}),
					},
				},
				stories: {
					get: stub({
						story: { id: "s1" },
						canEdit: true,
						canAddTags: true,
						canManageAllTags: true,
					}),
					pmCapabilities: stub({ configured: false }),
					// useAiReassessEligibility (metadata-form sparkle) reads
					// the status list at render; empty = nothing is final.
					statuses: { list: stub({ statuses: [] }) },
					// New: the detail header's editable priority chip
					// (StoryPriorityControl) reads this at render.
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

beforeEach(() => {
	membersFn.mockReset().mockResolvedValue({
		members: [
			{ userId: "u1", user: { name: "Dave", email: "k@example.com" } },
		],
	});
	listAttachments.mockReset().mockResolvedValue({ attachments: [] });
});
afterEach(() => vi.clearAllMocks());

describe("StoryWorkspacePage — details/provenance wiring", () => {
	it("shows the Feature-details button and does not fetch members until opened", async () => {
		renderPage();
		expect(
			await screen.findByRole("button", { name: "Feature details" }),
		).toBeInTheDocument();
		expect(membersFn).not.toHaveBeenCalled();
	});

	it("opens the popover and fetches members with the project's org id (not ambient)", async () => {
		renderPage();
		fireEvent.click(
			await screen.findByRole("button", { name: "Feature details" }),
		);
		expect(await screen.findByTestId("provenance")).toBeInTheDocument();
		await waitFor(() =>
			expect(membersFn).toHaveBeenCalledWith({
				projectId: "p1",
				organizationId: "org-1",
			}),
		);
		expect(membersFn).toHaveBeenCalledTimes(1);
	});
});
