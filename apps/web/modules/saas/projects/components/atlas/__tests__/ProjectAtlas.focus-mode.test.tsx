import { FocusModeProvider } from "@saas/shared/contexts/FocusModeContext";
import { SidebarCollapseProvider } from "@saas/shared/contexts/SidebarCollapseContext";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub heavy components
vi.mock("../AtlasGraph", () => ({
	AtlasGraph: () => <div data-testid="atlas-graph-stub" />,
}));
vi.mock("../AtlasChatPanel", () => ({
	AtlasChatPanel: () => <div data-testid="atlas-chat-panel-stub" />,
}));
vi.mock("../AtlasOverview", () => ({
	AtlasOverview: () => <div data-testid="atlas-overview-stub" />,
}));
vi.mock("../AtlasStatusBar", () => ({
	AtlasStatusBar: () => <div data-testid="atlas-status-bar-stub" />,
}));

const statusData = {
	analysisId: "analysis-1",
	status: "READY",
	repository: {
		repositoryIntegrationId: "integration-1",
		provider: "GITHUB",
		repositoryName: "acme/repo",
		repositoryUrl: "https://github.com/acme/repo",
		defaultBranch: "main",
		status: "ACTIVE",
		isDefault: true,
	},
	hasRepository: true,
	repositoryStatus: "ACTIVE",
	canReanalyze: true,
	analyzedCommitSha: "abc",
	analyzedShortSha: "abc1234",
	analyzedAt: new Date().toISOString(),
	analyzedCommitAt: new Date().toISOString(),
	branch: "main",
	newCommitCount: 0,
	commitsComparable: true,
	headSha: null,
	nodeCount: 1,
	edgeCount: 0,
	filesAnalyzed: 1,
	techStack: null,
	businessTour: null,
	error: null,
	inFlightSince: null,
};

const graphData = {
	mode: "BUSINESS",
	analysisId: "analysis-1",
	nodes: [
		{
			key: "node-1",
			kind: "CAPABILITY",
			label: "Node One",
			filePath: null,
			language: null,
			parentKey: null,
			description: null,
			metrics: null,
			layout: null,
		},
	],
	edges: [],
};

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		atlas: {
			listRepositories: {
				queryOptions: (opts: { input: unknown }) => ({
					queryKey: ["cu", "repos", opts.input],
					queryFn: async () => ({
						repositories: [statusData.repository],
					}),
				}),
			},
			status: {
				queryOptions: (opts: { input: unknown }) => ({
					queryKey: ["cu", "status", opts.input],
					queryFn: async () => statusData,
				}),
				queryKey: (opts: { input: unknown }) => [
					"cu",
					"status",
					opts.input,
				],
			},
			graph: {
				queryOptions: (opts: { input: unknown }) => ({
					queryKey: ["cu", "graph", opts.input],
					queryFn: async () => graphData,
				}),
				queryKey: () => ["cu", "graph"],
			},
			history: {
				key: () => ["cu", "history"],
			},
			analyze: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async () => statusData,
					...opts,
				}),
			},
			cancelAnalysis: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async () => statusData,
					...opts,
				}),
			},
			systemGraph: {
				queryOptions: (opts: { input: unknown }) => ({
					queryKey: ["cu", "system-graph", opts.input],
					queryFn: async () => ({
						mode: "BUSINESS",
						repos: [],
						nodes: [],
						edges: [],
						crossLink: {
							status: "PENDING",
							stale: false,
							edgeCount: 0,
						},
						layouts: [],
						unavailableRepos: [],
					}),
				}),
				key: () => ["cu", "system-graph"],
			},
			linkRepositories: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async () => ({
						status: "READY",
						stale: false,
						edgeCount: 0,
					}),
					...opts,
				}),
			},
			saveLayout: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async () => ({ ok: true }),
					...opts,
				}),
			},
			saveSystemLayout: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async () => ({ ok: true }),
					...opts,
				}),
			},
			createEdge: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async () => ({}),
					...opts,
				}),
			},
			updateEdge: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async () => ({}),
					...opts,
				}),
			},
			deleteEdge: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async () => ({}),
					...opts,
				}),
			},
			restoreEdge: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async () => ({}),
					...opts,
				}),
			},
			edgeHistory: {
				queryOptions: (opts: { input: unknown }) => ({
					queryKey: ["cu", "edge-history", opts.input],
					queryFn: async () => ({ history: [] }),
				}),
				queryKey: (opts: { input: unknown }) => [
					"cu",
					"edge-history",
					opts.input,
				],
			},
			remapSolo: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async () => ({
						referencesGenerated: 0,
						model: null,
						totalTokens: null,
						costMicroUsd: null,
					}),
					...opts,
				}),
			},
			remapSystem: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async () => ({
						status: "READY",
						stale: false,
						edgeCount: 0,
					}),
					...opts,
				}),
			},
			systemRemapHistory: {
				key: () => ["cu", "systemRemapHistory"],
			},
		},
	},
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "org-1" }),
}));

import { ProjectAtlas } from "../ProjectAtlas";

describe("Atlas Focus Mode Integration", () => {
	let queryClient: QueryClient;

	beforeEach(() => {
		queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
	});

	function Wrapper({ children }: PropsWithChildren) {
		return (
			<QueryClientProvider client={queryClient}>
				<SidebarCollapseProvider>
					<FocusModeProvider>{children}</FocusModeProvider>
				</SidebarCollapseProvider>
			</QueryClientProvider>
		);
	}

	it("renders FocusModeToggle button and hides AtlasChatPanel when activated", async () => {
		const user = userEvent.setup();
		render(<ProjectAtlas projectId="p-1" />, { wrapper: Wrapper });

		// Switch view to GRAPH
		const graphBtn = await screen.findByRole("button", {
			name: "view.graph",
		});
		await user.click(graphBtn);

		// Verify AtlasChatPanel is present initially
		const chatPanel = await screen.findByTestId("atlas-chat-panel-stub");
		expect(chatPanel).toBeInTheDocument();

		// Click Focus Mode toggle button
		const focusToggle = screen.getByRole("button", {
			name: "enterFocusMode",
		});
		await user.click(focusToggle);

		// AtlasChatPanel wrapper should now be hidden via CSS & aria-hidden to preserve streams
		const chatWrapper = screen
			.getByTestId("atlas-chat-panel-stub")
			.closest("[aria-hidden='true']");
		expect(chatWrapper).toHaveClass("hidden");

		// Click again to exit Focus Mode
		const exitToggle = screen.getByRole("button", {
			name: "exitFocusMode",
		});
		await user.click(exitToggle);
		expect(
			screen
				.getByTestId("atlas-chat-panel-stub")
				.closest("[aria-hidden='false']"),
		).not.toHaveClass("hidden");
	});
});
