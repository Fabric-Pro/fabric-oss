/**
 * Layout tests for `<ProjectAtlas />` (GRAPH view).
 *
 * Coverage:
 *   - The chat wrapper keeps its full-height classes unconditionally — node
 *     selection never shrinks the chat
 *   - The floating node panel mounts INSIDE the canvas container (docked over
 *     the graph), with the expected geometry/surface classes
 *   - Escape (from within the panel) closes it and returns focus to the
 *     canvas container; the ✕ close path does the same
 *   - Nothing overlays the canvas while no node is selected
 *
 * Heavy children (graph canvas, chat, node panel, status bar, overview) are
 * stubbed — this suite targets the orchestrator's layout contract only.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ----------------------------------------------------------------------------
// Mocks — defined BEFORE the component import per Vitest hoisting rules.
// ----------------------------------------------------------------------------

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
				key: () => ["cu", "graph"],
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
			// Editable-connections (edge override) procedures — referenced by the
			// edge panel / connections list the orchestrator now threads through.
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
			// Re-map relationships (regenerate AI connections; keep / fresh).
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
				queryOptions: (opts: { input: unknown }) => ({
					queryKey: ["cu", "system-remap-history", opts.input],
					queryFn: async () => ({ runs: [], total: 0 }),
				}),
				key: () => ["cu", "system-remap-history"],
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationSlug: null,
		basePath: "/app",
		loaded: true,
	}),
}));

// Heavy children stubbed — the suite asserts the orchestrator's layout only.
vi.mock("../AtlasGraph", () => ({
	AtlasGraph: ({ onSelectNode }: { onSelectNode: (key: string) => void }) => (
		<div data-testid="graph-stub">
			<button type="button" onClick={() => onSelectNode("node-1")}>
				select-node-1
			</button>
			<button type="button" onClick={() => onSelectNode("node-2")}>
				select-node-2
			</button>
		</div>
	),
}));

vi.mock("../AtlasNodePanel", () => ({
	AtlasNodePanel: ({
		nodeKey,
		onClose,
		onAskAi,
	}: {
		nodeKey: string;
		onClose: () => void;
		onAskAi: (nodeKey: string, nodeLabel: string) => void;
	}) => (
		<section data-testid="node-panel-stub">
			<span>{`node:${nodeKey}`}</span>
			<button type="button" onClick={onClose}>
				close-panel
			</button>
			<button type="button" onClick={() => onAskAi(nodeKey, "Node One")}>
				ask-ai
			</button>
		</section>
	),
}));

vi.mock("../AtlasChatPanel", () => ({
	AtlasChatPanel: ({
		seededPrompt,
	}: {
		seededPrompt: { value: string; nonce: number } | null;
	}) => (
		<div
			data-testid="chat-stub"
			data-seeded-prompt={seededPrompt?.value ?? ""}
		/>
	),
}));

vi.mock("../AtlasStatusBar", () => ({
	AtlasStatusBar: () => <div data-testid="status-bar-stub" />,
}));

vi.mock("../AtlasOverview", () => ({
	AtlasOverview: ({
		onOpenNode,
	}: {
		onOpenNode: (mode: string, key: string) => void;
	}) => (
		<div data-testid="overview-stub">
			<button
				type="button"
				onClick={() => onOpenNode("BUSINESS", "node-2")}
			>
				open-from-overview
			</button>
		</div>
	),
}));

vi.mock("../AtlasHistoryPanel", () => ({
	AtlasHistoryPanel: () => null,
}));

vi.mock("../AtlasModeToggle", () => ({
	AtlasModeToggle: () => null,
}));

// Import AFTER mocks so the component picks up the stubs.
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { ProjectAtlas } from "../ProjectAtlas";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function renderGraphView() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const user = userEvent.setup();
	const utils = render(
		<QueryClientProvider client={queryClient}>
			{/* Stands in for the `(saas)/app` layout: the Atlas header's
			    page-tour launcher reads a per-organization flag, and the hook
			    throws rather than defaulting when none is supplied. */}
			<FeatureFlagProvider value={{ PUBLISHING_SUITE: false }}>
				<ProjectAtlas projectId="proj-1" />
			</FeatureFlagProvider>
		</QueryClientProvider>,
	);
	// READY state lands on the Overview dashboard first.
	await screen.findByTestId("overview-stub");
	// Switch to the interactive graph.
	await user.click(screen.getByRole("button", { name: "view.graph" }));
	await screen.findByTestId("graph-stub");
	return { ...utils, queryClient, user };
}

function getCanvasContainer(): HTMLElement {
	const canvas = screen.getByTestId("graph-stub").parentElement;
	if (!canvas) {
		throw new Error("canvas container not found");
	}
	return canvas as HTMLElement;
}

function getChatWrapper(): HTMLElement {
	const wrapper = screen.getByTestId("chat-stub").parentElement;
	if (!wrapper) {
		throw new Error("chat wrapper not found");
	}
	return wrapper as HTMLElement;
}

beforeEach(() => {
	localStorage.clear();
});

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("ProjectAtlas — chat height is unconditional", () => {
	it("keeps the full-height chat wrapper classes before and after node selection", async () => {
		const { user } = await renderGraphView();

		const before = getChatWrapper().className;
		expect(before).toContain("h-[420px]");
		expect(before).toContain("lg:h-[680px]");

		await user.click(screen.getByRole("button", { name: "select-node-1" }));
		await screen.findByTestId("node-panel-stub");

		const after = getChatWrapper().className;
		expect(after).toBe(before);
		// The legacy shrunken heights must never come back.
		expect(after).not.toContain("h-[300px]");
		expect(after).not.toContain("h-[280px]");
	});
});

describe("ProjectAtlas — floating node panel", () => {
	it("renders no overlay while nothing is selected", async () => {
		await renderGraphView();

		expect(screen.queryByTestId("node-panel-stub")).toBeNull();
		// Only the graph stub lives inside the canvas container.
		expect(getCanvasContainer().children).toHaveLength(1);
	});

	it("mounts the panel INSIDE the canvas container, docked with the expected geometry", async () => {
		const { user } = await renderGraphView();

		await user.click(screen.getByRole("button", { name: "select-node-1" }));
		const panel = await screen.findByTestId("node-panel-stub");

		const canvas = getCanvasContainer();
		expect(canvas.contains(panel)).toBe(true);

		const wrapper = panel.parentElement as HTMLElement;
		expect(canvas.contains(wrapper)).toBe(true);
		for (const cls of [
			"absolute",
			"top-3",
			"bottom-3",
			"z-20",
			"lg:w-[22rem]",
			"lg:max-w-[calc(100%-1.5rem)]",
			"rounded-xl",
			"bg-background",
			"overflow-hidden",
		]) {
			expect(wrapper.className).toContain(cls);
		}
		// Warm opaque surface — explicitly no glassmorphism.
		expect(wrapper.className).not.toContain("backdrop-blur");
		// Entrance motion is gated behind motion-safe only.
		expect(wrapper.className).toContain("motion-safe:animate-in");
	});

	it("swaps the node in place when the selection changes (same wrapper element, no remount)", async () => {
		const { user } = await renderGraphView();

		await user.click(screen.getByRole("button", { name: "select-node-1" }));
		const panel = await screen.findByTestId("node-panel-stub");
		expect(panel).toHaveTextContent("node:node-1");
		const wrapperBefore = panel.parentElement;

		// Neighbour-style drill-down: selecting another node keeps the same
		// mounted wrapper — no close/reopen flicker.
		await user.click(screen.getByRole("button", { name: "select-node-2" }));
		const swapped = await screen.findByText("node:node-2");
		expect(swapped.closest("section")?.parentElement).toBe(wrapperBefore);
	});

	it("Ask-AI seeds the chat while the panel stays open", async () => {
		const { user } = await renderGraphView();

		await user.click(screen.getByRole("button", { name: "select-node-1" }));
		await screen.findByTestId("node-panel-stub");

		await user.click(screen.getByRole("button", { name: "ask-ai" }));

		// The chat received the seeded prompt and the panel did not close —
		// the chat sits beside the canvas, never occluded by the panel.
		expect(
			screen.getByTestId("chat-stub").getAttribute("data-seeded-prompt"),
		).toContain("Node One");
		expect(screen.getByTestId("node-panel-stub")).toBeInTheDocument();
	});

	it("Overview → open node lands on GRAPH with the floating panel open", async () => {
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});
		const user = userEvent.setup();
		render(
			<QueryClientProvider client={queryClient}>
				<FeatureFlagProvider value={{ PUBLISHING_SUITE: false }}>
					<ProjectAtlas projectId="proj-1" />
				</FeatureFlagProvider>
			</QueryClientProvider>,
		);
		await screen.findByTestId("overview-stub");

		await user.click(
			screen.getByRole("button", { name: "open-from-overview" }),
		);

		await screen.findByTestId("graph-stub");
		const panel = await screen.findByTestId("node-panel-stub");
		expect(panel).toHaveTextContent("node:node-2");
		expect(getCanvasContainer().contains(panel)).toBe(true);
	});
});

describe("ProjectAtlas — dismissal and focus return", () => {
	it("Escape from within the panel closes it and focuses the canvas container", async () => {
		const { user } = await renderGraphView();

		await user.click(screen.getByRole("button", { name: "select-node-1" }));
		await screen.findByTestId("node-panel-stub");

		const closeButton = screen.getByRole("button", {
			name: "close-panel",
		});
		closeButton.focus();
		fireEvent.keyDown(closeButton, { key: "Escape" });

		await waitFor(() => {
			expect(screen.queryByTestId("node-panel-stub")).toBeNull();
		});
		const canvas = getCanvasContainer();
		expect(canvas).toHaveAttribute("tabindex", "-1");
		expect(document.activeElement).toBe(canvas);
	});

	it("the panel's close control does the same by mouse", async () => {
		const { user } = await renderGraphView();

		await user.click(screen.getByRole("button", { name: "select-node-1" }));
		await screen.findByTestId("node-panel-stub");

		await user.click(screen.getByRole("button", { name: "close-panel" }));

		await waitFor(() => {
			expect(screen.queryByTestId("node-panel-stub")).toBeNull();
		});
		expect(document.activeElement).toBe(getCanvasContainer());
	});
});
