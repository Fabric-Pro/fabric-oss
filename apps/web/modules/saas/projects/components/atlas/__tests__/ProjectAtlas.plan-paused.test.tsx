/**
 * `<ProjectAtlas />` while the analysis run is paused for a ChatGPT plan
 * reset (Fizzy #2770): the plan-paused notice replaces the "Analyze" empty
 * state of a first run and sits over a re-run's READY graph; Cancel goes
 * through "Cancel analysis"; "Run now on API billing" resumes this paused
 * run, offered only to an admin, and anyone else is told to ask one.
 *
 * Heavy children are stubbed, as in the other ProjectAtlas suites.
 */
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { FocusModeProvider } from "@saas/shared/contexts/FocusModeContext";
import { SidebarCollapseProvider } from "@saas/shared/contexts/SidebarCollapseContext";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// What the page sent, and what this test's paused run looks like.
const calls = vi.hoisted(() => ({
	cancel: [] as unknown[],
	runNow: [] as unknown[],
	pausedRunInputs: [] as unknown[],
}));
const scenario = vi.hoisted(() => ({
	status: "WAITING_FOR_PLAN" as string,
	canRunOnApi: true,
	askAdminToRunOnApi: false,
}));

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
					queryFn: async () => ({
						...statusData,
						status: scenario.status,
						waitingForPlan: true,
						activeRun: null,
					}),
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
					mutationFn: async (input: unknown) => {
						calls.cancel.push(input);
						return statusData;
					},
					...opts,
				}),
			},
			pausedRun: {
				queryOptions: (opts: { input: unknown }) => ({
					queryKey: ["cu", "paused-run", opts.input],
					queryFn: async () => {
						calls.pausedRunInputs.push(opts.input);
						return {
							run: {
								id: "run-1",
								resumesAt: "2026-10-12T18:00:00.000Z",
								pauseCount: 1,
								canRunOnApi: scenario.canRunOnApi,
								askAdminToRunOnApi: scenario.askAdminToRunOnApi,
							},
						};
					},
				}),
			},
			runPausedOnApi: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async (input: unknown) => {
						calls.runNow.push(input);
						return { workflowId: "wf" };
					},
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

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "org-1" }),
}));

import { ProjectAtlas } from "../ProjectAtlas";

describe("ProjectAtlas — run paused for a ChatGPT plan reset", () => {
	let queryClient: QueryClient;

	beforeEach(() => {
		queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		calls.cancel.length = 0;
		calls.runNow.length = 0;
		calls.pausedRunInputs.length = 0;
		scenario.status = "WAITING_FOR_PLAN";
		scenario.canRunOnApi = true;
		scenario.askAdminToRunOnApi = false;
	});

	function Wrapper({ children }: PropsWithChildren) {
		return (
			<QueryClientProvider client={queryClient}>
				<FeatureFlagProvider value={{ PUBLISHING_SUITE: false }}>
					<SidebarCollapseProvider>
						<FocusModeProvider>{children}</FocusModeProvider>
					</SidebarCollapseProvider>
				</FeatureFlagProvider>
			</QueryClientProvider>
		);
	}

	it("shows the notice instead of the Analyze empty state for a first run", async () => {
		render(<ProjectAtlas projectId="p-1" />, { wrapper: Wrapper });

		expect(await screen.findByTestId("plan-paused-notice")).toBeVisible();
		expect(screen.queryByText("empty.analyzeCta")).not.toBeInTheDocument();
		await waitFor(() =>
			expect(calls.pausedRunInputs).toContainEqual({
				projectId: "p-1",
				organizationId: "org-1",
				analysisId: "analysis-1",
			}),
		);
	});

	it("Run now resumes this paused run, and Cancel cancels the analysis", async () => {
		const user = userEvent.setup();
		render(<ProjectAtlas projectId="p-1" />, { wrapper: Wrapper });

		await user.click(await screen.findByRole("button", { name: "runNow" }));
		await waitFor(() =>
			expect(calls.runNow).toEqual([
				{
					projectId: "p-1",
					organizationId: "org-1",
					analysisId: "analysis-1",
					runId: "run-1",
				},
			]),
		);

		await user.click(screen.getByRole("button", { name: "cancel" }));
		await waitFor(() =>
			expect(calls.cancel).toEqual([
				expect.objectContaining({
					projectId: "p-1",
					organizationId: "org-1",
				}),
			]),
		);
	});

	it("offers no Run now to a member who is not an admin, and says to ask one", async () => {
		scenario.canRunOnApi = false;
		scenario.askAdminToRunOnApi = true;
		render(<ProjectAtlas projectId="p-1" />, { wrapper: Wrapper });

		expect(await screen.findByText("askAdmin")).toBeVisible();
		expect(
			screen.queryByRole("button", { name: "runNow" }),
		).not.toBeInTheDocument();
	});

	it("sits over the READY graph of a paused re-run", async () => {
		scenario.status = "READY";
		render(<ProjectAtlas projectId="p-1" />, { wrapper: Wrapper });

		expect(await screen.findByTestId("plan-paused-notice")).toBeVisible();
		expect(screen.getByTestId("atlas-status-bar-stub")).toBeVisible();
	});
});
